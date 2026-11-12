// Keeps the app itself up to date from the project's GitHub releases.
//
// Windows (x64 and ARM installers) and Linux AppImage: electron-updater checks quietly, downloads
// the installer for this machine's architecture in the background, and installs it when the user
// restarts (or quits) the app. macOS cannot replace an unsigned app and the .deb package has no
// self-install path here, so those builds only announce the new version and open the download page.
import { app, net, shell } from 'electron';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;
const OWNER = '8u9i';
const REPO = 'ibadi-encyclopedia';
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;
const TEST_FEED = process.env.IBADI_APP_UPDATE_URL || null; // testing: a local folder served over HTTP

/** "2.10.0" > "2.9.1"; pre-release suffixes are ignored. */
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export class AppUpdater {
  constructor({ settings, send }) {
    this.settings = settings;
    this.send = send;
    this.timer = null;
    this.mode = this.pickMode();
    this.state = { mode: this.mode, current: app.getVersion(), status: 'idle', version: null, percent: 0, error: null };
    if (this.mode === 'auto') this.wireAutoUpdater();
  }

  pickMode() {
    if (!app.isPackaged && !TEST_FEED) return 'off';
    if (process.platform === 'win32') return 'auto';
    if (process.platform === 'linux' && process.env.APPIMAGE) return 'auto';
    return 'notify';
  }

  status() {
    return { ...this.state, auto: this.settings.get('autoAppUpdate', true), checkedAt: this.settings.get('appUpdateCheckedAt', null) };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.send(this.status());
  }

  start() {
    if (this.mode === 'off') return;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(false), CHECK_MS);
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  wireAutoUpdater() {
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false; // started explicitly, so the setting is honoured
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    if (TEST_FEED) {
      autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED });
      autoUpdater.forceDevUpdateConfig = !app.isPackaged;
    }
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e) }));
  }

  /** forced: the user pressed "check now" (shows errors, downloads even when automatic is off). */
  async check(forced) {
    if (this.mode === 'off' || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.status();
    this.settings.set('appUpdateCheckedAt', Date.now());
    if (this.mode === 'auto') {
      try {
        const r = await autoUpdater.checkForUpdates();
        const v = r?.updateInfo?.version;
        if (v && newer(v, app.getVersion()) && (forced || this.settings.get('autoAppUpdate', true))) {
          this.set({ status: 'downloading', version: v, percent: 0 });
          await autoUpdater.downloadUpdate();
        }
      } catch (e) {
        this.set({ status: 'error', error: friendly(e) });
      }
      return this.status();
    }
    // notify mode: ask GitHub which version is the latest release
    this.set({ status: 'checking', error: null });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = await res.json();
      const v = String(rel.tag_name || '').replace(/^v/, '');
      this.set(v && newer(v, app.getVersion()) ? { status: 'available', version: v } : { status: 'none' });
    } catch (e) {
      this.set({ status: forced ? 'error' : 'idle', error: forced ? friendly(e) : null });
    }
    return this.status();
  }

  /** Restart now and install the downloaded version. */
  install() {
    if (this.mode !== 'auto' || this.state.status !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }

  openDownloadPage() {
    shell.openExternal(RELEASES_PAGE);
  }
}

function friendly(e) {
  const msg = String(e?.message || e || '');
  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT|HTTP 5|getaddrinfo/i.test(msg)) return 'تعذّر الوصول إلى خادم التحديثات. تحقّق من الاتصال بالإنترنت.';
  if (/sha512|checksum/i.test(msg)) return 'تلف ملف التحديث أثناء التنزيل؛ سيُعاد تنزيله في المحاولة التالية.';
  return 'تعذّر تحديث البرنامج: ' + msg.split('\n')[0].slice(0, 160);
}
