// Exercises the database worker against a built library and reports timings.
//   ELECTRON_RUN_AS_NODE=1 electron tools/smoke-test.mjs <library dir>
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(process.argv[2] || path.join(here, '..', '..', 'library'));
const userDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ibadi-test-')), 'user.db');
const w = new Worker(path.join(here, '..', 'src', 'main', 'db-worker.js'), { workerData: { libraryPath: lib, userDbPath: userDb } });

let seq = 0;
const pending = new Map();
const ready = new Promise((res, rej) => {
  w.once('message', (m) => (m.ready ? res(m.info) : rej(new Error(m.error))));
});
w.on('message', (m) => {
  if (m.id == null) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
});
const call = (method, ...args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, method, args });
  });

let failures = 0;
async function check(name, fn, test) {
  const t = performance.now();
  try {
    const r = await fn();
    const ms = (performance.now() - t).toFixed(0);
    const ok = test(r);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(42)} ${ms.padStart(6)} ms  ${summary(r)}`);
    return r;
  } catch (e) {
    failures++;
    console.log(`FAIL ${name.padEnd(42)} threw: ${e.message}`);
  }
}
function summary(r) {
  if (Array.isArray(r)) return `[${r.length}]`;
  if (r && typeof r === 'object') return JSON.stringify(r).slice(0, 150);
  return String(r).slice(0, 150);
}

const info = await ready;
console.log('library', info);
const books = await check('books', () => call('books'), (r) => r.length === Number(info.books));
await check('categories', () => call('categories'), (r) => r.length > 20);
const b = await check('book 74 meta', () => call('book', 74), (r) => r && r.pages > 0 && r.parts.length >= 1);
await check('toc 74', () => call('toc', 74), (r) => Array.isArray(r));
const p1 = await check('page index 1', () => call('page', 74, { index: 1 }), (r) => r && r.index === 1);
await check('page last', () => call('page', 74, { last: true }), (r) => r && r.index === b.pages);
await check('page by pid', () => call('page', 74, { pid: p1.pid + 5 }), (r) => r && r.pid === p1.pid + 5);
await check('pages continuous +3', () => call('pages', 74, p1.rid, 3), (r) => r.length === 3 && r[2].rid === p1.rid + 2);
await check('pages backwards clamps', () => call('pages', 74, p1.rid, -3), (r) => r.length === 1);
await check('search common word (all books)', () => call('search', { q: 'الله', limit: 40 }), (r) => r.total > 100000 && r.results.length === 40);
await check('search rank order', () => call('search', { q: 'الإمامة', order: 'rank', limit: 20 }), (r) => r.results.length === 20);
await check('search flexible العلم', () => call('search', { q: 'العلم', limit: 5 }), (r) => r.total > 1000 && r.results[0].snippet.parts.some((p) => p[1]));
await check('search exact vs flexible', async () => {
  const a = await call('search', { q: 'علم', flexible: false, limit: 1 });
  const c = await call('search', { q: 'علم', flexible: true, limit: 1 });
  return [a.total, c.total];
}, ([a, c]) => c > a);
await check('search phrase', () => call('search', { q: 'جابر بن زيد', mode: 'phrase', limit: 10 }), (r) => r.total > 100);
await check('search root كتب', () => call('search', { q: 'كتب', mode: 'root', limit: 10 }), (r) => r.total > 1000 && r.roots[0].roots.length > 0);
await check('search in book 74', () => call('search', { q: 'العدل', book: 74, limit: 10 }), (r) => r.total > 0 && r.results.every((x) => x.book === 74));
await check('search by category', () => call('search', { q: 'الصلاة', cats: [6], limit: 40 }), (r) => {
  const inCat = new Set(books.filter((x) => x.cat === 6).map((x) => x.id));
  return r.total > 0 && r.results.every((x) => inCat.has(x.book)) && r.facets.every((f) => inCat.has(f.book));
});
await check('search books scope + facets sum', () => call('search', { q: 'الزكاة', books: [74, 659, 660], limit: 40 }), (r) =>
  r.results.every((x) => [74, 659, 660].includes(x.book)) && r.facets.reduce((a, f) => a + f.count, 0) === r.total);
await check('search paging offset', async () => {
  const a = await call('search', { q: 'الصلاة', limit: 20 });
  const b2 = await call('search', { q: 'الصلاة', limit: 20, offset: 20 });
  return [a.results.at(-1).rid, b2.results[0].rid, b2.total];
}, ([x, y, t]) => y > x && t === null);
await check('search prefix *', () => call('search', { q: 'اباض*', limit: 5 }), (r) => r.total > 1000);
await check('search no results', () => call('search', { q: 'قثقثقثقث', limit: 5 }), (r) => r.total === 0);
await check('search with quotes/symbols', () => call('search', { q: '"الله" AND (', limit: 5 }), (r) => r.total > 0);
await check('search titles', () => call('searchTitles', { q: 'الصلاة' }), (r) => r.results.length > 10);
await check('quickFind', () => call('quickFind', 'الجامع'), (r) => r.books.length > 0);
await check('authors', () => call('authors'), (r) => r.length > 500);
await check('author 1102', () => call('author', 1102), (r) => r && r.books.length > 0);
await check('ayat sura 2', () => call('ayat', 2), (r) => r.length === 286);
await check('searchAyat', () => call('searchAyat', 'الصابرين'), (r) => r.results.length > 5);
await check('tafsir aya 255', () => call('tafsir', 255), (r) => r.length >= 1);
await check('pdfLink 74', () => call('pdfLink', 74, 3), (r) => typeof r === 'string' && r.startsWith('https://'));
await check('roots', () => call('roots', 'للموحدين'), (r) => r.roots.includes('وحد'));
await check('cover thumb', () => call('cover', 74, false), (r) => r && r.length > 1000 && r[0] === 0xff);
const bm = await check('add bookmark', () => call('userAddBookmark', { book: 74, pid: 3, label: 'اختبار', note: 'ملاحظة' }), (r) => r > 0);
await check('bookmarks', () => call('userBookmarks', 74), (r) => r.length === 1 && r[0].bookName);
await check('delete bookmark', () => call('userDeleteBookmark', bm), (r) => r === true);
await check('save/get position', async () => {
  await call('userSavePosition', 74, 9);
  return call('userGetPosition', 74);
}, (r) => r === 9);
await check('favorites toggle', () => call('userToggleFavorite', 74), (r) => r === true);
await check('history', () => call('userHistory'), (r) => r.length === 1);

// Every book opens on its first page.
await check('all books open', async () => {
  let bad = [];
  for (const bk of books) {
    const p = await call('page', bk.id, { index: 1 });
    if (!p) bad.push(bk.id);
  }
  return bad;
}, (bad) => bad.length === 0);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
await w.terminate();
process.exit(failures ? 1 : 0);
