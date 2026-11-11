// Publishes the books that changed in a local library as an update pack, so every installed copy
// of the app picks them up. Needs the GitHub CLI (gh), logged in with write access to the repo.
//
//   npm run publish-update -- --lib "D:\path\to\library"            publish changes
//   npm run publish-update -- --lib "D:\path\to\library" --dry-run  build the pack, upload nothing
//   npm run publish-update -- --lib "D:\path\to\library" --init     record this library as the
//                                                                   published state (first time only;
//                                                                   it must match the published files)
import os from 'node:os';
import path from 'node:path';
import { publish, DEFAULT_REPO, DEFAULT_TAG } from '../src/shared/publish.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes('--' + k);
const lib = arg('lib');
if (!lib) {
  console.error('usage: publish-update --lib <library dir> [--repo owner/name] [--tag library] [--dry-run] [--init]');
  process.exit(2);
}
const t0 = Date.now();
try {
  const r = await publish({
    libDir: path.resolve(lib),
    workDir: path.join(os.tmpdir(), `ibadi-publish-${process.pid}`),
    repo: arg('repo', DEFAULT_REPO),
    tag: arg('tag', DEFAULT_TAG),
    init: flag('init'),
    dryRun: flag('dry-run'),
    log: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`),
  });
  console.log(JSON.stringify(r, null, 1));
} catch (e) {
  console.error('failed:', e.message || e);
  process.exit(1);
}
