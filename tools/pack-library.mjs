// Packs a built library for publishing as release assets the app can download by itself.
//
//   node tools/pack-library.mjs --lib <library dir> --out <dir> [--part-mb 1900]
//
// Each database is gzip-compressed and the compressed stream is cut into parts below GitHub's
// 2 GB asset limit. library.json lists every part with its size and SHA-256, plus the size and
// SHA-256 of each restored file, so the app can verify, resume and reassemble without any tool.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const lib = path.resolve(arg('lib'));
const out = path.resolve(arg('out'));
const PART = Number(arg('part-mb', 1900)) * 1024 * 1024;
fs.mkdirSync(out, { recursive: true });

async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 22 }), new Writable({ write(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}

/** Writable that splits incoming bytes into numbered part files, hashing each part. */
function splitter(base) {
  const parts = [];
  let cur = null;
  const open = () => {
    const name = `${base}.gz.${String(parts.length + 1).padStart(3, '0')}`;
    cur = { name, fd: fs.openSync(path.join(out, name), 'w'), size: 0, hash: createHash('sha256') };
    parts.push(cur);
  };
  const close = () => {
    if (!cur) return;
    fs.closeSync(cur.fd);
    cur.sha256 = cur.hash.digest('hex');
    delete cur.hash;
    delete cur.fd;
  };
  return {
    parts,
    stream: new Writable({
      highWaterMark: 1 << 22,
      write(chunk, _e, cb) {
        let off = 0;
        while (off < chunk.length) {
          if (!cur || cur.size >= PART) {
            close();
            open();
          }
          const n = Math.min(PART - cur.size, chunk.length - off);
          const slice = chunk.subarray(off, off + n);
          fs.writeSync(cur.fd, slice);
          cur.hash.update(slice);
          cur.size += n;
          off += n;
        }
        cb();
      },
      final(cb) {
        close();
        cb();
      },
    }),
  };
}

const manifest = { format: 1, created: new Date().toISOString(), files: [] };
for (const name of ['ibadi.db', 'covers.db']) {
  const file = path.join(lib, name);
  if (!fs.existsSync(file)) continue;
  const t0 = Date.now();
  const size = fs.statSync(file).size;
  const sha256 = await sha256File(file);
  const s = splitter(name);
  await pipeline(fs.createReadStream(file, { highWaterMark: 1 << 22 }), zlib.createGzip({ level: 6, chunkSize: 1 << 20 }), s.stream);
  const packed = s.parts.reduce((a, p) => a + p.size, 0);
  manifest.files.push({ name, size, sha256, parts: s.parts });
  console.log(`${name}: ${(size / 1e9).toFixed(2)} GB -> ${(packed / 1e9).toFixed(2)} GB in ${s.parts.length} part(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
// Library metadata shown before downloading.
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(lib, 'ibadi.db'), { readOnly: true });
  manifest.info = Object.fromEntries(db.prepare('SELECT key, value FROM info').all().map((r) => [r.key, r.value]));
  db.close();
} catch {}
manifest.download = manifest.files.reduce((a, f) => a + f.parts.reduce((b, p) => b + p.size, 0), 0);
manifest.installed = manifest.files.reduce((a, f) => a + f.size, 0);
fs.writeFileSync(path.join(out, 'library.json'), JSON.stringify(manifest, null, 1));
console.log('wrote library.json', JSON.stringify({ download: manifest.download, installed: manifest.installed, info: manifest.info }));
