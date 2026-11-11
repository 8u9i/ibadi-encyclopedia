// Keeps an installed library up to date with the published one: reads library.json from the
// release, downloads the update packs newer than the installed version, verifies them and applies
// them in a worker thread. Also runs the optional publisher (for whoever maintains the release).
import { app, net } from 'electron';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { canPublishAsync, DEFAULT_REPO, DEFAULT_TAG } from '../shared/publish.js';

const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class LibraryUpdater {
  constructor({ settings, baseUrl, publishTag = DEFAULT_TAG, getLibraryPath, send, onLibraryChanged, workerFile, isBlocked = () => false }) {
    this.publishTag = publishTag;
    this.settings = settings;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.getLibraryPath = getLibraryPath;
    this.send = send;
    this.onLibraryChanged = onLibraryChanged;
    this.workerFile = workerFile;
    this.isBlocked = isBlocked;
    this.running = null; // 'update' | 'publish' | null
    this.progress = null;
    this.error = null;
    this.remote = null; // last manifest summary
    this.publisher = null; // null = not checked yet
    this.publishError = null;
    this.timer = null;
  }

  // ---------------------------------------------------------------- state
  installed() {
    const lib = this.getLibraryPath();
    if (!lib) return null;
    try {
      const db = new DatabaseSync(path.join(lib, 'ibadi.db'), { readOnly: true, timeout: 5000 });
      try {
        const r = db.prepare("SELECT value FROM info WHERE key = 'library_version'").get();
        return r ? Number(r.value) || 0 : 0;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  pending(installed = this.installed()) {
    if (!this.remote || installed == null) return [];
    return this.remote.updates.filter((u) => u.version > installed);
  }

  status() {
    const installed = this.installed();
    const pending = this.pending(installed);
    return {
      installed,
      latest: this.remote?.version ?? null,
      pending: { count: pending.length, added: sum(pending, 'added'), updated: sum(pending, 'updated'), removed: sum(pending, 'removed'), size: sum(pending, 'size') },
      auto: this.settings.get('autoUpdate', true),
      running: this.running === 'update',
      progress: this.running === 'update' ? this.progress : null,
      error: this.error,
      lastCheck: this.settings.get('updateCheckedAt', null),
      last: this.settings.get('lastUpdate', null),
      publisher: this.publisher
        ? {
            auto: this.settings.get('autoPublish', false),
            running: this.running === 'publish',
            progress: this.running === 'publish' ? this.progress : null,
            error: this.publishError,
            last: this.settings.get('lastPublish', null),
          }
        : null,
    };
  }

  // ---------------------------------------------------------------- scheduling
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(false), CHECK_MS);
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
    // Publishing is offered only where the GitHub CLI is logged in with write access.
    setTimeout(async () => {
      this.publisher = await canPublishAsync({ repo: this.settings.get('publishRepo', DEFAULT_REPO) });
      if (this.publisher) this.emit({ phase: 'status' });
    }, 5000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async fetchManifest() {
    const res = await net.fetch(this.baseUrl + 'library.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`تعذّر الوصول إلى خادم التحديثات (${res.status})`);
    const m = await res.json();
    const updates = (Array.isArray(m.updates) ? m.updates : [])
      .filter((u) => Number.isInteger(u.version) && SAFE_NAME.test(u.name) && /^[0-9a-f]{64}$/.test(u.sha256) && u.size > 0)
      .sort((a, b) => a.version - b.version);
    return { version: Number(m.version) || 0, base: Number(m.base) || 0, updates };
  }

  /** Checks for new packs; applies them when automatic updates are on or when forced. */
  async check(force) {
    if (this.running || !this.getLibraryPath()) return this.status();
    if (!force && this.isBlocked()) return this.status();
    try {
      this.remote = await this.fetchManifest();
      this.settings.set('updateCheckedAt', Date.now());
      if (force) this.error = null;
    } catch (e) {
      if (force) {
        this.error = 'تعذّر التحقّق من التحديثات. تأكّد من الاتصال بالإنترنت.';
        this.emit({ phase: 'error', message: this.error });
      }
      return this.status();
    }
    const installed = this.installed();
    const pending = this.pending(installed);
    this.emit({ phase: 'status' });
    if (!pending.length) return this.status();
    // The packs must continue from the installed version; otherwise only a full download helps.
    if (pending[0].version > installed + 1) {
      this.error = 'مكتبتك أقدم من أن تُحدَّث بالحزم الصغيرة؛ نزّل المكتبة كاملة من جديد.';
      this.emit({ phase: 'error', message: this.error });
      return this.status();
    }
    if (force || this.settings.get('autoUpdate', true)) await this.apply(pending);
    return this.status();
  }

  async apply(pending) {
    if (this.isBlocked()) {
      this.error = 'يجري الآن تحديث آخر للمكتبة؛ أعد المحاولة بعد قليل.';
      this.emit({ phase: 'error', message: this.error });
      return;
    }
    const lib = this.getLibraryPath();
    this.running = 'update';
    this.error = null;
    const tmp = path.join(app.getPath('temp'), `ibadi-update-${process.pid}`);
    try {
      fs.accessSync(lib, fs.constants.W_OK);
      fs.mkdirSync(tmp, { recursive: true });
      const total = sum(pending, 'size');
      let got = 0;
      const packs = [];
      for (const u of pending) {
        this.emit({ phase: 'download', message: `تنزيل تحديث المكتبة (${fmtMB(total)})`, ratio: got / total });
        const gz = path.join(tmp, u.name);
        const res = await net.fetch(this.baseUrl + u.name, { cache: 'no-store' });
        if (!res.ok) throw new Error(`فشل تنزيل التحديث ${u.version} (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== u.size || createHash('sha256').update(buf).digest('hex') !== u.sha256) throw new Error(`تلف ملف التحديث ${u.version} أثناء التنزيل؛ أعد المحاولة`);
        got += u.size;
        fs.writeFileSync(gz, buf);
        const file = path.join(tmp, `update-${u.version}.db`);
        await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(file));
        fs.rmSync(gz, { force: true });
        packs.push({ version: u.version, file });
      }
      this.emit({ phase: 'apply', message: 'تطبيق التحديث على المكتبة', ratio: 0 });
      const report = await this.runWorker({ task: 'apply', libDir: lib, packs });
      const last = { at: Date.now(), version: report.version, added: report.added.length, updated: report.updated.length, removed: report.removed.length };
      this.settings.set('lastUpdate', last);
      this.running = null;
      this.progress = null;
      await this.onLibraryChanged({ ...report, source: 'update' });
      this.emit({ phase: 'done', report: last });
    } catch (e) {
      this.running = null;
      this.progress = null;
      const msg = String(e?.message || e);
      this.error = /readonly|read-only|SQLITE_READONLY|EACCES|EPERM/i.test(msg) ? 'مجلّد المكتبة للقراءة فقط؛ انقله إلى مكان قابل للكتابة لتفعيل التحديث.' : msg;
      this.emit({ phase: 'error', message: this.error });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- publishing
  /** Publishes local changes as a new pack. Only offered when gh can write to the release. */
  async publish() {
    if (!this.publisher || this.running || this.isBlocked()) return this.status();
    this.running = 'publish';
    this.publishError = null;
    const workDir = path.join(app.getPath('temp'), `ibadi-publish-${process.pid}`);
    try {
      this.emit({ phase: 'publish', message: 'نشر التحديث' });
      const r = await this.runWorker({ task: 'publish', libDir: this.getLibraryPath(), workDir, repo: this.settings.get('publishRepo', DEFAULT_REPO), tag: this.publishTag, gh: 'gh' });
      this.settings.set('lastPublish', { at: Date.now(), changed: !!r.changed, version: r.version, added: r.added || 0, updated: r.updated || 0, removed: r.removed || 0, size: r.size || 0 });
      this.running = null;
      this.progress = null;
      this.emit({ phase: 'published', report: r });
    } catch (e) {
      this.running = null;
      this.progress = null;
      this.publishError = String(e?.message || e);
      this.emit({ phase: 'error', message: 'تعذّر النشر: ' + this.publishError, publish: true });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    return this.status();
  }

  // ---------------------------------------------------------------- plumbing
  runWorker(data) {
    return new Promise((resolve, reject) => {
      const w = new Worker(this.workerFile, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
      let settled = false;
      w.on('message', (m) => {
        if (m.type === 'progress') this.emit(m);
        else if (m.type === 'done') {
          settled = true;
          resolve(m.report);
        } else if (m.type === 'error') {
          settled = true;
          reject(new Error(m.message));
        }
      });
      w.on('error', (e) => {
        settled = true;
        reject(e);
      });
      w.on('exit', (code) => {
        if (!settled) reject(new Error(`توقّف التحديث (رمز ${code})`));
      });
    });
  }

  emit(e) {
    if (e.phase && !['done', 'error', 'status', 'published'].includes(e.phase)) this.progress = e;
    this.send(e);
  }
}

function sum(list, key) {
  return list.reduce((a, u) => a + (Number(u[key]) || 0), 0);
}

function fmtMB(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb < 1 ? `${Math.max(1, Math.round(bytes / 1024))} ك.ب` : `${mb.toFixed(1)} م.ب`;
}
