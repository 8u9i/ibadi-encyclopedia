// Minimal static file server with HTTP Range support, for testing the library downloader.
//   node tools/serve-dir.mjs <dir> <port> [bytesPerSecond]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dir, port = '8765', rate = '0'] = process.argv.slice(2);
const limit = Number(rate);
http
  .createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(dir, name);
    if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) return res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { 'content-length': size - start, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${start}-${size - 1}/${size}` } : {}) });
    console.log(req.method, name, m ? `range ${start}` : 'full');
    const stream = fs.createReadStream(file, { start, highWaterMark: 1 << 20 });
    if (!limit) return stream.pipe(res);
    stream.on('data', (c) => {
      stream.pause();
      res.write(c);
      setTimeout(() => stream.resume(), (c.length / limit) * 1000);
    });
    stream.on('end', () => res.end());
    res.on('close', () => stream.destroy());
  })
  .listen(Number(port), '127.0.0.1', () => console.log('serving', dir, 'on', port));
