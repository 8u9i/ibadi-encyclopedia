// Heavy library-update work off the main thread: applying downloaded packs, or publishing.
import { parentPort, workerData } from 'node:worker_threads';
import { applyPack } from '../shared/library-pack.js';
import { publish } from '../shared/publish.js';

const post = (m) => parentPort.postMessage(m);

async function run() {
  const { task } = workerData;
  if (task === 'apply') {
    const { libDir, packs } = workerData;
    const out = { added: new Set(), updated: new Set(), removed: new Set(), version: null };
    for (let i = 0; i < packs.length; i++) {
      const p = packs[i];
      const prefix = packs.length > 1 ? `التحديث ${i + 1} من ${packs.length}: ` : '';
      const r = applyPack(libDir, p.file, (message, ratio) => post({ type: 'progress', phase: 'apply', message: prefix + message, ratio: (i + (ratio ?? 0)) / packs.length }));
      if (!r) continue;
      out.version = r.version;
      for (const id of r.removed) {
        out.added.delete(id);
        out.updated.delete(id);
        out.removed.add(id);
      }
      for (const id of r.added) out.added.add(id);
      for (const id of r.updated) if (!out.added.has(id)) out.updated.add(id);
    }
    return { version: out.version, added: [...out.added], updated: [...out.updated], removed: [...out.removed] };
  }
  if (task === 'publish') {
    const { libDir, workDir, repo, tag, gh } = workerData;
    return publish({ libDir, workDir, repo, tag, gh, log: (message) => post({ type: 'progress', phase: 'publish', message }) });
  }
  throw new Error('unknown task ' + task);
}

run()
  .then((report) => post({ type: 'done', report }))
  .catch((e) => post({ type: 'error', message: String(e?.message || e) }));
