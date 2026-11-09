import fs from 'node:fs';
import path from 'node:path';

/** Small JSON settings store with debounced, atomic writes. */
export class Settings {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      this.data = {};
    }
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  all() {
    return structuredClone(this.data);
  }

  set(key, value) {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('settings write failed', e);
    }
  }
}
