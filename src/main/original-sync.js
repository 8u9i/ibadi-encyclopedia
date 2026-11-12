// Keeps the library in step with an installed copy of the original Ibadi Encyclopedia: when the
// original app downloads new or updated books, they are imported here automatically.
import { app, nativeImage } from 'electron';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 60 * 1000;

export function isOriginalRoot(dir) {
  try {
    return !!dir && fs.statSync(path.join(dir, 'database', 'master.db')).isFile() && fs.statSync(path.join(dir, 'database', 'store', 'page')).isDirectory();
  } catch {
    return false;
  }
}

/** Accepts the install folder or its "database" subfolder. */
export function normalizeOriginalRoot(dir) {
  if (isOriginalRoot(dir)) return dir;
  if (dir && path.basename(dir).toLowerCase() === 'database' && isOriginalRoot(path.dirname(dir))) return path.dirname(dir);
  return null;
}

export class OriginalSync {
  constructor({ settings, getLibraryPath, send, onLibraryChanged, javaDir, workerFile, isBlocked = () => false }) {
    this.settings = settings;
    this.getLibraryPath = getLibraryPath;
    this.send = send;
    this.onLibraryChanged = onLibraryChanged;
    this.javaDir = javaDir;
    this.workerFile = workerFile;
    this.isBlocked = isBlocked;
    this.running = false;
    this.progress = null;
    this.lastSeen = null;
    this.timer = null;
    this.error = null;
  }

  // ---------------------------------------------------------------- discovery
  root() {
    const saved = this.settings.get('originalPath');
    if (isOriginalRoot(saved)) return saved;
    const candidates = [];
    if (process.platform === 'win32') for (const d of 'CDEFGHIJ') candidates.push(`${d}:\\ibadi`);
    candidates.push(path.join(app.getPath('home'), 'ibadi'));
    return candidates.find(isOriginalRoot) || null;
  }

  /**
   * Finds the install folder of a running original app (ibadi.exe sits at the install root and in
   * app\win\64\bin). Only used while no install is known; the result is remembered.
   */
  findRunning() {
    if (process.platform !== 'win32') return null;
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='ibadi.exe'\" | ForEach-Object { $_.ExecutablePath }"],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    for (const exe of (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      let dir = path.dirname(exe);
      for (let i = 0; i < 6 && dir; i++) {
        if (isOriginalRoot(dir)) {
          this.settings.set('originalPath', dir);
          return dir;
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    return null;
  }

  java(root) {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    // The original ships its own Java 21 runtime in numbered build folders; use the newest.
    const jreBase = root && path.join(root, 'app', 'win', '64', 'jre');
    if (jreBase && fs.existsSync(jreBase)) {
      const builds = fs.readdirSync(jreBase).filter((n) => /^\d+$/.test(n)).sort((a, b) => b - a);
      for (const b of builds) {
        const p = path.join(jreBase, b, 'bin', exe);
        if (fs.existsSync(p)) return p;
      }
    }
    if (process.env.JAVA_HOME) {
      const p = path.join(process.env.JAVA_HOME, 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
    const r = spawnSync('java', ['-version'], { windowsHide: true });
    return r.status === 0 ? 'java' : null;
  }

  classPath() {
    const jars = fs.existsSync(this.javaDir) ? fs.readdirSync(this.javaDir).filter((f) => f.endsWith('.jar')) : [];
    return [this.javaDir, ...jars.map((j) => path.join(this.javaDir, j))].join(path.delimiter);
  }

  /** Changes whenever the original commits new data: master.db and the Lucene commit generation. */
  signature(root) {
    try {
      const st = fs.statSync(path.join(root, 'database', 'master.db'));
      const seg = fs.readdirSync(path.join(root, 'database', 'store', 'page')).filter((f) => f.startsWith('segments_')).sort().join(',');
      return `${st.size}:${Math.round(st.mtimeMs)}:${seg}`;
    } catch {
      return null;
    }
  }

  status() {
    const root = this.root();
    const sig = root ? this.signature(root) : null;
    return {
      root,
      auto: this.settings.get('autoSync', true),
      java: root ? !!this.java(root) : null,
      running: this.running,
      progress: this.progress,
      error: this.error,
      last: this.settings.get('lastSync', null),
      changed: !!(sig && sig !== this.settings.get('syncSignature')),
    };
  }

  // ---------------------------------------------------------------- scheduling
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(false), POLL_MS);
    setTimeout(() => this.check(false), 8000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs when the original's data changed and has been stable for one poll interval. */
  check(force) {
    if (this.running || !this.getLibraryPath() || this.isBlocked()) return;
    if (!force && !this.settings.get('autoSync', true)) return;
    const root = this.root() || this.findRunning();
    if (!root) return;
    const sig = this.signature(root);
    if (!sig) return;
    if (!force) {
      if (sig === this.settings.get('syncSignature')) return;
      if (sig !== this.lastSeen) {
        // first sighting: the original may still be writing, so wait for the next poll
        this.lastSeen = sig;
        return;
      }
    }
    this.run(root, sig);
  }

  // ---------------------------------------------------------------- run
  run(root, sig) {
    const java = this.java(root);
    if (!java) {
      this.fail('لم يُعثر على Java. يحتاج التحديث إلى مجلّد jre الموجود في البرنامج الأصلي.');
      return;
    }
    this.running = true;
    this.error = null;
    this.emit({ phase: 'start', message: 'بدء التحديث من البرنامج الأصلي' });
    const worker = new Worker(this.workerFile, {
      workerData: {
        libraryPath: this.getLibraryPath(),
        originalRoot: root,
        java,
        classPath: this.classPath(),
        tmpDir: path.join(app.getPath('temp'), `ibadi-sync-${process.pid}`),
      },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    worker.on('message', async (m) => {
      if (m.type === 'progress') this.emit(m);
      else if (m.type === 'error') this.fail(m.message);
      else if (m.type === 'done') {
        try {
          const covers = await this.importCovers(root, m.report.coverIds || []);
          m.report.covers = covers;
          this.settings.set('syncSignature', sig);
          this.settings.set('lastSync', {
            at: Date.now(),
            added: m.report.added.length,
            updated: m.report.updated.length,
            removed: m.report.removed.length,
            pending: (m.report.pending || []).length,
          });
          this.running = false;
          this.progress = null;
          await this.onLibraryChanged(m.report);
          this.emit({ phase: 'done', report: { ...m.report, coverIds: undefined } });
        } catch (e) {
          this.fail(String(e.message || e));
        }
      }
    });
    worker.on('error', (e) => this.fail(String(e.message || e)));
    worker.on('exit', (code) => {
      if (this.running && code !== 0) this.fail(`توقّف التحديث (رمز ${code})`);
    });
  }

  fail(message) {
    const friendly = /readonly|read-only|SQLITE_READONLY|EACCES|EPERM/i.test(message)
      ? 'مجلّد المكتبة للقراءة فقط؛ انقله إلى مكان قابل للكتابة لتفعيل التحديث.'
      : message;
    this.running = false;
    this.progress = null;
    this.error = friendly;
    this.emit({ phase: 'error', message: friendly });
  }

  emit(e) {
    if (e.phase && e.phase !== 'done' && e.phase !== 'error') this.progress = e;
    this.send(e);
  }

  /** Copies covers of new or updated books from the original, resized like the build tool does. */
  async importCovers(root, ids) {
    const src = path.join(root, 'database', 'cover.db');
    const lib = this.getLibraryPath();
    if (!ids.length || !fs.existsSync(src)) return 0;
    this.emit({ phase: 'covers', message: 'تحديث الأغلفة' });
    const from = new DatabaseSync(src, { readOnly: true, timeout: 10000 });
    const to = new DatabaseSync(path.join(lib, 'covers.db'), { timeout: 15000 });
    to.exec('CREATE TABLE IF NOT EXISTS cover (id INTEGER PRIMARY KEY, thumb BLOB NOT NULL, full BLOB NOT NULL, w INTEGER, h INTEGER)');
    const get = from.prepare('SELECT cover FROM cover WHERE id = ?');
    const put = to.prepare('INSERT OR REPLACE INTO cover VALUES (?,?,?,?,?)');
    const done = [];
    for (const id of ids) {
      const r = get.get(id);
      if (!r?.cover) continue;
      const img = nativeImage.createFromBuffer(Buffer.from(r.cover));
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      const thumb = img.resize({ width: 240, quality: 'better' }).toJPEG(80);
      const full = height > 1400 ? img.resize({ height: 1400, quality: 'best' }).toJPEG(84) : Buffer.from(r.cover);
      put.run(id, thumb, full, width, height);
      done.push(id);
      await new Promise((res) => setImmediate(res)); // keep the main process responsive
    }
    from.close();
    to.close();
    if (done.length) {
      const db = new DatabaseSync(path.join(lib, 'ibadi.db'), { timeout: 15000 });
      const mark = db.prepare('UPDATE book SET has_cover = 1 WHERE id = ?');
      db.exec('BEGIN');
      for (const id of done) mark.run(id);
      db.exec('COMMIT');
      db.close();
    }
    return done.length;
  }
}
