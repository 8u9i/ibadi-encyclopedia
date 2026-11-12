// Incremental library updates ("update packs").
//
// A pack is a small SQLite file holding everything needed to bring a library from one published
// version to the next: the full content of new or changed books (pages, headings, catalogue rows,
// per-book metadata, covers, root-dictionary entries) and the ids of removed books. Packs are made
// by comparing per-book fingerprints of the publisher's library with the fingerprints of the last
// published state, so only books that really changed are shipped.
//
// Applying a pack replaces each listed book as a whole inside one transaction: the library is
// either fully at the new version or untouched. Replacing a book is idempotent, so applying a pack
// to a library that already has some of its books (for example one synced from the original app)
// is safe.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './arabic.js';

export const PACK_SCHEMA = 1;
/** Catalogue columns of `book` (the rest are derived: page ranges, cover flag, normalised name). */
export const BOOK_COLS = ['id', 'name', 'cat', 'type', 'printed', 'main_author', 'authors', 'alpha', 'pdf_online', 'country'];
/** Tables whose rows belong to one book, with the column naming the book. */
export const BOOK_TABLES = [
  ['author_book', 'book_id'],
  ['book_card', 'book_id'],
  ['book_desc', 'book_id'],
  ['book_contrib', 'book_id'],
  ['book_series', 'book_id'],
  ['pdf_file', 'book_id'],
  ['pdf_map', 'book_id'],
  ['tafsir', 'book'],
];
/** Library-wide tables, shipped whole when they change. */
export const GLOBAL_TABLES = ['category', 'author'];

const quote = (p) => `'${String(p).replace(/'/g, "''")}'`;
const columns = (db, table, schema = 'main') => db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((c) => c.name);
const SEP = '\u0001';
const END = '\u0002';
const cell = (v) => (v === null || v === undefined ? '\u0000' : String(v));

export function installedVersion(db) {
  try {
    const r = db.prepare("SELECT value FROM info WHERE key = 'library_version'").get();
    return r ? Number(r.value) || 0 : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ fingerprints
/**
 * Fingerprints every book (text, headings, catalogue row and per-book metadata) and the global
 * tables. Reads the whole library once, sequentially.
 */
export function libraryState(db, onProgress = () => {}) {
  const ids = db.prepare('SELECT id FROM book ORDER BY id').all().map((r) => r.id);
  const parts = new Map(ids.map((id) => [id, []]));
  const add = (label, rows, bookOf, line) => {
    let cur = null;
    let h = null;
    const flush = () => {
      if (cur !== null && parts.has(cur)) parts.get(cur).push(label + ':' + h.digest('hex'));
    };
    for (const r of rows) {
      const b = bookOf(r);
      if (b !== cur) {
        flush();
        cur = b;
        h = createHash('sha256');
      }
      h.update(line(r));
    }
    flush();
  };

  onProgress('pages');
  // Page rowids are contiguous per book and ascend with the page id, so rowid order is book order.
  add('p', db.prepare('SELECT book, pid, part, num, body, foot FROM page ORDER BY rid').iterate(), (r) => r.book,
    (r) => cell(r.pid) + SEP + cell(r.part) + SEP + cell(r.num) + SEP + cell(r.body) + SEP + cell(r.foot) + END);
  onProgress('titles');
  add('t', db.prepare('SELECT book, tid, pid, parent, text FROM title ORDER BY book, tid').iterate(), (r) => r.book,
    (r) => cell(r.tid) + SEP + cell(r.pid) + SEP + cell(r.parent) + SEP + cell(r.text) + END);
  onProgress('metadata');
  add('b', db.prepare(`SELECT ${BOOK_COLS.join(', ')} FROM book ORDER BY id`).iterate(), (r) => r.id,
    (r) => BOOK_COLS.map((c) => cell(r[c])).join(SEP) + END);
  for (const [table, col] of BOOK_TABLES) {
    const cols = columns(db, table);
    if (!cols.length) continue;
    const order = [col, ...cols.filter((c) => c !== col)].join(', ');
    add(table, db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${order}`).iterate(), (r) => r[col],
      (r) => cols.map((c) => cell(r[c])).join(SEP) + END);
  }
  const books = {};
  for (const [id, p] of parts) books[id] = createHash('sha256').update(p.join('|')).digest('hex');

  const g = createHash('sha256');
  for (const table of GLOBAL_TABLES) {
    const cols = columns(db, table).filter((c) => c !== 'name_norm');
    g.update(table + END);
    for (const r of db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${cols.join(', ')}`).iterate()) {
      g.update(cols.map((c) => cell(r[c])).join(SEP) + END);
    }
  }
  return { books, global: g.digest('hex') };
}

/** What changed between a published state and the current one. */
export function diffStates(published, current) {
  const put = [];
  const del = [];
  for (const [id, h] of Object.entries(current.books)) if (published.books[id] !== h) put.push(Number(id));
  for (const id of Object.keys(published.books)) if (!(id in current.books)) del.push(Number(id));
  return { put: put.sort((a, b) => a - b), del: del.sort((a, b) => a - b), global: published.global !== current.global };
}

// ------------------------------------------------------------------ build
/**
 * Writes a pack for `put`/`del` from the library in `libDir` to `file` (an uncompressed SQLite file).
 */
export function buildPack(libDir, file, { version, put, del, global }) {
  fs.rmSync(file, { force: true });
  const p = new DatabaseSync(file);
  try {
    p.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;');
    p.exec(`ATTACH DATABASE ${quote(path.join(libDir, 'ibadi.db'))} AS l`);
    p.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE op (id INTEGER PRIMARY KEY, action TEXT NOT NULL);
    `);
    const meta = p.prepare('INSERT INTO meta VALUES (?, ?)');
    meta.run('schema', String(PACK_SCHEMA));
    meta.run('version', String(version));
    meta.run('created', new Date().toISOString());
    meta.run('global', global ? '1' : '0');
    const op = p.prepare('INSERT INTO op VALUES (?, ?)');
    p.exec('BEGIN');
    for (const id of put) op.run(id, 'put');
    for (const id of del) op.run(id, 'del');
    p.exec('COMMIT');
    const PUT = "(SELECT id FROM op WHERE action = 'put')";
    p.exec(`
      CREATE TABLE page AS SELECT book, pid, part, num, body, foot FROM l.page WHERE book IN ${PUT} ORDER BY book, pid;
      CREATE TABLE title AS SELECT book, tid, pid, parent, text FROM l.title WHERE book IN ${PUT} ORDER BY book, tid;
      CREATE TABLE book AS SELECT ${BOOK_COLS.join(', ')} FROM l.book WHERE id IN ${PUT};
    `);
    for (const [table, col] of BOOK_TABLES) {
      if (columns(p, table, 'l').length) p.exec(`CREATE TABLE ${table} AS SELECT * FROM l.${table} WHERE ${col} IN ${PUT}`);
    }
    if (global) for (const table of GLOBAL_TABLES) p.exec(`CREATE TABLE g_${table} AS SELECT * FROM l.${table}`);

    // Root-dictionary entries for every word of the shipped books (the receiving library ignores
    // the ones it already has).
    p.exec('CREATE TABLE word_root (word TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY (word, root)) WITHOUT ROWID');
    const words = new Set();
    for (const r of p.prepare('SELECT body, foot FROM page').iterate()) {
      for (const w of normalize((r.body || '') + ' ' + (r.foot || '')).match(/[\p{L}\p{N}]+/gu) || []) words.add(w);
    }
    const roots = p.prepare('SELECT root FROM l.word_root WHERE word = ?');
    const insRoot = p.prepare('INSERT OR IGNORE INTO word_root VALUES (?, ?)');
    p.exec('BEGIN');
    for (const w of words) for (const r of roots.all(w)) insRoot.run(w, r.root);
    p.exec('COMMIT');

    const coversFile = path.join(libDir, 'covers.db');
    if (fs.existsSync(coversFile)) {
      p.exec(`ATTACH DATABASE ${quote(coversFile)} AS c`);
      p.exec(`CREATE TABLE cover AS SELECT * FROM c.cover WHERE id IN ${PUT}`);
      p.exec('DETACH DATABASE c');
    }
    p.exec('DETACH DATABASE l');
    const count = (t) => p.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    return { pages: count('page'), titles: count('title'), roots: count('word_root'), covers: fs.existsSync(coversFile) ? count('cover') : 0 };
  } finally {
    p.close();
  }
}

// ------------------------------------------------------------------ apply
/** Removes a book's pages and headings, keeping the contentless full-text indexes consistent. */
export function removeBookContent(lib, id) {
  const delFts = lib.prepare("INSERT INTO page_fts (page_fts, rowid, body, foot) VALUES ('delete', ?, ?, ?)");
  for (const r of lib.prepare('SELECT rid, body, foot FROM page WHERE book = ?').iterate(id)) {
    delFts.run(r.rid, normalize(r.body), r.foot ? normalize(r.foot) : null);
  }
  lib.prepare('DELETE FROM page WHERE book = ?').run(id);
  const delT = lib.prepare("INSERT INTO title_fts (title_fts, rowid, text) VALUES ('delete', ?, ?)");
  for (const t of lib.prepare('SELECT id, text FROM title WHERE book = ?').iterate(id)) delT.run(t.id, normalize(t.text));
  lib.prepare('DELETE FROM title WHERE book = ?').run(id);
}

/** Reads a pack's header without applying it. */
export function readPackMeta(file) {
  const p = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = Object.fromEntries(p.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const ops = p.prepare('SELECT id, action FROM op ORDER BY id').all();
    return {
      schema: Number(meta.schema),
      version: Number(meta.version),
      global: meta.global === '1',
      put: ops.filter((o) => o.action === 'put').map((o) => o.id),
      del: ops.filter((o) => o.action === 'del').map((o) => o.id),
    };
  } finally {
    p.close();
  }
}

/**
 * Applies one pack to the library in `libDir`. Returns what changed, or null when the library is
 * already at (or past) the pack's version.
 */
export function applyPack(libDir, file, onProgress = () => {}) {
  const head = readPackMeta(file);
  if (head.schema !== PACK_SCHEMA) throw new Error(`صيغة التحديث غير مدعومة (${head.schema}). حدّث البرنامج.`);
  const lib = new DatabaseSync(path.join(libDir, 'ibadi.db'), { timeout: 15000 });
  const coversFile = path.join(libDir, 'covers.db');
  try {
    lib.exec('PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY;');
    if (installedVersion(lib) >= head.version) return null;
    const hadBooks = new Set(lib.prepare('SELECT id FROM book').all().map((r) => r.id));

    // Covers first, in their own database: an extra cover is harmless if the main step fails.
    let coverIds = new Set();
    if (fs.existsSync(coversFile)) {
      const c = new DatabaseSync(coversFile, { timeout: 15000 });
      try {
        c.exec(`ATTACH DATABASE ${quote(file)} AS u`);
        const hasPackCovers = columns(c, 'cover', 'u').length > 0;
        c.exec('BEGIN');
        const del = c.prepare('DELETE FROM cover WHERE id = ?');
        for (const id of head.del) del.run(id);
        if (hasPackCovers) c.exec('INSERT OR REPLACE INTO cover SELECT * FROM u.cover');
        c.exec('COMMIT');
        c.exec('DETACH DATABASE u');
        coverIds = new Set(c.prepare('SELECT id FROM cover').all().map((r) => r.id));
      } finally {
        c.close();
      }
    }

    lib.exec(`ATTACH DATABASE ${quote(file)} AS u`);
    lib.exec('BEGIN');
    try {
      const touched = [...new Set([...head.del, ...head.put])];
      let i = 0;
      for (const id of touched) {
        onProgress(`إزالة النسخة السابقة (${++i} من ${touched.length})`, i / touched.length / 3);
        removeBookContent(lib, id);
        lib.prepare('DELETE FROM book WHERE id = ?').run(id);
        for (const [table, col] of BOOK_TABLES) lib.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(id);
      }

      const insP = lib.prepare('INSERT INTO page (rid, book, pid, part, num, body, foot) VALUES (?,?,?,?,?,?,?)');
      const insF = lib.prepare('INSERT INTO page_fts (rowid, body, foot) VALUES (?,?,?)');
      const insT = lib.prepare('INSERT INTO title (book, tid, pid, parent, text) VALUES (?,?,?,?,?)');
      const insTF = lib.prepare('INSERT INTO title_fts (rowid, text) VALUES (?,?)');
      const pages = lib.prepare('SELECT pid, part, num, body, foot FROM u.page WHERE book = ? ORDER BY pid');
      const titles = lib.prepare('SELECT tid, pid, parent, text FROM u.title WHERE book = ? ORDER BY tid');
      let rid = lib.prepare('SELECT IFNULL(max(rid), 0) AS m FROM page').get().m;
      i = 0;
      for (const id of head.put) {
        onProgress(`إضافة الكتاب ${++i} من ${head.put.length}`, 1 / 3 + (i / head.put.length) / 2);
        for (const r of pages.iterate(id)) {
          insP.run(++rid, id, r.pid, r.part, r.num, r.body, r.foot);
          insF.run(rid, normalize(r.body || ''), r.foot ? normalize(r.foot) : null);
        }
        for (const t of titles.iterate(id)) {
          const res = insT.run(id, t.tid, t.pid, t.parent, t.text);
          insTF.run(Number(res.lastInsertRowid), normalize(t.text));
        }
      }

      onProgress('تحديث بيانات الفهرس', 0.85);
      const copy = (from, to) => {
        const target = columns(lib, to);
        const shared = columns(lib, from, 'u').filter((c) => target.includes(c));
        if (shared.length) lib.exec(`INSERT INTO ${to} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM u.${from}`);
      };
      copy('book', 'book');
      for (const [table] of BOOK_TABLES) if (columns(lib, table, 'u').length) copy(table, table);
      if (head.global) {
        for (const table of GLOBAL_TABLES) {
          if (!columns(lib, `g_${table}`, 'u').length) continue;
          lib.exec(`DELETE FROM ${table}`);
          copy(`g_${table}`, table);
        }
        const ua = lib.prepare('UPDATE author SET name_norm = ? WHERE id = ?');
        if (columns(lib, 'author').includes('name_norm')) for (const r of lib.prepare('SELECT id, name FROM author').all()) ua.run(normalize(r.name || ''), r.id);
      }
      lib.exec('INSERT OR IGNORE INTO word_root (word, root) SELECT word, root FROM u.word_root');

      const ranges = lib.prepare(
        'UPDATE book SET (pages, rid_from, rid_to, parts) = (SELECT count(*), min(rid), max(rid), count(DISTINCT part) FROM page WHERE page.book = book.id) WHERE id = ?',
      );
      const nn = lib.prepare('UPDATE book SET name_norm = ?, has_cover = ? WHERE id = ?');
      for (const r of lib.prepare(`SELECT id, name FROM book WHERE id IN (SELECT id FROM u.op WHERE action = 'put')`).all()) {
        ranges.run(r.id);
        nn.run(normalize(r.name || ''), coverIds.has(r.id) ? 1 : null, r.id);
      }
      lib.exec('DELETE FROM book WHERE rid_from IS NULL');

      const info = lib.prepare('INSERT OR REPLACE INTO info (key, value) VALUES (?, ?)');
      info.run('library_version', String(head.version));
      info.run('updated_at', new Date().toISOString());
      info.run('books', String(lib.prepare('SELECT count(*) AS n FROM book').get().n));
      info.run('pages', String(lib.prepare('SELECT count(*) AS n FROM page').get().n));
      lib.exec('COMMIT');
    } catch (e) {
      lib.exec('ROLLBACK');
      throw e;
    } finally {
      lib.exec('DETACH DATABASE u');
    }

    onProgress('ضغط الفهرس', 0.95);
    // Merging index segments only saves space; the update is complete without it.
    let mergeSkipped = null;
    try {
      lib.exec("INSERT INTO page_fts(page_fts, rank) VALUES('merge', 500); INSERT INTO title_fts(title_fts, rank) VALUES('merge', 500);");
    } catch (e) {
      mergeSkipped = String(e.message || e);
    }
    const nowBooks = new Set(lib.prepare('SELECT id FROM book').all().map((r) => r.id));
    return {
      version: head.version,
      added: head.put.filter((id) => !hadBooks.has(id) && nowBooks.has(id)),
      updated: head.put.filter((id) => hadBooks.has(id) && nowBooks.has(id)),
      removed: head.del.filter((id) => hadBooks.has(id)),
      mergeSkipped,
    };
  } finally {
    lib.close();
  }
}

/** Records the library version without changing content (used by the publisher after publishing). */
export function setInstalledVersion(libDir, version) {
  const lib = new DatabaseSync(path.join(libDir, 'ibadi.db'), { timeout: 15000 });
  try {
    lib.prepare("INSERT OR REPLACE INTO info (key, value) VALUES ('library_version', ?)").run(String(version));
  } finally {
    lib.close();
  }
}
