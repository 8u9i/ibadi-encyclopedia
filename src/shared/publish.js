// Publishes library changes as an update pack to the `library` GitHub release, using the GitHub CLI
// (gh) and its login. Used by tools/publish-update.mjs and by the app's optional auto-publish.
//
// Release assets involved:
//   library.json             manifest read by the app (full download + list of update packs)
//   state.json               per-book fingerprints of what has been published (publisher only)
//   update-NNNN.db.gz        one pack per published version
//
// Order of uploads makes a failure at any point harmless: the pack first, then library.json (which
// makes it visible), then state.json. If state.json is not updated, the next run simply ships the
// same books again, and applying a book twice is idempotent.
import { DatabaseSync } from 'node:sqlite';
import { spawnSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { libraryState, diffStates, buildPack, installedVersion, setInstalledVersion } from './library-pack.js';

export const DEFAULT_REPO = '8u9i/ibadi-encyclopedia';
export const DEFAULT_TAG = 'library';

function ghRun(gh, args, { retries = 1 } = {}) {
  let last;
  for (let i = 0; i < retries; i++) {
    const r = spawnSync(gh, args, { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000 });
    if (r.error) throw new Error(`تعذّر تشغيل gh: ${r.error.message}`);
    if (r.status === 0) return r.stdout;
    last = (r.stderr || r.stdout || '').trim();
  }
  throw new Error(`gh ${args[0]} ${args[1] || ''}: ${last}`);
}

/** Whether gh is installed, logged in, and allowed to write to the repository. */
export function canPublish({ gh = 'gh', repo = DEFAULT_REPO } = {}) {
  try {
    const r = spawnSync(gh, ['api', `repos/${repo}`, '--jq', '.permissions.push'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return r.status === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Same check without blocking the calling thread (used by the app's main process). */
export function canPublishAsync({ gh = 'gh', repo = DEFAULT_REPO } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(gh, ['api', `repos/${repo}`, '--jq', '.permissions.push'], { windowsHide: true, timeout: 20000 }, (err, stdout) =>
        resolve(!err && String(stdout).trim() === 'true'),
      );
    } catch {
      resolve(false);
    }
  });
}

async function sha256File(file) {
  const h = createHash('sha256');
  for await (const c of fs.createReadStream(file, { highWaterMark: 1 << 20 })) h.update(c);
  return h.digest('hex');
}

/**
 * @param {object} o
 * @param {string} o.libDir      library folder (ibadi.db, covers.db)
 * @param {string} o.workDir     scratch folder
 * @param {boolean} [o.init]     record the current library as the published state (no pack)
 * @param {boolean} [o.dryRun]   build the pack but upload nothing
 * @param {(msg: string) => void} [o.log]
 */
export async function publish({ libDir, workDir, repo = DEFAULT_REPO, tag = DEFAULT_TAG, gh = 'gh', init = false, dryRun = false, log = () => {} }) {
  fs.mkdirSync(workDir, { recursive: true });
  const local = (n) => path.join(workDir, n);
  const upload = (...files) => ghRun(gh, ['release', 'upload', tag, ...files, '--repo', repo, '--clobber'], { retries: 3 });

  log('قراءة بيان المكتبة المنشور');
  for (const n of ['library.json', 'state.json']) fs.rmSync(local(n), { force: true });
  ghRun(gh, ['release', 'download', tag, '--repo', repo, '-p', 'library.json', '-D', workDir, '--clobber'], { retries: 3 });
  try {
    ghRun(gh, ['release', 'download', tag, '--repo', repo, '-p', 'state.json', '-D', workDir, '--clobber']);
  } catch {}
  const manifest = JSON.parse(fs.readFileSync(local('library.json'), 'utf8'));
  const latest = Number(manifest.version) || 0;

  log('حساب بصمات الكتب');
  const db = new DatabaseSync(path.join(libDir, 'ibadi.db'), { readOnly: true, timeout: 15000 });
  let current;
  let mine;
  try {
    current = libraryState(db, (stage) => log(`حساب بصمات الكتب: ${stage}`));
    mine = installedVersion(db);
  } finally {
    db.close();
  }
  const stateFile = local('state.json');

  if (init) {
    fs.writeFileSync(stateFile, JSON.stringify({ version: latest, ...current }));
    if (!dryRun) {
      upload(stateFile);
      if (mine < latest) setInstalledVersion(libDir, latest);
    }
    return { init: true, version: latest, books: Object.keys(current.books).length };
  }

  if (!fs.existsSync(stateFile)) throw new Error('لا توجد حالة منشورة (state.json). شغّل الأداة مرّة بالخيار --init على نسخة مطابقة للمكتبة المنشورة.');
  const published = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const d = diffStates(published, current);
  if (!d.put.length && !d.del.length && !d.global) {
    if (!dryRun && mine < latest) setInstalledVersion(libDir, latest);
    return { changed: false, version: latest };
  }

  const version = latest + 1;
  const name = `update-${String(version).padStart(4, '0')}.db.gz`;
  const raw = local(`update-${version}.db`);
  log(`تجهيز التحديث ${version}: ${d.put.length} كتاب جديد أو معدَّل، ${d.del.length} محذوف`);
  const counts = buildPack(libDir, raw, { version, ...d });
  const gz = local(name);
  await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz));
  fs.rmSync(raw, { force: true });
  const size = fs.statSync(gz).size;
  const sha256 = await sha256File(gz);
  const added = d.put.filter((id) => !(id in published.books)).length;
  const entry = { version, name, size, sha256, created: new Date().toISOString(), added, updated: d.put.length - added, removed: d.del.length, global: d.global };

  const next = { ...manifest, version, base: Number(manifest.base) || 0, updates: [...(manifest.updates || []).filter((u) => u.version < version), entry] };
  next.latest = { books: Object.keys(current.books).length, version, at: entry.created };
  const result = { changed: true, ...entry, ...counts };
  if (dryRun) return { ...result, dryRun: true, file: gz };

  log(`رفع ${name} (${(size / 1024 / 1024).toFixed(1)} م.ب)`);
  upload(gz);
  fs.writeFileSync(local('library.json'), JSON.stringify(next, null, 1));
  upload(local('library.json'));
  fs.writeFileSync(stateFile, JSON.stringify({ version, ...current }));
  upload(stateFile);
  setInstalledVersion(libDir, version);
  fs.rmSync(gz, { force: true });
  return result;
}
