// Minimal Chrome DevTools Protocol driver used for manual UI verification during development.
//   node tools/cdp.mjs <port> <script.json>
// script.json: [{ "eval": "js" } | { "shot": "file.png" } | { "wait": ms } | { "key": "ArrowLeft" }]
import fs from 'node:fs';

const [port, scriptFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('app://ui'));
if (!page) throw new Error('app page not found: ' + JSON.stringify(targets.map((t) => t.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waiting = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  } else if (m.method === 'Log.entryAdded') {
    logs.push(`[log.${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url || ''}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    waiting.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send('Runtime.enable');
await send('Log.enable');
for (const s of steps) {
  if (s.eval) {
    const r = await send('Runtime.evaluate', { expression: s.eval, awaitPromise: true, returnByValue: true });
    const v = r.result?.result;
    console.log('eval>', r.result?.exceptionDetails ? 'EXCEPTION ' + r.result.exceptionDetails.exception?.description : JSON.stringify(v?.value ?? v?.description));
  } else if (s.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(s.shot, Buffer.from(r.result.data, 'base64'));
    console.log('shot>', s.shot);
  } else if (s.cmd) {
    const r = await send(s.cmd, s.params || {});
    if (r.error) console.log('cmd>', s.cmd, 'ERROR', r.error.message);
  } else if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
  else if (s.key) {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: s.key, code: s.key, windowsVirtualKeyCode: s.vk || 0, modifiers: s.mod || 0 });
  }
}
console.log(logs.length ? logs.join('\n') : '(no console errors)');
ws.close();
process.exit(0);
