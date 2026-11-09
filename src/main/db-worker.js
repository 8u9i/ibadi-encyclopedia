// Database worker: every SQLite query runs here so the main process and UI never block.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { normalize, tokenize, expandWord, highlightRegex, highlightWords, phraseRegex } from '../shared/arabic.js';

const { libraryPath, userDbPath } = workerData;

// ------------------------------------------------------------------ open databases
let db;
let covers = null;
let user;

function openAll() {
  db = new DatabaseSync(path.join(libraryPath, 'ibadi.db'), { readOnly: true });
  db.exec('PRAGMA cache_size = -16000; PRAGMA temp_store = MEMORY; PRAGMA query_only = 1;');
  const cpath = path.join(libraryPath, 'covers.db');
  if (fs.existsSync(cpath)) {
    covers = new DatabaseSync(cpath, { readOnly: true });
    covers.exec('PRAGMA cache_size = -2000;');
  }
  fs.mkdirSync(path.dirname(userDbPath), { recursive: true });
  user = new DatabaseSync(userDbPath);
  user.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -2000;
    CREATE TABLE IF NOT EXISTS bookmark (id INTEGER PRIMARY KEY, book INTEGER NOT NULL, pid INTEGER NOT NULL,
      label TEXT, note TEXT, color TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_bm_book ON bookmark(book, pid);
    CREATE TABLE IF NOT EXISTS history (book INTEGER PRIMARY KEY, pid INTEGER, opened INTEGER NOT NULL, count INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS favorite (book INTEGER PRIMARY KEY, added INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS search_history (q TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
}

// Prepared statement cache.
const stmts = new Map();
function q(sql, on = db) {
  const key = (on === user ? 'u:' : on === covers ? 'c:' : 'd:') + sql;
  let s = stmts.get(key);
  if (!s) {
    s = on.prepare(sql);
    stmts.set(key, s);
  }
  return s;
}

// ------------------------------------------------------------------ helpers
const bookNames = new Map();
function bookName(id) {
  if (!bookNames.size) for (const r of db.prepare('SELECT id, name FROM book').iterate()) bookNames.set(r.id, r.name);
  return bookNames.get(id) || '';
}

const ftsQuote = (w) => '"' + w.replace(/"/g, '""') + '"';
function ftsTerm(w) {
  return w.endsWith('*') ? ftsQuote(w.slice(0, -1)) + '*' : ftsQuote(w);
}

function rootForms(word) {
  const roots = q('SELECT root FROM word_root WHERE word = ?').all(word).map((r) => r.root);
  if (!roots.length && q('SELECT 1 FROM word_root WHERE root = ? LIMIT 1').get(word)) roots.push(word);
  if (!roots.length) return { roots: [], forms: [] };
  const forms = q(
    `SELECT DISTINCT word FROM word_root WHERE root IN (SELECT value FROM json_each(?)) LIMIT 600`,
  ).all(JSON.stringify(roots)).map((r) => r.word);
  return { roots, forms };
}

/**
 * Builds an FTS5 MATCH expression.
 * mode: all | any | phrase | root ; flexible: also match proclitic forms (و، ف، ب، ك، ل، ال …)
 */
function buildMatch(text, { mode = 'all', flexible = true, foot = true, column = null } = {}) {
  const words = tokenize(text).slice(0, 24);
  if (!words.length) return null;
  let expr;
  let hl = words.map((w) => w.replace(/\*$/, ''));
  let roots = null;
  if (mode === 'phrase') {
    expr = ftsQuote(words.map((w) => w.replace(/\*$/, '')).join(' '));
    flexible = false;
  } else if (mode === 'root') {
    roots = [];
    const groups = words.map((w) => {
      const r = rootForms(w.replace(/\*$/, ''));
      roots.push({ word: w, roots: r.roots, count: r.forms.length });
      if (!r.forms.length) return '(' + expandWord(w).map(ftsTerm).join(' OR ') + ')';
      hl.push(...r.forms);
      return '(' + r.forms.map(ftsTerm).join(' OR ') + ')';
    });
    expr = groups.join(' AND ');
    flexible = false;
  } else {
    const groups = words.map((w) => {
      const forms = flexible ? expandWord(w) : [w];
      return forms.length > 1 ? '(' + forms.map(ftsTerm).join(' OR ') + ')' : ftsTerm(forms[0]);
    });
    expr = groups.join(mode === 'any' ? ' OR ' : ' AND ');
  }
  if (column) expr = `{${column}} : (${expr})`;
  else if (!foot) expr = `{body} : (${expr})`;
  return { expr, hlWords: flexible ? highlightWords(hl) : hl, flexible, roots, phrase: mode === 'phrase' };
}

const MARKUP = /<span id="aya-\d+">|<\/span>/g;

/** Returns a short excerpt around the first match as [[text, isMatch], …]. */
function snippet(text, re, len = 260) {
  if (!text) return null;
  const clean = text.replace(MARKUP, '').replace(/¬/g, '').replace(/\s+/g, ' ').trim();
  let start = 0;
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(clean);
    if (!m) return null;
    start = Math.max(0, m.index - 90);
    if (start > 0) {
      const sp = clean.indexOf(' ', start);
      if (sp !== -1 && sp < m.index) start = sp + 1;
    }
  }
  let end = Math.min(clean.length, start + len);
  if (end < clean.length) {
    const sp = clean.lastIndexOf(' ', end);
    if (sp > start + len * 0.7) end = sp;
  }
  const sub = clean.slice(start, end);
  const parts = [];
  if (re) {
    re.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = re.exec(sub))) {
      if (m.index > last) parts.push([sub.slice(last, m.index), 0]);
      parts.push([m[0], 1]);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < sub.length) parts.push([sub.slice(last), 0]);
  } else parts.push([sub, 0]);
  return { parts, before: start > 0, after: end < clean.length };
}

let rangesCache = null;
/** Books ordered by their contiguous page rowid range: [{ id, a, z }]. */
function bookRanges() {
  if (!rangesCache) rangesCache = db.prepare('SELECT id, rid_from AS a, rid_to AS z FROM book WHERE rid_from IS NOT NULL ORDER BY rid_from').all();
  return rangesCache;
}

/** SQL condition restricting FTS rowids to the given books (adjacent ranges merged). */
function ridFilter(ids) {
  const want = new Set(ids);
  const spans = [];
  for (const r of bookRanges()) {
    if (!want.has(r.id)) continue;
    const last = spans[spans.length - 1];
    if (last && last[1] + 1 === r.a) last[1] = r.z;
    else spans.push([r.a, r.z]);
  }
  if (!spans.length) return '0';
  return '(' + spans.map(([a, z]) => `rowid BETWEEN ${Number(a)} AND ${Number(z)}`).join(' OR ') + ')';
}

function idList(v) {
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
}

function scopeBooks({ cats, books }) {
  const c = idList(cats);
  const b = idList(books);
  if (!c.length && !b.length) return null;
  const set = new Set(b);
  if (c.length) for (const r of q('SELECT id FROM book WHERE cat IN (SELECT value FROM json_each(?))').all(JSON.stringify(c))) set.add(r.id);
  return [...set];
}

function titlePath(bookId, pid) {
  // Heading path (outermost first) for the last heading at or before this page.
  const t = q('SELECT tid, parent, text FROM title WHERE book = ? AND pid <= ? ORDER BY pid DESC, tid DESC LIMIT 1').get(bookId, pid);
  if (!t) return [];
  const out = [{ tid: t.tid, text: t.text }];
  let parent = t.parent;
  let guard = 0;
  while (parent && guard++ < 12) {
    const p = q('SELECT tid, parent, text FROM title WHERE book = ? AND tid = ?').get(bookId, parent);
    if (!p) break;
    out.unshift({ tid: p.tid, text: p.text });
    parent = p.parent;
  }
  return out;
}

function pageRow(r, bookId) {
  if (!r) return null;
  const b = q('SELECT rid_from, rid_to, pages FROM book WHERE id = ?').get(bookId);
  return {
    rid: r.rid,
    pid: r.pid,
    part: r.part,
    num: r.num,
    body: r.body,
    foot: r.foot,
    index: r.rid - b.rid_from + 1,
    total: b.pages,
    titles: q('SELECT tid, text FROM title WHERE book = ? AND pid = ? ORDER BY tid').all(bookId, r.pid),
    path: titlePath(bookId, r.pid),
  };
}

const now = () => Date.now();

// ------------------------------------------------------------------ API
const api = {
  info() {
    const info = Object.fromEntries(db.prepare('SELECT key, value FROM info').all().map((r) => [r.key, r.value]));
    info.hasCovers = !!covers;
    info.path = libraryPath;
    return info;
  },

  categories() {
    return db
      .prepare(
        `SELECT c.id, c.name, c.ord, (SELECT count(*) FROM book b WHERE b.cat = c.id) AS count
           FROM category c ORDER BY c.ord`,
      )
      .all()
      .filter((c) => c.count > 0);
  },

  books() {
    return db
      .prepare(
        `SELECT b.id, b.name, b.cat, b.pages, b.parts, b.has_cover AS cover, b.printed, b.type,
                a.id AS aid, a.name AS author, a.death, a.death_text AS deathText
           FROM book b LEFT JOIN author a ON a.id = b.main_author
          ORDER BY b.id`,
      )
      .all();
  },

  quickFind(text, limit = 30) {
    const n = normalize(text).trim();
    if (!n) return { books: [], authors: [] };
    const like = '%' + n.replace(/[%_]/g, '') + '%';
    const books = q(
      `SELECT b.id, b.name, a.name AS author, b.has_cover AS cover FROM book b LEFT JOIN author a ON a.id = b.main_author
        WHERE b.name_norm LIKE ? ORDER BY (b.name_norm LIKE ?) DESC, length(b.name) LIMIT ?`,
    ).all(like, n + '%', limit);
    const authors = q(
      `SELECT id, name, death, death_text AS deathText FROM author WHERE name_norm LIKE ?
        AND EXISTS (SELECT 1 FROM author_book ab WHERE ab.author_id = author.id) ORDER BY length(name) LIMIT 12`,
    ).all(like);
    return { books, authors };
  },

  book(id) {
    const b = q(
      `SELECT b.*, c.name AS catName, a.name AS author, a.death, a.death_text AS deathText, a.bio IS NOT NULL AS hasBio
         FROM book b LEFT JOIN category c ON c.id = b.cat LEFT JOIN author a ON a.id = b.main_author WHERE b.id = ?`,
    ).get(id);
    if (!b) return null;
    b.card = q('SELECT text FROM book_card WHERE book_id = ?').get(id)?.text || null;
    b.desc = q('SELECT text FROM book_desc WHERE book_id = ?').all(id).map((r) => r.text);
    b.series = q('SELECT series, number FROM book_series WHERE book_id = ?').all(id);
    b.contributors = q(
      `SELECT author_id AS aid, name, role FROM book_contrib WHERE book_id = ? ORDER BY ord, rowid`,
    ).all(id);
    b.authors = q(
      `SELECT a.id, a.name, a.death, a.death_text AS deathText FROM author_book ab JOIN author a ON a.id = ab.author_id
        WHERE ab.book_id = ?`,
    ).all(id);
    b.parts = q(
      `SELECT part, min(pid) AS pid, count(*) AS pages, min(num) AS first, max(num) AS last
         FROM page WHERE book = ? GROUP BY part ORDER BY min(rid)`,
    ).all(id);
    b.hasPdf = !!q('SELECT 1 FROM pdf_file WHERE book_id = ? LIMIT 1').get(id);
    b.tafsir = !!q('SELECT 1 FROM tafsir WHERE book = ? LIMIT 1').get(id);
    delete b.name_norm;
    delete b.alpha;
    return b;
  },

  toc(id) {
    return q('SELECT tid, pid, parent, text FROM title WHERE book = ? ORDER BY tid').all(id);
  },

  /** loc: { pid } | { rid } | { index } (1-based) | { part, num } | { last: true } */
  page(bookId, loc = {}) {
    const b = q('SELECT rid_from, rid_to FROM book WHERE id = ?').get(bookId);
    if (!b || b.rid_from == null) return null;
    const cols = 'rid, pid, part, num, body, foot';
    let r = null;
    if (loc.rid != null) r = q(`SELECT ${cols} FROM page WHERE rid = ? AND book = ?`).get(loc.rid, bookId);
    else if (loc.pid != null) {
      r = q(`SELECT ${cols} FROM page WHERE book = ? AND pid = ?`).get(bookId, loc.pid);
      if (!r) r = q(`SELECT ${cols} FROM page WHERE book = ? AND pid >= ? ORDER BY pid LIMIT 1`).get(bookId, loc.pid);
    } else if (loc.index != null) {
      const rid = Math.min(b.rid_to, Math.max(b.rid_from, b.rid_from + Number(loc.index) - 1));
      r = q(`SELECT ${cols} FROM page WHERE rid = ?`).get(rid);
    } else if (loc.num != null) {
      const params = [bookId, Number(loc.num)];
      let sql = `SELECT ${cols} FROM page WHERE book = ? AND num >= ?`;
      if (loc.part != null) {
        sql += ' AND part = ?';
        params.push(String(loc.part));
      }
      r = q(sql + ' ORDER BY num, rid LIMIT 1').get(...params);
    } else if (loc.last) r = q(`SELECT ${cols} FROM page WHERE rid = ?`).get(b.rid_to);
    if (!r) r = q(`SELECT ${cols} FROM page WHERE rid = ?`).get(b.rid_from);
    return pageRow(r, bookId);
  },

  /** Consecutive pages for continuous reading: count may be negative to read backwards. */
  pages(bookId, fromRid, count) {
    const b = q('SELECT rid_from, rid_to FROM book WHERE id = ?').get(bookId);
    if (!b) return [];
    const n = Math.max(1, Math.min(8, Math.abs(count)));
    const rows =
      count >= 0
        ? q('SELECT rid, pid, part, num, body, foot FROM page WHERE rid BETWEEN ? AND ? ORDER BY rid').all(fromRid, Math.min(b.rid_to, fromRid + n - 1))
        : q('SELECT rid, pid, part, num, body, foot FROM page WHERE rid BETWEEN ? AND ? ORDER BY rid').all(Math.max(b.rid_from, fromRid - n + 1), fromRid);
    return rows.map((r) => pageRow(r, bookId));
  },

  search(opts = {}) {
    const m = buildMatch(opts.q || '', opts);
    if (!m) return { total: 0, results: [], facets: [], words: [] };
    const limit = Math.max(1, Math.min(200, opts.limit || 40));
    const offset = Math.max(0, opts.offset || 0);
    // Only the FTS index is queried; scope is expressed as rowid ranges because every book's
    // pages occupy one contiguous rowid range. Joining the (large) page table here is slow.
    let filter = '';
    if (opts.book) {
      const b = q('SELECT rid_from, rid_to FROM book WHERE id = ?').get(Number(opts.book));
      if (!b || b.rid_from == null) return { total: 0, results: [], facets: [], words: m.hlWords };
      filter = ` AND rowid BETWEEN ${b.rid_from} AND ${b.rid_to}`;
    } else {
      const ids = scopeBooks(opts);
      if (ids) filter = ' AND ' + ridFilter(ids);
    }
    const where = `FROM page_fts WHERE page_fts MATCH ?${filter}`;
    const order = opts.order === 'rank' ? 'rank' : 'rowid';
    const get = q('SELECT rid, book, pid, part, num, body, foot FROM page WHERE rid = ?');
    let rows;
    try {
      rows = db
        .prepare(`SELECT rowid AS rid ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`)
        .all(m.expr)
        .map((r) => get.get(r.rid))
        .filter(Boolean);
    } catch (e) {
      throw new Error('صيغة البحث غير صحيحة');
    }
    const re = m.phrase ? phraseRegex(m.hlWords) : highlightRegex(m.hlWords, m.flexible);
    const results = rows.map((r) => {
      let s = snippet(r.body, re);
      let inFoot = false;
      if (!s && r.foot) {
        s = snippet(r.foot, re);
        inFoot = !!s;
      }
      return {
        rid: r.rid,
        book: r.book,
        bookName: bookName(r.book),
        pid: r.pid,
        part: r.part,
        num: r.num,
        inFoot,
        snippet: s || snippet(r.body, null, 200),
      };
    });
    let total = null;
    let facets = null;
    if (offset === 0) {
      // Count matches per book by walking the (ascending) rowids against the sorted book ranges.
      const ranges = bookRanges();
      const counts = new Map();
      let i = 0;
      total = 0;
      for (const r of db.prepare(`SELECT rowid AS rid ${where}`).iterate(m.expr)) {
        while (i < ranges.length && ranges[i].z < r.rid) i++;
        if (i >= ranges.length) break;
        if (r.rid < ranges[i].a) continue;
        const id = ranges[i].id;
        counts.set(id, (counts.get(id) || 0) + 1);
        total++;
      }
      facets = [...counts]
        .map(([book, count]) => ({ book, count, name: bookName(book) }))
        .sort((a, b) => b.count - a.count);
    }
    return { total, results, facets, words: m.hlWords, flexible: m.flexible, roots: m.roots, phrase: m.phrase };
  },

  searchTitles(opts = {}) {
    const m = buildMatch(opts.q || '', { ...opts, foot: true, mode: opts.mode === 'phrase' ? 'phrase' : opts.mode === 'any' ? 'any' : 'all' });
    if (!m) return { results: [], words: [] };
    let filter = '';
    const params = { $m: m.expr };
    if (opts.book) {
      filter = ' AND t.book = $bk';
      params.$bk = Number(opts.book);
    } else {
      const ids = scopeBooks(opts);
      if (ids) {
        filter = ' AND t.book IN (SELECT value FROM json_each($b))';
        params.$b = JSON.stringify(ids);
      }
    }
    const rows = db
      .prepare(`SELECT t.book, t.tid, t.pid, t.text FROM title_fts f JOIN title t ON t.id = f.rowid WHERE title_fts MATCH $m${filter} ORDER BY f.rowid LIMIT 1000`)
      .all(params);
    return { results: rows.map((r) => ({ ...r, bookName: bookName(r.book) })), words: m.hlWords, flexible: m.flexible, phrase: m.phrase };
  },

  authors() {
    return db
      .prepare(
        `SELECT a.id, a.name, a.death, a.death_text AS deathText, a.bio IS NOT NULL AS hasBio, count(ab.book_id) AS books
           FROM author a JOIN author_book ab ON ab.author_id = a.id JOIN book b ON b.id = ab.book_id
          GROUP BY a.id ORDER BY a.death, a.name`,
      )
      .all();
  },

  author(id) {
    const a = q('SELECT id, name, death, death_text AS deathText, bio FROM author WHERE id = ?').get(id);
    if (!a) return null;
    a.books = q(
      `SELECT b.id, b.name, b.pages, b.has_cover AS cover, b.cat FROM author_book ab JOIN book b ON b.id = ab.book_id
        WHERE ab.author_id = ? ORDER BY b.name`,
    ).all(id);
    a.contributions = q(
      `SELECT DISTINCT c.book_id AS id, b.name, c.role FROM book_contrib c JOIN book b ON b.id = c.book_id
        WHERE c.author_id = ? AND c.book_id NOT IN (SELECT book_id FROM author_book WHERE author_id = ?) ORDER BY b.name`,
    ).all(id, id);
    return a;
  },

  ayat(sura) {
    return q('SELECT id, num, uthmani, text FROM aya WHERE sura = ? ORDER BY num').all(sura);
  },

  searchAyat(text) {
    const m = buildMatch(text, { mode: 'all', flexible: true });
    if (!m) return { results: [], words: [] };
    const rows = db
      .prepare('SELECT a.id, a.sura, a.num, a.text, a.uthmani FROM aya_fts f JOIN aya a ON a.id = f.rowid WHERE aya_fts MATCH ? ORDER BY f.rowid LIMIT 500')
      .all(m.expr);
    return { results: rows, words: m.hlWords };
  },

  tafsir(ayaId) {
    return q(
      `SELECT t.book, t.pid, b.name FROM tafsir t JOIN book b ON b.id = t.book WHERE t.aya = ? ORDER BY t.book`,
    ).all(ayaId);
  },

  pdfLink(bookId, pid) {
    const map = q('SELECT file_ord, pdf_leaf FROM pdf_map WHERE book_id = ? AND reader_page = ?').get(bookId, pid);
    const file = map
      ? q('SELECT url FROM pdf_file WHERE book_id = ? AND file_ord = ? ORDER BY account_id LIMIT 1').get(bookId, map.file_ord)
      : q('SELECT url FROM pdf_file WHERE book_id = ? ORDER BY file_ord, account_id LIMIT 1').get(bookId);
    if (!file) return null;
    return map && map.pdf_leaf ? `${file.url}#page=${map.pdf_leaf}` : file.url;
  },

  roots(word) {
    const w = tokenize(word)[0];
    if (!w) return null;
    const r = rootForms(w);
    return { word: w, roots: r.roots, forms: r.forms.length };
  },

  cover(id, full) {
    if (!covers) return null;
    const r = q(`SELECT ${full ? 'full' : 'thumb'} AS data FROM cover WHERE id = ?`, covers).get(id);
    return r ? r.data : null;
  },

  // -------------------------------------------------------------- user data
  userBookmarks(bookId) {
    const rows = bookId
      ? q('SELECT * FROM bookmark WHERE book = ? ORDER BY pid', user).all(bookId)
      : q('SELECT * FROM bookmark ORDER BY updated DESC LIMIT 2000', user).all();
    return rows.map((r) => ({ ...r, bookName: bookName(r.book) }));
  },
  userPageBookmarks(bookId, pid) {
    return q('SELECT * FROM bookmark WHERE book = ? AND pid = ?', user).all(bookId, pid);
  },
  userAddBookmark(b) {
    const t = now();
    const r = q('INSERT INTO bookmark (book, pid, label, note, color, created, updated) VALUES (?,?,?,?,?,?,?)', user).run(
      Number(b.book), Number(b.pid), String(b.label || '').slice(0, 300), String(b.note || '').slice(0, 20000), b.color || null, t, t,
    );
    return Number(r.lastInsertRowid);
  },
  userUpdateBookmark(id, b) {
    q('UPDATE bookmark SET label = ?, note = ?, color = ?, updated = ? WHERE id = ?', user).run(
      String(b.label || '').slice(0, 300), String(b.note || '').slice(0, 20000), b.color || null, now(), Number(id),
    );
    return true;
  },
  userDeleteBookmark(id) {
    q('DELETE FROM bookmark WHERE id = ?', user).run(Number(id));
    return true;
  },
  userSavePosition(bookId, pid) {
    q(
      `INSERT INTO history (book, pid, opened, count) VALUES (?,?,?,1)
       ON CONFLICT(book) DO UPDATE SET pid = excluded.pid, opened = excluded.opened`,
      user,
    ).run(Number(bookId), Number(pid), now());
    return true;
  },
  userGetPosition(bookId) {
    return q('SELECT pid FROM history WHERE book = ?', user).get(bookId)?.pid ?? null;
  },
  userHistory(limit = 60) {
    return q('SELECT book, pid, opened FROM history ORDER BY opened DESC LIMIT ?', user)
      .all(limit)
      .map((r) => ({ ...r, bookName: bookName(r.book) }))
      .filter((r) => r.bookName);
  },
  userClearHistory() {
    q('DELETE FROM history', user).run();
    return true;
  },
  userFavorites() {
    return q('SELECT book, added FROM favorite ORDER BY added DESC', user).all().map((r) => r.book);
  },
  userIsFavorite(bookId) {
    return !!q('SELECT 1 FROM favorite WHERE book = ?', user).get(bookId);
  },
  userToggleFavorite(bookId) {
    if (api.userIsFavorite(bookId)) {
      q('DELETE FROM favorite WHERE book = ?', user).run(bookId);
      return false;
    }
    q('INSERT INTO favorite (book, added) VALUES (?,?)', user).run(bookId, now());
    return true;
  },
  userSearchHistory() {
    return q('SELECT q FROM search_history ORDER BY at DESC LIMIT 30', user).all().map((r) => r.q);
  },
  userAddSearch(text) {
    const s = String(text || '').trim().slice(0, 300);
    if (s) q('INSERT INTO search_history (q, at) VALUES (?, ?) ON CONFLICT(q) DO UPDATE SET at = excluded.at', user).run(s, now());
    return true;
  },
  userClearSearchHistory() {
    q('DELETE FROM search_history', user).run();
    return true;
  },
};

// ------------------------------------------------------------------ message loop
try {
  openAll();
  parentPort.postMessage({ ready: true, info: api.info() });
} catch (e) {
  parentPort.postMessage({ ready: false, error: String(e.message || e) });
}

parentPort.on('message', ({ id, method, args }) => {
  try {
    const fn = api[method];
    if (!fn) throw new Error('unknown method ' + method);
    parentPort.postMessage({ id, result: fn(...(args || [])) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e.message || e) });
  }
});
