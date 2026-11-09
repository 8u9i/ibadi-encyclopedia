// One-command conversion of the original Ibadi Encyclopedia data into the app's portable library.
//
//   node tools/convert.mjs --src "C:\ibadi\database" --out "D:\ibadi-library" [--java "C:\path\to\jdk-21"]
//
// Needs a JDK 21+ (java + javac) to read the original Lucene 10 indexes. The official Lucene jars are
// downloaded from Maven Central and verified against their published SHA-1 checksums.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const src = arg('src');
const out = arg('out');
if (!src || !out) {
  console.error('usage: node tools/convert.mjs --src <original database folder> --out <library folder> [--java <JDK home>]');
  process.exit(2);
}
if (!fs.existsSync(path.join(src, 'master.db')) || !fs.existsSync(path.join(src, 'store', 'page'))) {
  console.error(`"${src}" does not look like the original database folder (expected master.db and store/page).`);
  process.exit(2);
}

const javaHome = arg('java') || process.env.JAVA_HOME;
const exe = (n) => (javaHome ? path.join(javaHome, 'bin', n + (process.platform === 'win32' ? '.exe' : '')) : n);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
};
if (spawnSync(exe('javac'), ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('A JDK 21+ is required (javac not found). Pass --java <JDK home> or set JAVA_HOME.');
  process.exit(2);
}

// 1. Official Lucene jars, verified.
const LUCENE = '10.4.0';
const libDir = path.join(here, 'lucene', 'lib');
fs.mkdirSync(libDir, { recursive: true });
const jars = [];
for (const name of ['lucene-core', 'lucene-backward-codecs']) {
  const file = path.join(libDir, `${name}-${LUCENE}.jar`);
  const url = `https://repo1.maven.org/maven2/org/apache/lucene/${name}/${LUCENE}/${name}-${LUCENE}.jar`;
  if (!fs.existsSync(file)) {
    console.log('downloading', url);
    const [jar, sha] = await Promise.all([fetch(url), fetch(url + '.sha1')]);
    if (!jar.ok || !sha.ok) throw new Error('download failed: ' + url);
    const buf = Buffer.from(await jar.arrayBuffer());
    const want = (await sha.text()).trim().split(/\s+/)[0];
    const got = createHash('sha1').update(buf).digest('hex');
    if (got !== want) throw new Error(`checksum mismatch for ${name}: ${got} != ${want}`);
    fs.writeFileSync(file, buf);
  }
  jars.push(file);
}
const cp = jars.join(path.delimiter);

// 2. Compile and run the exporter.
const build = path.join(here, 'lucene', 'build');
run(exe('javac'), ['-d', build, '-cp', cp, path.join(here, 'lucene', 'LuceneExport.java')]);
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibadi-export-'));
for (const idx of ['title', 'aya', 'page']) {
  run(exe('java'), ['-cp', build + path.delimiter + cp, 'LuceneExport', path.join(src, 'store', idx), path.join(exportDir, idx + '.jsonl')]);
}

// 3. Build the SQLite library with Electron (same SQLite as the app; nativeImage for covers).
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // must run as a full Electron app (nativeImage is used for covers)
run(electron, [path.join(here, 'build-library.mjs'), '--src', src, '--export', exportDir, '--out', out], { env });
fs.rmSync(exportDir, { recursive: true, force: true });
console.log(`\nLibrary ready in ${out}. Point the app at this folder, or place it next to the app as "library".`);
