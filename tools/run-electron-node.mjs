// Runs a script with Electron's bundled Node.js (same SQLite build as the app), on any OS.
//   node tools/run-electron-node.mjs <script> [args…]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron'); // path to the Electron binary
const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
