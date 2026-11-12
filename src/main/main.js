import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell, clipboard } from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Settings } from './settings.js';
import { OriginalSync, normalizeOriginalRoot } from './original-sync.js';
import { LibraryDownloader } from './library-download.js';
import { LibraryUpdater } from './library-update.js';

// Published library (release assets of this project). Overridable for testing.
const LIBRARY_URL = process.env.IBADI_LIBRARY_URL || 'https://github.com/8u9i/ibadi-encyclopedia/releases/download/library/';

/** Where a downloaded library goes: local (not roaming or cloud-synced) app data. */
function defaultLibraryDir() {
  if (process.env.IBADI_DOWNLOAD_DIR) return process.env.IBADI_DOWNLOAD_DIR; // testing
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Ibadi Encyclopedia', 'library');
  return path.join(app.getPath('userData'), 'library');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..'); // …/src
const RENDERER = path.join(SRC, 'renderer');
const SHARED = path.join(SRC, 'shared');
const APP_ORIGIN = 'app://ui';

// ------------------------------------------------------------------ process-level setup
app.setName('Ibadi Encyclopedia');
if (process.platform === 'win32') app.setAppUserModelId('net.ibadi.encyclopedia');
if (!app.requestSingleInstanceLock()) app.exit(0);

// Keep memory low: one renderer, no spare renderer process, no unused Chromium services.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,Translate,AutofillServerCommunication');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
// A text reader gains little from GPU compositing, while the GPU process costs ~150 MB of RAM.
// Users can turn acceleration back on in Settings (takes effect after a restart).
if (!settings.get('hardwareAcceleration', false)) app.disableHardwareAcceleration();
let win = null;
let worker = null;
let sync = null;
let updater = null;
const downloader = new LibraryDownloader({ baseUrl: LIBRARY_URL, send: (ev) => win?.webContents.send('library-download', ev) });
let workerReady = null;
let libraryPath = null;

// ------------------------------------------------------------------ library location
function isLibrary(dir) {
  try {
    return !!dir && fs.statSync(path.join(dir, 'ibadi.db')).isFile();
  } catch {
    return false;
  }
}

function findLibrary() {
  if (process.env.IBADI_LIBRARY === 'none') return null; // testing the first-run screen
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [
    settings.get('libraryPath'),
    process.env.IBADI_LIBRARY,
    path.join(process.resourcesPath || '', 'library'),
    path.join(exeDir, 'library'),
    process.platform === 'darwin' ? path.join(exeDir, '..', '..', '..', 'library') : null, // next to the .app
    defaultLibraryDir(),
    path.join(app.getPath('userData'), 'library'),
    path.join(app.getPath('documents'), 'Ibadi', 'library'),
    app.isPackaged ? null : path.join(SRC, '..', '..', 'library'),
  ];
  return candidates.find(isLibrary) || null;
}

// ------------------------------------------------------------------ database worker
let seq = 0;
const pending = new Map();

function startWorker(dir) {
  stopWorker();
  libraryPath = dir;
  // The worker (and the shared module it imports) is unpacked from app.asar by the build config,
  // so worker_threads loads it from a real directory.
  const workerFile = path.join(__dirname, 'db-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  worker = new Worker(workerFile, {
    workerData: { libraryPath: dir, userDbPath: path.join(app.getPath('userData'), 'user.db') },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  workerReady = new Promise((resolve, reject) => {
    worker.once('message', (m) => (m && m.ready ? resolve(m.info) : reject(new Error(m?.error || 'worker failed'))));
    worker.once('error', reject);
  });
  worker.on('message', (m) => {
    if (!m || m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
  });
  worker.on('error', (e) => console.error('db worker error', e));
  worker.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error('db worker exited ' + code));
    pending.clear();
    worker = null;
  });
  return workerReady;
}

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  workerReady = null;
}

async function callWorker(method, args) {
  if (!worker) throw new Error('NO_LIBRARY');
  await workerReady;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

// ------------------------------------------------------------------ protocol: app://ui/… (UI files), app://cover/<id>
async function serveFile(root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
  const res = await net.fetch(pathToFileURL(file).toString());
  // UI files must never be served stale from Chromium's HTTP cache (e.g. after an update).
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(res.body, { status: res.status, headers });
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.host === 'ui') {
      if (rel.startsWith('shared/')) return serveFile(SHARED, rel.slice('shared/'.length));
      return serveFile(RENDERER, rel || 'index.html');
    }
    if (url.host === 'cover') {
      try {
        const data = await callWorker('cover', [Number(rel), url.searchParams.get('size') === 'full']);
        if (!data) return new Response(null, { status: 404 });
        return new Response(data, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000' } });
      } catch {
        return new Response(null, { status: 404 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

// ------------------------------------------------------------------ window
function themeBackground() {
  const t = settings.get('theme', 'auto');
  const dark = t === 'dark' || (t === 'auto' && nativeTheme.shouldUseDarkColors);
  return t === 'sepia' ? '#ebe0c8' : dark ? '#1b1814' : '#f3eee4';
}

function windowState() {
  if (!win || win.isDestroyed()) return null;
  return { maximized: win.isMaximized(), minimized: win.isMinimized(), fullscreen: win.isFullScreen(), focused: win.isFocused(), platform: process.platform };
}

function createWindow() {
  const b = settings.get('bounds', { width: 1280, height: 820 });
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    ...b,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'الموسوعة الإباضية',
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    // The app draws its own title bar. 'hidden' keeps the native frame behaviour (Windows 11 rounded
    // corners, shadow, edge resizing, snapping); macOS keeps its traffic lights inside our bar.
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: mac ? { x: 14, y: 13 } : undefined,
    icon: path.join(SRC, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
      v8CacheOptions: 'bypassHeatCheck',
    },
  });
  if (settings.get('maximized')) win.maximize();
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.set('maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) settings.set('bounds', win.getBounds());
  };
  win.on('resize', debounce(saveBounds, 500));
  win.on('move', debounce(saveBounds, 500));
  win.on('close', () => {
    saveBounds();
    settings.flush();
  });
  win.on('closed', () => (win = null));
  const pushState = () => win && !win.isDestroyed() && win.webContents.send('window-state', windowState());
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) win.on(ev, pushState);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  wc.on('context-menu', (_e, p) => buildContextMenu(p).popup({ window: win }));
  win.loadURL(APP_ORIGIN + '/index.html');
}

function openExternalSafe(url) {
  if (!URL.canParse(url)) return;
  const u = new URL(url);
  if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') shell.openExternal(u.toString());
}

function buildContextMenu(p) {
  const sel = (p.selectionText || '').trim();
  const send = (ch, ...a) => win?.webContents.send(ch, ...a);
  const items = [];
  if (p.isEditable) {
    items.push({ role: 'cut', label: 'قص' }, { role: 'copy', label: 'نسخ' }, { role: 'paste', label: 'لصق' }, { type: 'separator' }, { role: 'selectAll', label: 'تحديد الكل' });
  } else {
    if (sel) {
      items.push(
        { role: 'copy', label: 'نسخ' },
        { label: 'نسخ مع التوثيق', click: () => send('menu', 'copy-cite') },
        { type: 'separator' },
        { label: `البحث عن «${sel.length > 28 ? sel.slice(0, 28) + '…' : sel}» في المكتبة`, click: () => send('menu', 'search', sel) },
        { label: 'البحث في الكتاب الحالي', click: () => send('menu', 'search-book', sel) },
        { type: 'separator' },
      );
    }
    items.push({ role: 'selectAll', label: 'تحديد الكل' });
  }
  return Menu.buildFromTemplate(items);
}

function buildAppMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu', label: 'الموسوعة الإباضية' },
      { role: 'editMenu', label: 'تحرير' },
      {
        label: 'عرض',
        submenu: [{ role: 'togglefullscreen', label: 'ملء الشاشة' }, { role: 'reload', label: 'إعادة التحميل', visible: !app.isPackaged }],
      },
      { role: 'windowMenu', label: 'نافذة' },
    ]),
  );
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ------------------------------------------------------------------ IPC
const DB_METHODS = new Set([
  'info', 'categories', 'books', 'book', 'toc', 'page', 'pages', 'searchBook', 'search', 'searchTitles', 'quickFind',
  'authors', 'author', 'ayat', 'searchAyat', 'tafsir', 'pdfLink', 'roots',
  'userBookmarks', 'userAddBookmark', 'userUpdateBookmark', 'userDeleteBookmark', 'userPageBookmarks',
  'userHistory', 'userSavePosition', 'userGetPosition', 'userClearHistory',
  'userFavorites', 'userToggleFavorite', 'userIsFavorite', 'userSearchHistory', 'userAddSearch', 'userClearSearchHistory',
]);

const PROTECTED_SETTINGS = new Set([
  'libraryPath', 'bounds', 'maximized', 'originalPath', 'syncSignature', 'lastSync', 'autoSync',
  'autoUpdate', 'autoPublish', 'lastUpdate', 'lastPublish', 'updateCheckedAt', 'publishRepo',
]);

const unpacked = (file) => path.join(__dirname, file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function registerIpc() {
  ipcMain.handle('db', async (e, method, args) => {
    if (!isTrusted(e) || !DB_METHODS.has(method)) throw new Error('forbidden');
    return callWorker(method, Array.isArray(args) ? args : []);
  });
  ipcMain.handle('settings:all', (e) => (isTrusted(e) ? settings.all() : {}));
  ipcMain.handle('settings:set', (e, key, value) => {
    if (!isTrusted(e) || typeof key !== 'string' || PROTECTED_SETTINGS.has(key)) return false;
    if (key === 'hardwareAcceleration') value = !!value;
    settings.set(key, value);
    if (key === 'theme') win?.setBackgroundColor(themeBackground());
    return true;
  });
  ipcMain.handle('library:status', async (e) => {
    if (!isTrusted(e)) return null;
    if (!worker) return { ok: false, path: null };
    try {
      return { ok: true, path: libraryPath, info: await workerReady };
    } catch (err) {
      return { ok: false, path: libraryPath, error: String(err.message || err) };
    }
  });
  ipcMain.handle('library:choose', async (e) => {
    if (!isTrusted(e)) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر مجلّد المكتبة (الذي يحتوي ibadi.db)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    let dir = r.filePaths[0];
    if (!isLibrary(dir) && isLibrary(path.join(dir, 'library'))) dir = path.join(dir, 'library');
    if (!isLibrary(dir)) return { ok: false, error: 'لم يُعثر على الملف ibadi.db في هذا المجلّد.' };
    try {
      const info = await startWorker(dir);
      settings.set('libraryPath', dir);
      return { ok: true, path: dir, info };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('shell:open', (e, url) => {
    if (isTrusted(e)) openExternalSafe(url);
  });
  ipcMain.handle('clipboard:write', (e, text) => {
    if (isTrusted(e) && typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.handle('pdf:open', (e, url, title) => {
    if (!isTrusted(e)) return;
    openPdfWindow(url, title);
  });
  ipcMain.handle('library:remote', async (e) => {
    if (!isTrusted(e)) return null;
    try {
      const m = await downloader.manifest();
      return { ok: true, download: m.download, installed: m.installed, info: m.info || {}, target: defaultLibraryDir() };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('library:download', async (e, chooseFolder) => {
    if (!isTrusted(e)) return null;
    let target = defaultLibraryDir();
    if (chooseFolder) {
      const r = await dialog.showOpenDialog(win, { title: 'اختر مكان حفظ المكتبة', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      target = path.join(r.filePaths[0], 'Ibadi library');
    }
    try {
      const dir = await downloader.run(target);
      const info = await startWorker(dir);
      settings.set('libraryPath', dir);
      setTimeout(() => updater?.check(false), 3000); // books published since the full download
      return { ok: true, path: dir, info };
    } catch (err) {
      return { ok: false, error: String(err.message || err), paused: !!err.paused };
    }
  });
  ipcMain.handle('library:cancelDownload', (e) => {
    if (isTrusted(e)) downloader.cancel();
  });
  ipcMain.handle('sync:status', (e) => (isTrusted(e) && sync ? sync.status() : null));
  ipcMain.handle('sync:run', (e) => {
    if (isTrusted(e) && sync) sync.check(true);
    return sync?.status() ?? null;
  });
  ipcMain.handle('sync:auto', (e, on) => {
    if (!isTrusted(e)) return;
    settings.set('autoSync', !!on);
    if (on) sync?.check(false);
  });
  ipcMain.handle('sync:choose', async (e) => {
    if (!isTrusted(e)) return null;
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر مجلّد تثبيت البرنامج الأصلي (مثل C:\\ibadi)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const root = normalizeOriginalRoot(r.filePaths[0]);
    if (!root) return { ok: false, error: 'لم يُعثر في هذا المجلّد على بيانات البرنامج الأصلي (database\\master.db).' };
    settings.set('originalPath', root);
    sync?.check(true);
    return { ok: true, status: sync?.status() };
  });
  ipcMain.handle('update:status', (e) => (isTrusted(e) && updater ? updater.status() : null));
  ipcMain.handle('update:run', (e) => (isTrusted(e) && updater ? updater.check(true) : null));
  ipcMain.handle('update:auto', (e, on) => {
    if (!isTrusted(e)) return;
    settings.set('autoUpdate', !!on);
    if (on) updater?.check(false);
  });
  ipcMain.handle('update:autoPublish', (e, on) => {
    if (isTrusted(e) && updater?.publisher) settings.set('autoPublish', !!on);
  });
  ipcMain.handle('update:publish', (e) => (isTrusted(e) && updater ? updater.publish() : null));
  ipcMain.handle('window:state', (e) => (isTrusted(e) ? windowState() : null));
  ipcMain.handle('window:control', (e, action) => {
    if (!isTrusted(e) || !win || win.isDestroyed()) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isFullScreen()) win.setFullScreen(false);
      else if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });
  ipcMain.handle('app:info', (e) =>
    isTrusted(e) ? { version: app.getVersion(), electron: process.versions.electron, platform: process.platform } : null,
  );
}

function isTrusted(e) {
  try {
    // URL.origin is "null" for custom schemes, so compare protocol and host explicitly.
    const u = new URL(e.senderFrame.url);
    return u.protocol === 'app:' && u.host === 'ui';
  } catch {
    return false;
  }
}

function openPdfWindow(url, title) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'https:') return;
  const pdf = new BrowserWindow({
    width: 980,
    height: 900,
    title: title || 'المصوَّرة',
    autoHideMenuBar: true,
    backgroundColor: '#525659',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true, spellcheck: false },
  });
  pdf.webContents.setWindowOpenHandler(({ url: next }) => {
    openExternalSafe(next);
    return { action: 'deny' };
  });
  pdf.loadURL(u.toString());
}

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  registerProtocol();
  registerIpc();
  buildAppMenu();
  const dir = findLibrary();
  if (dir) startWorker(dir).catch((e) => console.error('library open failed', e));
  createWindow();
  sync = new OriginalSync({
    settings,
    getLibraryPath: () => libraryPath,
    send: (ev) => win?.webContents.send('sync-event', ev),
    onLibraryChanged: async (report) => {
      await callWorker('reload', []).catch(() => {});
      win?.webContents.send('library-changed', { added: report.added, updated: report.updated, removed: report.removed, source: 'original' });
      // The maintainer's copy can pass the new books straight on to everyone.
      const changed = report.added.length + report.updated.length + report.removed.length;
      if (changed && settings.get('autoPublish', false) && updater?.publisher) updater.publish();
    },
    isBlocked: () => !!updater?.running,
    javaDir: app.isPackaged ? path.join(process.resourcesPath, 'java') : path.join(SRC, '..', 'vendor', 'java'),
    workerFile: unpacked('sync-worker.js'),
  });
  updater = new LibraryUpdater({
    settings,
    baseUrl: LIBRARY_URL,
    publishTag: process.env.IBADI_PUBLISH_TAG || 'library', // testing
    getLibraryPath: () => libraryPath,
    send: (ev) => win?.webContents.send('update-event', ev),
    onLibraryChanged: async (report) => {
      await callWorker('reload', []).catch(() => {});
      win?.webContents.send('library-changed', { added: report.added, updated: report.updated, removed: report.removed, source: 'update' });
    },
    isBlocked: () => !!sync?.running,
    workerFile: unpacked('update-worker.js'),
  });
  sync.start();
  updater.start();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  settings.flush();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sync?.stop();
  updater?.stop();
  settings.flush();
  stopWorker();
});

// Harden every web contents created by the app.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
