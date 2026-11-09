// Renders build/icon.png (1024×1024) from the app logo. electron-builder derives .ico/.icns from it.
//   electron tools/make-icon.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
const S = 1024;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 48 48">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14876e"/><stop offset="1" stop-color="#0a4d3f"/></linearGradient></defs>
  <rect x="2" y="2" width="44" height="44" rx="10" fill="url(#g)"/>
  <g transform="translate(24 24) scale(.82) translate(-24 -22.5)" fill="none" stroke="#fff" stroke-linejoin="round">
    <path stroke-width="2.2" d="M24 4 29 10.5 37 9.5 36 17.5 42.5 22.5 36 27.5 37 35.5 29 34.5 24 41 19 34.5 11 35.5 12 27.5 5.5 22.5 12 17.5 11 9.5 19 10.5Z"/>
    <path stroke-width="2" d="M24 15.5c-2.3-1.7-5.2-2.2-8.5-2v14.5c3.3-.2 6.2.3 8.5 2 2.3-1.7 5.2-2.2 8.5-2V13.5c-3.3-.2-6.2.3-8.5 2Zm0 0V30"/>
  </g></svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: S, height: S, show: false, transparent: true, backgroundColor: '#00000000', frame: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  win.setContentSize(S, S);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  const { width, height } = img.getSize();
  if (width !== height) throw new Error(`capture is not square: ${width}x${height}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, (width === S ? img : img.resize({ width: S, height: S })).toPNG());
  console.log('wrote', out, img.getSize());
  app.exit(0);
});
