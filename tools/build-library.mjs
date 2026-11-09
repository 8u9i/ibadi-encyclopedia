// Builds the portable library used by the app from the original Ibadi Encyclopedia data.
//
//   electron tools/build-library.mjs --src <original>/database --export <jsonl dir> --out <library dir>
//
// Inputs:  master.db, book/NNN/<id>.db, service/S2.db, service/tafseer.db, cover.db (original data)
//          page/title/aya .jsonl exported from the original Lucene indexes (tools/lucene/LuceneExport.java)
// Outputs: <out>/ibadi.db   metadata, page text, TOC, Quran, root dictionary and FTS5 indexes
//          <out>/covers.db  cover thumbnails and resized full covers
//
// Runs as an Electron app (not ELECTRON_RUN_AS_NODE) so nativeImage is available for cover resizing.

import { app, nativeImage } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalize } from '../src/shared/arabic.js';
import { SURA_AYAT } from '../src/shared/quran.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ['src', 'export', 'out']) {
  if (!args[k]) {
    console.error('missing --' + k);
    process.exit(2);
  }
}
const SRC = path.resolve(args.src);
const EXP = path.resolve(args.export);
const OUT = path.resolve(args.out);
const SKIP_COVERS = 'skip-covers' in args;

const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...m);

async function* jsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line);
}

function splitId(id) {
  const i = id.indexOf('-');
  return [Number(id.slice(0, i)), Number(id.slice(i + 1))];
}

function bookDbPath(id) {
  return path.join(SRC, 'book', String(id % 1000).padStart(3, '0'), `${id}.db`);
}

function batched(db, fn) {
  db.exec('BEGIN');
  let n = 0;
  return {
    tick() {
      if (++n % 20000 === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN');
      }
    },
    end() {
      db.exec('COMMIT');
      return n;
    },
    fn,
  };
}

async function buildMain() {
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, 'ibadi.db');
  const tmp = target + '.building';
  const rawPath = path.join(OUT, 'raw.tmp.db');
  for (const f of [tmp, rawPath, tmp + '-journal', rawPath + '-journal']) fs.rmSync(f, { force: true });

  const db = new DatabaseSync(tmp);
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-524288; PRAGMA temp_store=MEMORY;`);
  db.exec(`ATTACH DATABASE '${path.join(SRC, 'master.db').replace(/'/g, "''")}' AS m`);

  // ---------------------------------------------------------------- metadata
  log('metadata');
  db.exec(`
    CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE category AS SELECT category_id AS id, category_name AS name, category_order AS ord FROM m.category;
    CREATE TABLE author AS SELECT a.author_id AS id, a.author_name AS name, a.death_number AS death, a.death_text,
           a.death_kind, (SELECT biography FROM m.author_bio b WHERE b.author_id = a.author_id) AS bio
      FROM m.author a;
    CREATE TABLE book AS SELECT book_id AS id, book_name AS name, book_category AS cat, book_type AS type,
           printed, main_author, authors, alpha, pdf_online, country, NULL AS pages, NULL AS rid_from, NULL AS rid_to,
           NULL AS parts, NULL AS has_cover
      FROM m.book WHERE IFNULL(hidden, 0) = 0;
    CREATE TABLE author_book AS SELECT DISTINCT author_id, book_id FROM m.author_book;
    CREATE TABLE book_card AS SELECT book_id, clean_text AS text FROM m.book_card;
    CREATE TABLE book_desc AS SELECT book_id, IFNULL(text_fixed, text) AS text FROM m.book_desc WHERE IFNULL(text_fixed, text) <> '';
    CREATE TABLE book_contrib AS
      SELECT r.book_id, r.author_id, IFNULL(r.person_name, a.author_name) AS name, t.label AS role, t.rel_order AS ord
        FROM m.book_relation r
        LEFT JOIN m.relation_type t ON t.rel_id = r.rel_id
        LEFT JOIN m.author a ON a.author_id = r.author_id
       WHERE IFNULL(t.reader_visible, 1) = 1 AND IFNULL(r.person_name, a.author_name) IS NOT NULL;
    CREATE TABLE book_series AS SELECT book_id, series, number FROM m.book_series;
    CREATE TABLE pdf_file AS SELECT book_id, part, file_ord, account_id, url FROM m.pdf_file_src WHERE url LIKE 'https://%';
    CREATE TABLE pdf_map AS SELECT book_id, reader_page, file_ord, pdf_leaf FROM m.book_pdf_map;
    CREATE INDEX ix_book_cat ON book(cat);
    CREATE INDEX ix_ab_author ON author_book(author_id);
    CREATE INDEX ix_ab_book ON author_book(book_id);
    CREATE INDEX ix_card ON book_card(book_id);
    CREATE INDEX ix_desc ON book_desc(book_id);
    CREATE INDEX ix_contrib ON book_contrib(book_id);
    CREATE INDEX ix_contrib_a ON book_contrib(author_id);
    CREATE INDEX ix_series ON book_series(book_id);
    CREATE INDEX ix_pdf_file ON pdf_file(book_id, file_ord);
    CREATE UNIQUE INDEX ix_pdf_map ON pdf_map(book_id, reader_page);
  `);
  // Per-book versions as held on disk by the original app; sync compares against this snapshot.
  db.exec(`CREATE TABLE src_book (id INTEGER PRIMARY KEY, major INTEGER, minor INTEGER);
           INSERT INTO src_book SELECT book_id, IFNULL(major_ondisk, 0), IFNULL(minor_ondisk, 0)
             FROM m.book WHERE IFNULL(hidden, 0) = 0 AND IFNULL(major_ondisk, 0) > 0;`);
  const bookIds = db.prepare('SELECT id FROM book ORDER BY id').all().map((r) => r.id);
  log(`books: ${bookIds.length}`);

  // ---------------------------------------------------------------- raw text from Lucene export
  log('loading page text');
  db.exec(`ATTACH DATABASE '${rawPath.replace(/'/g, "''")}' AS raw`);
  db.exec(`PRAGMA raw.journal_mode=OFF; PRAGMA raw.synchronous=OFF;
           CREATE TABLE raw.ptext (book INTEGER, pid INTEGER, body TEXT, foot TEXT, PRIMARY KEY(book, pid)) WITHOUT ROWID;
           CREATE TABLE raw.pinfo (book INTEGER, pid INTEGER, part TEXT, num INTEGER, PRIMARY KEY(book, pid)) WITHOUT ROWID;
           CREATE TABLE raw.tinfo (book INTEGER, tid INTEGER, pid INTEGER, parent INTEGER, PRIMARY KEY(book, tid)) WITHOUT ROWID;
           CREATE TABLE raw.ttext (book INTEGER, tid INTEGER, text TEXT, PRIMARY KEY(book, tid)) WITHOUT ROWID;`);
  {
    const ins = db.prepare('INSERT OR REPLACE INTO raw.ptext VALUES (?,?,?,?)');
    const b = batched(db);
    for await (const d of jsonl(path.join(EXP, 'page.jsonl'))) {
      const [book, pid] = splitId(d.id);
      ins.run(book, pid, d.body ?? '', d.foot ?? null);
      b.tick();
    }
    log(`page texts: ${b.end()}`);
  }
  {
    const ins = db.prepare('INSERT OR REPLACE INTO raw.ttext VALUES (?,?,?)');
    const b = batched(db);
    for await (const d of jsonl(path.join(EXP, 'title.jsonl'))) {
      const [book, tid] = splitId(d.id);
      ins.run(book, tid, (d.body ?? '').replace(/\s+/g, ' ').trim());
      b.tick();
    }
    log(`title texts: ${b.end()}`);
  }

  // ---------------------------------------------------------------- per-book structure
  log('reading per-book databases');
  {
    const insP = db.prepare('INSERT OR REPLACE INTO raw.pinfo VALUES (?,?,?,?)');
    const insT = db.prepare('INSERT OR REPLACE INTO raw.tinfo VALUES (?,?,?,?)');
    db.exec('BEGIN');
    let missing = 0;
    for (const id of bookIds) {
      const p = bookDbPath(id);
      if (!fs.existsSync(p)) {
        missing++;
        continue;
      }
      const bdb = new DatabaseSync(p, { readOnly: true });
      for (const r of bdb.prepare('SELECT id, part, page FROM page').iterate()) insP.run(id, r.id, r.part ?? null, r.page ?? null);
      for (const r of bdb.prepare('SELECT id, page, parent FROM title').iterate()) insT.run(id, r.id, r.page ?? null, r.parent ?? 0);
      bdb.close();
    }
    db.exec('COMMIT');
    log(`book dbs read, missing: ${missing}`);
  }

  // ---------------------------------------------------------------- pages (contiguous rowids per book)
  log('writing pages');
  db.exec(`
    CREATE TABLE page (rid INTEGER PRIMARY KEY, book INTEGER NOT NULL, pid INTEGER NOT NULL, part TEXT, num INTEGER,
                       body TEXT, foot TEXT);
    INSERT INTO page (rid, book, pid, part, num, body, foot)
      SELECT row_number() OVER (ORDER BY k.book, k.pid), k.book, k.pid, i.part, i.num, IFNULL(t.body, ''), t.foot
        FROM (SELECT book, pid FROM raw.pinfo UNION SELECT book, pid FROM raw.ptext) k
        JOIN book b ON b.id = k.book
        LEFT JOIN raw.pinfo i ON i.book = k.book AND i.pid = k.pid
        LEFT JOIN raw.ptext t ON t.book = k.book AND t.pid = k.pid
       ORDER BY k.book, k.pid;
    CREATE UNIQUE INDEX ix_page_book ON page(book, pid);
    CREATE INDEX ix_page_num ON page(book, part, num);
    UPDATE book SET (pages, rid_from, rid_to, parts) =
      (SELECT count(*), min(rid), max(rid), count(DISTINCT part) FROM page WHERE page.book = book.id);
  `);
  log(`pages: ${db.prepare('SELECT count(*) n FROM page').get().n}`);

  // ---------------------------------------------------------------- titles
  log('writing titles');
  db.exec(`
    CREATE TABLE title (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tid INTEGER NOT NULL, pid INTEGER,
                        parent INTEGER, text TEXT NOT NULL);
    INSERT INTO title (book, tid, pid, parent, text)
      SELECT i.book, i.tid, i.pid, i.parent, t.text
        FROM raw.tinfo i JOIN raw.ttext t ON t.book = i.book AND t.tid = i.tid
        JOIN book b ON b.id = i.book
       WHERE t.text <> ''
       ORDER BY i.book, i.tid;
    CREATE INDEX ix_title_book ON title(book, tid);
    CREATE INDEX ix_title_page ON title(book, pid);
  `);
  log(`titles: ${db.prepare('SELECT count(*) n FROM title').get().n}`);
  db.exec('DETACH DATABASE raw');
  fs.rmSync(rawPath, { force: true });

  // ---------------------------------------------------------------- full-text indexes (contentless, normalised)
  log('indexing pages (FTS5)');
  db.exec(`CREATE VIRTUAL TABLE page_fts USING fts5(body, foot, content='',
             tokenize="unicode61 remove_diacritics 2");`);
  {
    const ins = db.prepare('INSERT INTO page_fts (rowid, body, foot) VALUES (?,?,?)');
    const b = batched(db);
    for (const r of db.prepare('SELECT rid, body, foot FROM page ORDER BY rid').iterate()) {
      ins.run(r.rid, normalize(r.body), r.foot ? normalize(r.foot) : null);
      b.tick();
    }
    log(`indexed pages: ${b.end()}`);
  }
  db.exec(`CREATE VIRTUAL TABLE title_fts USING fts5(text, content='', tokenize="unicode61 remove_diacritics 2");`);
  {
    const ins = db.prepare('INSERT INTO title_fts (rowid, text) VALUES (?,?)');
    const b = batched(db);
    for (const r of db.prepare('SELECT id, text FROM title').iterate()) {
      ins.run(r.id, normalize(r.text));
      b.tick();
    }
    log(`indexed titles: ${b.end()}`);
  }
  db.exec(`ALTER TABLE book ADD COLUMN name_norm TEXT; ALTER TABLE author ADD COLUMN name_norm TEXT;`);
  {
    const ub = db.prepare('UPDATE book SET name_norm = ? WHERE id = ?');
    const ua = db.prepare('UPDATE author SET name_norm = ? WHERE id = ?');
    db.exec('BEGIN');
    for (const r of db.prepare('SELECT id, name FROM book').all()) ub.run(normalize(r.name), r.id);
    for (const r of db.prepare('SELECT id, name FROM author').all()) ua.run(normalize(r.name), r.id);
    db.exec('COMMIT');
  }

  // ---------------------------------------------------------------- Quran
  log('Quran');
  db.exec(`CREATE TABLE aya (id INTEGER PRIMARY KEY, sura INTEGER, num INTEGER, text TEXT, uthmani TEXT);
           CREATE INDEX ix_aya_sura ON aya(sura, num);
           CREATE VIRTUAL TABLE aya_fts USING fts5(text, content='', tokenize="unicode61 remove_diacritics 2");`);
  {
    const starts = [];
    let acc = 0;
    for (const n of SURA_AYAT) {
      starts.push(acc);
      acc += n;
    }
    const ins = db.prepare('INSERT INTO aya VALUES (?,?,?,?,?)');
    const insF = db.prepare('INSERT INTO aya_fts (rowid, text) VALUES (?,?)');
    db.exec('BEGIN');
    let n = 0;
    for await (const d of jsonl(path.join(EXP, 'aya.jsonl'))) {
      const id = Number(d.id);
      let s = 0;
      while (s + 1 < starts.length && starts[s + 1] < id) s++;
      ins.run(id, s + 1, id - starts[s], d.body, d.amiri || d.majma || d.body);
      insF.run(id, normalize(d.body));
      n++;
    }
    db.exec('COMMIT');
    log(`ayat: ${n} (expected ${acc})`);
  }
  db.exec(`ATTACH DATABASE '${path.join(SRC, 'service', 'tafseer.db').replace(/'/g, "''")}' AS tf;
           CREATE TABLE tafsir AS SELECT s.key_id AS aya, s.book_id AS book, s.page_id AS pid
             FROM tf.service s JOIN book b ON b.id = s.book_id;
           CREATE INDEX ix_tafsir ON tafsir(aya);
           DETACH DATABASE tf;`);

  // ---------------------------------------------------------------- root dictionary (limited to words in the corpus)
  log('root dictionary');
  db.exec(`CREATE VIRTUAL TABLE temp.vocab USING fts5vocab(main, page_fts, 'row');`);
  const vocab = new Set();
  for (const r of db.prepare('SELECT term FROM temp.vocab').iterate()) vocab.add(r.term);
  log(`corpus vocabulary: ${vocab.size}`);
  db.exec(`CREATE TABLE word_root (word TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY(word, root)) WITHOUT ROWID;`);
  {
    const s2 = new DatabaseSync(path.join(SRC, 'service', 'S2.db'), { readOnly: true });
    const dec = new TextDecoder('windows-1256');
    const ins = db.prepare('INSERT OR IGNORE INTO word_root VALUES (?,?)');
    const b = batched(db);
    for (const r of s2.prepare('SELECT token, root FROM roots').iterate()) {
      if (!r.token || !r.root) continue;
      const word = normalize(dec.decode(r.token));
      if (!vocab.has(word)) continue;
      for (const root of dec.decode(r.root).split(',')) {
        const rt = normalize(root.trim());
        if (rt) {
          ins.run(word, rt);
          b.tick();
        }
      }
    }
    log(`word→root pairs: ${b.end()}`);
    s2.close();
  }
  db.exec(`CREATE INDEX ix_root ON word_root(root);`);
  vocab.clear();

  // ---------------------------------------------------------------- finish
  log('optimizing FTS');
  db.exec(`INSERT INTO page_fts(page_fts) VALUES('optimize');
           INSERT INTO title_fts(title_fts) VALUES('optimize');
           INSERT INTO aya_fts(aya_fts) VALUES('optimize');`);
  let install = {};
  try {
    install = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'app', 'install.json'), 'utf8'));
  } catch {}
  const info = db.prepare('INSERT OR REPLACE INTO info VALUES (?,?)');
  info.run('schema', '1');
  info.run('built_at', new Date().toISOString());
  info.run('source_label', String(install.label ?? ''));
  info.run('source_built_at', String(install.built_at ?? ''));
  info.run('books', String(bookIds.length));
  info.run('pages', String(db.prepare('SELECT count(*) n FROM page').get().n));
  db.exec('DETACH DATABASE m; PRAGMA journal_mode=DELETE; ANALYZE;');
  db.close();
  fs.rmSync(target, { force: true });
  fs.renameSync(tmp, target);
  log(`ibadi.db: ${(fs.statSync(target).size / 1e9).toFixed(2)} GB`);
}

function buildCovers() {
  log('covers');
  const target = path.join(OUT, 'covers.db');
  const tmp = target + '.building';
  fs.rmSync(tmp, { force: true });
  const src = new DatabaseSync(path.join(SRC, 'cover.db'), { readOnly: true });
  const db = new DatabaseSync(tmp);
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
           CREATE TABLE cover (id INTEGER PRIMARY KEY, thumb BLOB NOT NULL, full BLOB NOT NULL, w INTEGER, h INTEGER);`);
  const ins = db.prepare('INSERT INTO cover VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  let n = 0;
  let bad = 0;
  for (const r of src.prepare('SELECT id, cover FROM cover').iterate()) {
    const img = nativeImage.createFromBuffer(Buffer.from(r.cover));
    if (img.isEmpty()) {
      bad++;
      continue;
    }
    const { width, height } = img.getSize();
    const thumb = img.resize({ width: 240, quality: 'better' }).toJPEG(80);
    const full = height > 1400 ? img.resize({ height: 1400, quality: 'best' }).toJPEG(84) : Buffer.from(r.cover);
    ins.run(r.id, thumb, full, width, height);
    if (++n % 200 === 0) log(`  covers ${n}`);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA journal_mode=DELETE');
  db.close();
  src.close();
  fs.rmSync(target, { force: true });
  fs.renameSync(tmp, target);
  log(`covers: ${n}, unreadable: ${bad}, covers.db: ${(fs.statSync(target).size / 1e6).toFixed(0)} MB`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    await buildMain();
    if (!SKIP_COVERS) buildCovers();
    // mark books that have covers so the UI does not request missing images
    const db = new DatabaseSync(path.join(OUT, 'ibadi.db'));
    if (fs.existsSync(path.join(OUT, 'covers.db'))) {
      db.exec(`ATTACH DATABASE '${path.join(OUT, 'covers.db').replace(/'/g, "''")}' AS c;
               UPDATE book SET has_cover = EXISTS (SELECT 1 FROM c.cover WHERE c.cover.id = book.id);
               DETACH DATABASE c;`);
    }
    db.close();
    log('done');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
