// Incremental sync from an installed copy of the original Ibadi Encyclopedia.
//
// The original app downloads new and updated books itself. It records what it holds on disk in
// master.db (book.major_ondisk / minor_ondisk) and stores page text in its Lucene index. This
// worker compares that with a snapshot kept in our library (table src_book), exports the text of
// only the new or changed books with the original's own Java runtime, and applies the
// differences to ibadi.db: pages, headings, full-text rows, root dictionary and metadata.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalize } from '../shared/arabic.js';

const { libraryPath, originalRoot, java, classPath, tmpDir, dryRun } = workerData;
const DB = path.join(originalRoot, 'database');
const post = (m) => parentPort.postMessage(m);
const progress = (phase, message, ratio = null) => post({ type: 'progress', phase, message, ratio });

function bookDbPath(id) {
  return path.join(DB, 'book', String(id % 1000).padStart(3, '0'), `${id}.db`);
}

async function* jsonl(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line);
}

function splitId(id) {
  const i = id.indexOf('-');
  return [Number(id.slice(0, i)), Number(id.slice(i + 1))];
}

// ------------------------------------------------------------------ diff
function diff(lib, master) {
  lib.exec(`CREATE TABLE IF NOT EXISTS src_book (id INTEGER PRIMARY KEY, major INTEGER, minor INTEGER)`);
  // A book is available in the original when it is visible and its text is on disk (major_ondisk > 0).
  const catalogue = master
    .prepare('SELECT book_id AS id, IFNULL(hidden, 0) AS hidden, IFNULL(major_ondisk, 0) AS ma, IFNULL(minor_ondisk, 0) AS mi FROM book')
    .all();
  const orig = new Map(catalogue.filter((b) => !b.hidden && b.ma > 0).map((b) => [b.id, b]));
  // Books we may drop: only those the original's catalogue no longer lists or has hidden. A book that
  // is listed but not downloaded (a "light" install) is kept, since we already hold its text.
  const listed = new Set(catalogue.filter((b) => !b.hidden).map((b) => b.id));
  const have = new Map(lib.prepare('SELECT id, pages FROM book').all().map((b) => [b.id, b]));
  const snap = new Map(lib.prepare('SELECT id, major, minor FROM src_book').all().map((s) => [s.id, s]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [id, b] of orig) {
    if (!have.has(id)) added.push(id);
    else if (snap.size) {
      const s = snap.get(id);
      if (!s || s.major !== b.ma || s.minor !== b.mi) updated.push(id);
    } else {
      // First sync of a library built before snapshots existed: a book is current when its page
      // count matches the original's per-book database.
      let pages = null;
      try {
        const bdb = new DatabaseSync(bookDbPath(id), { readOnly: true });
        pages = bdb.prepare('SELECT count(*) AS n FROM page').get().n;
        bdb.close();
      } catch {}
      if (pages !== have.get(id).pages) updated.push(id);
    }
  }
  for (const id of have.keys()) if (!listed.has(id)) removed.push(id);
  return { orig, added, updated, removed };
}

// ------------------------------------------------------------------ export text with the original's Java
function exportBooks(ids) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const idsFile = path.join(tmpDir, 'ids.txt');
  fs.writeFileSync(idsFile, ids.join('\n'));
  for (const idx of ['page', 'title']) {
    const out = path.join(tmpDir, `${idx}.jsonl`);
    fs.rmSync(out, { force: true });
    const r = spawnSync(java, ['-cp', classPath, 'LuceneExport', path.join(DB, 'store', idx), out, idsFile], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15 * 60 * 1000,
    });
    if (r.error) throw new Error(`تعذّر تشغيل Java: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`فشل استخراج النصوص (${idx}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  }
}

// ------------------------------------------------------------------ apply
function removeBookContent(lib, id) {
  const delFts = lib.prepare("INSERT INTO page_fts (page_fts, rowid, body, foot) VALUES ('delete', ?, ?, ?)");
  for (const r of lib.prepare('SELECT rid, body, foot FROM page WHERE book = ?').iterate(id)) {
    delFts.run(r.rid, normalize(r.body), r.foot ? normalize(r.foot) : null);
  }
  lib.prepare('DELETE FROM page WHERE book = ?').run(id);
  const delT = lib.prepare("INSERT INTO title_fts (title_fts, rowid, text) VALUES ('delete', ?, ?)");
  for (const t of lib.prepare('SELECT id, text FROM title WHERE book = ?').iterate(id)) delT.run(t.id, normalize(t.text));
  lib.prepare('DELETE FROM title WHERE book = ?').run(id);
}

async function insertBooks(lib, ids) {
  // Text from the export, keyed by book.
  const text = new Map();
  for await (const d of jsonl(path.join(tmpDir, 'page.jsonl'))) {
    const [book, pid] = splitId(d.id);
    if (!text.has(book)) text.set(book, new Map());
    text.get(book).set(pid, { body: d.body ?? '', foot: d.foot ?? null });
  }
  const titles = new Map();
  for await (const d of jsonl(path.join(tmpDir, 'title.jsonl'))) {
    const [book, tid] = splitId(d.id);
    if (!titles.has(book)) titles.set(book, new Map());
    titles.get(book).set(tid, (d.body ?? '').replace(/\s+/g, ' ').trim());
  }
  const insP = lib.prepare('INSERT INTO page (rid, book, pid, part, num, body, foot) VALUES (?,?,?,?,?,?,?)');
  const insF = lib.prepare('INSERT INTO page_fts (rowid, body, foot) VALUES (?,?,?)');
  const insT = lib.prepare('INSERT INTO title (book, tid, pid, parent, text) VALUES (?,?,?,?,?)');
  const insTF = lib.prepare('INSERT INTO title_fts (rowid, text) VALUES (?,?)');
  const words = new Set();
  let rid = lib.prepare('SELECT IFNULL(max(rid), 0) AS m FROM page').get().m;
  const done = [];
  let i = 0;
  for (const id of ids) {
    progress('apply', `إضافة الكتاب ${++i} من ${ids.length}`, i / ids.length);
    const pages = text.get(id) || new Map();
    let info = new Map();
    let tinfo = [];
    try {
      const bdb = new DatabaseSync(bookDbPath(id), { readOnly: true });
      info = new Map(bdb.prepare('SELECT id, part, page FROM page').all().map((r) => [r.id, r]));
      tinfo = bdb.prepare('SELECT id, page, parent FROM title ORDER BY id').all();
      bdb.close();
    } catch {}
    const pids = [...new Set([...info.keys(), ...pages.keys()])].sort((a, b) => a - b);
    if (!pids.length) continue; // nothing on disk for this book yet: it stays out until it arrives
    lib.exec('BEGIN');
    try {
      for (const pid of pids) {
        const t = pages.get(pid) || { body: '', foot: null };
        const pi = info.get(pid);
        rid++;
        insP.run(rid, id, pid, pi?.part ?? null, pi?.page ?? null, t.body, t.foot);
        const nb = normalize(t.body);
        const nf = t.foot ? normalize(t.foot) : null;
        insF.run(rid, nb, nf);
        for (const w of (nb + ' ' + (nf || '')).match(/[\p{L}\p{N}]+/gu) || []) words.add(w);
      }
      const tt = titles.get(id) || new Map();
      for (const t of tinfo) {
        const label = tt.get(t.id);
        if (!label) continue;
        const r = insT.run(id, t.id, t.page ?? null, t.parent ?? 0, label);
        insTF.run(Number(r.lastInsertRowid), normalize(label));
      }
      lib.exec('COMMIT');
      done.push(id);
    } catch (e) {
      lib.exec('ROLLBACK');
      throw e;
    }
  }
  return { done, words };
}

/** Adds root-dictionary entries for words that new books introduced. */
function extendRoots(lib, words) {
  if (!words.size) return 0;
  const known = lib.prepare('SELECT 1 FROM word_root WHERE word = ? LIMIT 1');
  const fresh = new Set([...words].filter((w) => !known.get(w)));
  if (!fresh.size) return 0;
  const s2path = path.join(DB, 'service', 'S2.db');
  if (!fs.existsSync(s2path)) return 0;
  progress('roots', 'تحديث معجم الجذور');
  const s2 = new DatabaseSync(s2path, { readOnly: true });
  const dec = new TextDecoder('windows-1256');
  const ins = lib.prepare('INSERT OR IGNORE INTO word_root VALUES (?,?)');
  let n = 0;
  lib.exec('BEGIN');
  for (const r of s2.prepare('SELECT token, root FROM roots').iterate()) {
    if (!r.token || !r.root) continue;
    const word = normalize(dec.decode(r.token));
    if (!fresh.has(word)) continue;
    for (const root of dec.decode(r.root).split(',')) {
      const rt = normalize(root.trim());
      if (rt) n += Number(ins.run(word, rt).changes);
    }
  }
  lib.exec('COMMIT');
  s2.close();
  return n;
}

/** Re-copies catalogue metadata from master.db and recomputes each book's page range. */
function refreshMetadata(lib) {
  progress('meta', 'تحديث بيانات الفهرس');
  const q = (p) => `'${p.replace(/'/g, "''")}'`;
  lib.exec(`ATTACH DATABASE ${q(path.join(DB, 'master.db'))} AS m`);
  const tf = path.join(DB, 'service', 'tafseer.db');
  const hasTafsir = fs.existsSync(tf);
  if (hasTafsir) lib.exec(`ATTACH DATABASE ${q(tf)} AS tf`);
  lib.exec('BEGIN');
  try {
    const covered = new Set(lib.prepare('SELECT id FROM book WHERE has_cover = 1').all().map((r) => r.id));
    lib.exec(`
      DELETE FROM category; INSERT INTO category SELECT category_id, category_name, category_order FROM m.category;
      DELETE FROM author; INSERT INTO author (id, name, death, death_text, death_kind, bio)
        SELECT a.author_id, a.author_name, a.death_number, a.death_text, a.death_kind,
               (SELECT biography FROM m.author_bio b WHERE b.author_id = a.author_id) FROM m.author a;
      DELETE FROM author_book; INSERT INTO author_book SELECT DISTINCT author_id, book_id FROM m.author_book;
      DELETE FROM book_card; INSERT INTO book_card SELECT book_id, clean_text FROM m.book_card;
      DELETE FROM book_desc; INSERT INTO book_desc SELECT book_id, IFNULL(text_fixed, text) FROM m.book_desc WHERE IFNULL(text_fixed, text) <> '';
      DELETE FROM book_contrib; INSERT INTO book_contrib
        SELECT r.book_id, r.author_id, IFNULL(r.person_name, a.author_name), t.label, t.rel_order
          FROM m.book_relation r LEFT JOIN m.relation_type t ON t.rel_id = r.rel_id LEFT JOIN m.author a ON a.author_id = r.author_id
         WHERE IFNULL(t.reader_visible, 1) = 1 AND IFNULL(r.person_name, a.author_name) IS NOT NULL;
      DELETE FROM book_series; INSERT INTO book_series SELECT book_id, series, number FROM m.book_series;
      DELETE FROM pdf_file; INSERT INTO pdf_file SELECT book_id, part, file_ord, account_id, url FROM m.pdf_file_src WHERE url LIKE 'https://%';
      DELETE FROM pdf_map; INSERT OR IGNORE INTO pdf_map SELECT book_id, reader_page, file_ord, pdf_leaf FROM m.book_pdf_map;
      DELETE FROM book;
      INSERT INTO book (id, name, cat, type, printed, main_author, authors, alpha, pdf_online, country)
        SELECT book_id, book_name, book_category, book_type, printed, main_author, authors, alpha, pdf_online, country
          FROM m.book WHERE IFNULL(hidden, 0) = 0 AND book_id IN (SELECT DISTINCT book FROM page);
      UPDATE book SET (pages, rid_from, rid_to, parts) =
        (SELECT count(*), min(rid), max(rid), count(DISTINCT part) FROM page WHERE page.book = book.id);
      DELETE FROM book WHERE rid_from IS NULL;
    `);
    const setCover = lib.prepare('UPDATE book SET has_cover = 1 WHERE id = ?');
    for (const id of covered) setCover.run(id);
    const ub = lib.prepare('UPDATE book SET name_norm = ? WHERE id = ?');
    for (const r of lib.prepare('SELECT id, name FROM book').all()) ub.run(normalize(r.name), r.id);
    const ua = lib.prepare('UPDATE author SET name_norm = ? WHERE id = ?');
    for (const r of lib.prepare('SELECT id, name FROM author').all()) ua.run(normalize(r.name), r.id);
    if (hasTafsir) lib.exec('DELETE FROM tafsir; INSERT INTO tafsir SELECT s.key_id, s.book_id, s.page_id FROM tf.service s JOIN book b ON b.id = s.book_id;');
    lib.exec('COMMIT');
  } catch (e) {
    lib.exec('ROLLBACK');
    throw e;
  } finally {
    if (hasTafsir) lib.exec('DETACH DATABASE tf');
    lib.exec('DETACH DATABASE m');
  }
}

// ------------------------------------------------------------------ main
async function run() {
  progress('diff', 'مقارنة الكتب مع البرنامج الأصلي');
  const master = new DatabaseSync(path.join(DB, 'master.db'), { readOnly: true, timeout: 10000 });
  const masterVer = (() => {
    try {
      return master.prepare('SELECT max(value) AS v FROM db_ver').get().v;
    } catch {
      return null;
    }
  })();
  const lib = new DatabaseSync(path.join(libraryPath, 'ibadi.db'), { timeout: 15000 });
  lib.exec('PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY;');
  const { orig, added, updated, removed } = diff(lib, master);
  master.close();
  const report = { added, updated, removed, masterVer };
  if (dryRun) {
    lib.close();
    return report;
  }

  const changed = [...added, ...updated];
  if (changed.length) {
    progress('export', `استخراج نصوص ${changed.length} كتاب`);
    exportBooks(changed);
  }
  for (const id of [...updated, ...removed]) {
    lib.exec('BEGIN');
    try {
      removeBookContent(lib, id);
      lib.exec('COMMIT');
    } catch (e) {
      lib.exec('ROLLBACK');
      throw e;
    }
  }
  const { done, words } = changed.length ? await insertBooks(lib, changed) : { done: [], words: new Set() };
  report.roots = extendRoots(lib, words);
  refreshMetadata(lib);

  // Snapshot of what is now in sync, so the next comparison is exact.
  lib.exec('BEGIN');
  const doneSet = new Set(done);
  const upsert = lib.prepare('INSERT OR REPLACE INTO src_book (id, major, minor) VALUES (?,?,?)');
  for (const [id, b] of orig) if (!changed.includes(id) || doneSet.has(id)) upsert.run(id, b.ma, b.mi);
  for (const id of removed) lib.prepare('DELETE FROM src_book WHERE id = ?').run(id);
  const info = lib.prepare('INSERT OR REPLACE INTO info (key, value) VALUES (?,?)');
  info.run('synced_at', new Date().toISOString());
  if (masterVer != null) info.run('source_master_ver', String(masterVer));
  info.run('books', String(lib.prepare('SELECT count(*) AS n FROM book').get().n));
  info.run('pages', String(lib.prepare('SELECT count(*) AS n FROM page').get().n));
  lib.exec('COMMIT');
  if (changed.length) {
    // Incremental segment merge keeps the full-text index compact; it is an optimisation only.
    progress('optimize', 'ضغط الفهرس');
    try {
      lib.exec("INSERT INTO page_fts(page_fts, rank) VALUES('merge', 500); INSERT INTO title_fts(title_fts, rank) VALUES('merge', 500);");
    } catch (e) {
      report.mergeSkipped = String(e.message || e);
    }
  }
  lib.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  report.added = added.filter((id) => doneSet.has(id));
  report.updated = updated.filter((id) => doneSet.has(id));
  report.pending = changed.filter((id) => !doneSet.has(id));
  report.coverIds = [...report.added, ...report.updated];
  return report;
}

run()
  .then((report) => post({ type: 'done', report }))
  .catch((e) => post({ type: 'error', message: String(e?.message || e) }));
