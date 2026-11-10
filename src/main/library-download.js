// Downloads the published library (release assets described by library.json) and restores it:
// every part is SHA-256 verified, interrupted parts resume with HTTP Range requests, and the
// gzip stream is decompressed and verified before files are moved into place.
import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class LibraryDownloader {
  constructor({ baseUrl, send }) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.send = send;
    this.abort = null;
    this.running = false;
  }

  async manifest() {
    const res = await net.fetch(this.baseUrl + 'library.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`تعذّر الوصول إلى خادم التنزيل (${res.status})`);
    const m = await res.json();
    if (m.format !== 1 || !Array.isArray(m.files)) throw new Error('صيغة بيان المكتبة غير معروفة');
    for (const f of m.files) {
      if (!SAFE_NAME.test(f.name) || !f.parts.every((p) => SAFE_NAME.test(p.name))) throw new Error('اسم ملف غير صالح في بيان المكتبة');
    }
    return m;
  }

  cancel() {
    this.abort?.abort();
  }

  emit(e) {
    this.send(e);
  }

  async run(target) {
    if (this.running) throw new Error('التنزيل جارٍ بالفعل');
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const m = await this.manifest();
      fs.mkdirSync(target, { recursive: true });
      const tmp = path.join(target, '.download');
      fs.mkdirSync(tmp, { recursive: true });

      // Space: compressed parts and restored files coexist until the end.
      const already = m.files.flatMap((f) => f.parts).reduce((a, p) => {
        try {
          return a + Math.min(fs.statSync(path.join(tmp, p.name)).size, p.size);
        } catch {
          return a;
        }
      }, 0);
      const need = m.download - already + m.installed + 256 * 1024 * 1024;
      const st = fs.statfsSync(target);
      const free = st.bavail * st.bsize;
      if (free < need) {
        throw new Error(`المساحة غير كافية: يلزم ${(need / 1e9).toFixed(1)} غ.ب ويتوفّر ${(free / 1e9).toFixed(1)} غ.ب`);
      }

      const total = m.download;
      let done = 0;
      const parts = m.files.flatMap((f) => f.parts);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const label = `تنزيل الجزء ${i + 1} من ${parts.length}`;
        await this.part(p, tmp, signal, (bytes) => this.emit({ phase: 'download', message: label, received: done + bytes, total }));
        done += p.size;
      }

      for (const f of m.files) {
        this.emit({ phase: 'restore', message: `فكّ ضغط ${f.name} والتحقّق منه`, received: total, total });
        const out = path.join(target, f.name + '.restoring');
        const hash = createHash('sha256');
        let size = 0;
        const sink = fs.createWriteStream(out, { highWaterMark: 1 << 22 });
        const tap = new Writable({
          highWaterMark: 1 << 22,
          write(chunk, _e, cb) {
            hash.update(chunk);
            size += chunk.length;
            if (!sink.write(chunk)) sink.once('drain', cb);
            else cb();
          },
          final(cb) {
            sink.end(cb);
          },
        });
        const files = f.parts.map((p) => path.join(tmp, p.name));
        async function* concat() {
          for (const file of files) for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 22 })) yield c;
        }
        await pipeline(Readable.from(concat()), zlib.createGunzip({ chunkSize: 1 << 20 }), tap, { signal });
        if (size !== f.size || hash.digest('hex') !== f.sha256) {
          fs.rmSync(out, { force: true });
          throw new Error(`فشل التحقّق من ${f.name} بعد فكّ الضغط`);
        }
      }
      for (const f of m.files) {
        const final = path.join(target, f.name);
        fs.rmSync(final, { force: true });
        fs.renameSync(path.join(target, f.name + '.restoring'), final);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      this.emit({ phase: 'done', received: total, total });
      return target;
    } catch (e) {
      const msg = e?.name === 'AbortError' ? 'أُلغي التنزيل. يمكنك استئنافه لاحقًا من حيث توقّف.' : String(e?.message || e);
      const paused = e?.name === 'AbortError';
      this.emit({ phase: 'error', message: msg, paused });
      throw Object.assign(new Error(msg), { paused });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  /** Downloads one part to tmp, resuming a partial file, and verifies its SHA-256. */
  async part(p, tmp, signal, onBytes) {
    const file = path.join(tmp, p.name);
    const hash = createHash('sha256');
    let have = 0;
    if (fs.existsSync(file)) {
      have = fs.statSync(file).size;
      if (have > p.size) {
        fs.rmSync(file);
        have = 0;
      } else {
        for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 22 })) hash.update(c);
      }
    }
    if (have < p.size) {
      const headers = have ? { Range: `bytes=${have}-` } : {};
      const res = await net.fetch(this.baseUrl + p.name, { headers, signal, cache: 'no-store' });
      if (have && res.status === 200) {
        // server ignored the range: start this part over
        await res.body?.cancel();
        fs.rmSync(file, { force: true });
        return this.part(p, tmp, signal, onBytes);
      }
      if (!res.ok) throw new Error(`فشل تنزيل ${p.name} (${res.status})`);
      const fd = fs.openSync(file, have ? 'a' : 'w');
      let last = 0;
      try {
        for await (const chunk of res.body) {
          fs.writeSync(fd, chunk);
          hash.update(chunk);
          have += chunk.length;
          const now = Date.now();
          if (now - last > 250) {
            last = now;
            onBytes(have);
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    onBytes(have);
    if (have !== p.size || hash.digest('hex') !== p.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error(`تلف الجزء ${p.name} أثناء التنزيل؛ أعد المحاولة`);
    }
  }
}
