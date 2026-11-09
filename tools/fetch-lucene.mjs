// Downloads the official Lucene jars that ship with the app (used to read the original app's
// index during sync) into vendor/java, verified against Maven Central's SHA-1 checksums.
//   node tools/fetch-lucene.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '10.4.0';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'java');
fs.mkdirSync(dir, { recursive: true });

for (const name of ['lucene-core', 'lucene-backward-codecs']) {
  const file = path.join(dir, `${name}-${VERSION}.jar`);
  const url = `https://repo1.maven.org/maven2/org/apache/lucene/${name}/${VERSION}/${name}-${VERSION}.jar`;
  const want = (await (await fetch(url + '.sha1')).text()).trim().split(/\s+/)[0];
  if (fs.existsSync(file) && createHash('sha1').update(fs.readFileSync(file)).digest('hex') === want) {
    console.log('ok', path.basename(file));
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha1').update(buf).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${name}: ${got} != ${want}`);
  fs.writeFileSync(file, buf);
  console.log('downloaded', path.basename(file));
}
if (!fs.existsSync(path.join(dir, 'LuceneExport.class'))) throw new Error('vendor/java/LuceneExport.class is missing');
