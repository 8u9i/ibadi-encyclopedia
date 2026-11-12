import { h, icon, clear, modal, toast, coverEl, debounce, setDigitStyle, deathLabel, logo, fillIcons, num, digits } from './dom.js';
import { LibraryView } from './views/library.js';
import { SearchView } from './views/search.js';
import { QuranView } from './views/quran.js';
import { AuthorsView } from './views/authors.js';
import { SavedView } from './views/saved.js';
import { SettingsView } from './views/settings.js';
import { ReaderView } from './views/reader.js';
import { showBookInfo } from './views/bookinfo.js';

const api = window.ibadi;

export const DEFAULTS = {
  theme: 'auto',
  readFont: 'Amiri',
  readSize: 22,
  readLeading: 2,
  readWidth: 860,
  arabicDigits: true,
  readerMode: 'single',
  libraryView: 'grid',
  librarySort: 'name',
};

const FONT_STACKS = {
  Amiri: "'Amiri', 'Noto Naskh Arabic', serif",
  'Noto Naskh Arabic': "'Noto Naskh Arabic', 'Amiri', serif",
  system: "'Traditional Arabic', 'Simplified Arabic', 'Segoe UI', 'Geeza Pro', 'Noto Naskh Arabic', serif",
};

const SECTIONS = [
  { id: 'library', label: 'المكتبة', icon: 'library', View: LibraryView },
  { id: 'search', label: 'البحث', icon: 'search', View: SearchView },
  { id: 'quran', label: 'القرآن', icon: 'quran', View: QuranView },
  { id: 'authors', label: 'المؤلفون', icon: 'users', View: AuthorsView },
  { id: 'saved', label: 'المحفوظات', icon: 'bookmark', View: SavedView },
  { id: 'settings', label: 'الإعدادات', icon: 'settings', View: SettingsView },
];

/**
 * Caption-button glyphs. On Windows these come from the system's own icon font (Segoe Fluent Icons
 * on Windows 11, Segoe MDL2 Assets on Windows 10), so they match every other window exactly.
 * Elsewhere, SVGs drawn on the same 10px grid with the same rounded corners stand in.
 */
function captionGlyphs() {
  const CODES = { min: '', max: '', restore: '', close: '' };
  const font = ['Segoe Fluent Icons', 'Segoe MDL2 Assets'].find((name) => {
    // A missing font falls back to monospace, so a different width means the font is installed.
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '20px monospace';
    const fallback = ctx.measureText(CODES.close).width;
    ctx.font = `20px '${name}', monospace`;
    return ctx.measureText(CODES.close).width !== fallback;
  });
  if (font) {
    return (kind) => h('span', { class: 'wc-glyph', 'aria-hidden': 'true', style: { fontFamily: `'${font}'` }, text: CODES[kind] });
  }
  const PATHS = {
    min: 'M0.5 5h9',
    max: 'M2 .5h6A1.5 1.5 0 0 1 9.5 2v6A1.5 1.5 0 0 1 8 9.5H2A1.5 1.5 0 0 1 .5 8V2A1.5 1.5 0 0 1 2 .5Z',
    restore: 'M1.75 2.5h5A1.25 1.25 0 0 1 8 3.75v4.5A1.25 1.25 0 0 1 6.75 9.5h-5A1.25 1.25 0 0 1 .5 8.25v-4.5A1.25 1.25 0 0 1 1.75 2.5ZM2.5 2.5v-.25A1.75 1.75 0 0 1 4.25.5h3.5A1.75 1.75 0 0 1 9.5 2.25v3.5A1.75 1.75 0 0 1 7.75 7.5H8',
    close: 'M.75.75l8.5 8.5M9.25.75l-8.5 8.5',
  };
  return (kind) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', PATHS[kind]);
    svg.append(p);
    return svg;
  };
}

class App {
  constructor() {
    this.settings = { ...DEFAULTS };
    this.sections = new Map();
    this.section = null;
    this.tabs = []; // book tabs: { id, bookId, title, view, el }
    this.active = 'section';
    this.books = null;
    this.bookMap = new Map();
    this.categories = [];
    this.favorites = new Set();
    this.views = document.getElementById('views');
    this.tabsEl = document.getElementById('tabs');
    this.sectionsEl = document.getElementById('sections');
    this.media = matchMedia('(prefers-color-scheme: dark)');
    this.media.addEventListener('change', () => this.applySettings());
  }

  async start() {
    fillIcons();
    const stored = await api.settings.all();
    this.settings = { ...DEFAULTS, ...stored };
    this.applySettings();
    this.buildTitlebar();
    this.bindKeys();
    api.onMenu((action, arg) => this.onMenu(action, arg));
    api.sync.onEvent((ev) => this.onSyncEvent(ev));
    api.sync.onLibraryChanged((ev) => this.onLibraryChanged(ev));
    api.update.onEvent((ev) => this.onUpdateEvent(ev));

    const status = await api.library.status();
    if (!status?.ok) {
      this.showSetup(status);
      return;
    }
    await this.loadLibrary(status.info);
  }

  async loadLibrary(info) {
    this.info = info;
    const [books, cats, favs] = await Promise.all([this.db('books'), this.db('categories'), this.db('userFavorites')]);
    this.books = books;
    this.bookMap = new Map(books.map((b) => [b.id, b]));
    this.categories = cats;
    this.catMap = new Map(cats.map((c) => [c.id, c]));
    this.favorites = new Set(favs);
    document.getElementById('app').classList.remove('no-library');
    this.brandCount.textContent = `${num(books.length)} كتابًا`;
    this.go('library');
    this.restoreTabs();
  }

  // -------------------------------------------------------------- data
  async db(method, ...args) {
    try {
      return await api.db(method, ...args);
    } catch (e) {
      const msg = String(e?.message || e).replace(/^Error invoking remote method 'db': (Error: )?/, '');
      if (msg.includes('NO_LIBRARY')) toast('لم تُحدَّد مكتبة بعد.', 'error');
      throw new Error(msg);
    }
  }

  setSetting(key, value) {
    this.settings[key] = value;
    api.settings.set(key, value);
    this.applySettings();
  }

  applySettings() {
    const s = this.settings;
    const root = document.documentElement;
    const theme = s.theme === 'auto' ? (this.media.matches ? 'dark' : 'light') : s.theme;
    root.dataset.theme = theme;
    root.style.setProperty('--read-font', FONT_STACKS[s.readFont] || FONT_STACKS.Amiri);
    root.style.setProperty('--read-size', `${s.readSize}px`);
    root.style.setProperty('--read-leading', String(s.readLeading));
    root.style.setProperty('--read-width', `${s.readWidth}px`);
    setDigitStyle(s.arabicDigits);
    this.updateThemeButton();
  }

  // -------------------------------------------------------------- navigation
  /**
   * The shell: a sidebar (brand, quick search, sections, open books, settings) beside a stage that
   * holds a thin draggable title bar and the current view. Open books live in the sidebar, so the
   * reader gets the full width of the stage.
   */
  buildTitlebar() {
    const brand = document.getElementById('brand');
    this.brandCount = h('small', { class: 'num' });
    const rail = h('button', { class: 'icon-btn sb-rail-btn', title: 'طيّ الشريط الجانبي (Ctrl+B)', 'aria-label': 'طيّ الشريط الجانبي', onclick: () => this.toggleRail() }, icon('sidebar'));
    clear(brand).append(
      h('div', { class: 'sb-brand' }, h('span', { class: 'sb-logo' }, logo()), h('div', { class: 'sb-brand-text' }, h('strong', { text: 'الموسوعة الإباضية' }), this.brandCount)),
      rail,
    );

    clear(document.getElementById('sb-search')).append(
      h('button', { class: 'sb-search', title: 'بحث سريع عن كتاب أو مؤلف (Ctrl+K)', onclick: () => this.palette() }, icon('search'), h('span', { class: 'sb-search-label', text: 'بحث سريع' }), h('kbd', { text: 'Ctrl K' })),
    );

    clear(this.sectionsEl);
    for (const s of SECTIONS) {
      if (s.id === 'settings') continue;
      this.sectionsEl.append(this.navItem(s));
    }

    this.openHead = document.getElementById('open-head');
    this.openGroup = document.getElementById('open-group');

    this.themeBtn = h('button', { class: 'nav-item', onclick: () => this.cycleTheme() });
    this.settingsBtn = this.navItem(SECTIONS.find((s) => s.id === 'settings'));
    clear(document.getElementById('sb-foot')).append(this.themeBtn, this.settingsBtn);

    this.crumbsEl = document.getElementById('crumbs');
    const tools = document.getElementById('tools');
    this.syncChip = h('button', { class: 'tb-sync', hidden: true, onclick: () => this.go('settings', { section: this.chipTarget || 'sync' }) }, h('span', { class: 'spinner' }), h('span', { class: 'tb-sync-label', text: 'تحديث الكتب…' }));
    clear(tools).append(this.syncChip);
    this.updateThemeButton();
    this.applyRail();

    this.buildWindowControls();
  }

  navItem(s) {
    const n = SECTIONS.indexOf(s) + 1;
    return h(
      'button',
      { class: 'nav-item', dataset: { section: s.id }, title: `${s.label} (Alt+${n})`, onclick: () => this.go(s.id) },
      icon(s.icon),
      h('span', { class: 'nav-label', text: s.label }),
    );
  }

  applyRail() {
    const on = !!this.settings.sidebarRail;
    document.getElementById('app').classList.toggle('is-rail', on);
    const btn = document.querySelector('.sb-rail-btn');
    if (btn) {
      const label = on ? 'إظهار الشريط الجانبي (Ctrl+B)' : 'طيّ الشريط الجانبي (Ctrl+B)';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-expanded', String(!on));
    }
  }

  toggleRail() {
    this.setSetting('sidebarRail', !this.settings.sidebarRail);
    this.applyRail();
  }

  /** Where am I: the section, or the open book, shown at the start of the title bar. */
  updateCrumbs() {
    if (!this.crumbsEl) return;
    const tab = this.tabs.find((t) => t.id === this.active);
    const sec = SECTIONS.find((s) => s.id === this.section);
    const parts = tab ? ['الكتب المفتوحة', tab.title] : [sec?.label || 'الموسوعة الإباضية'];
    clear(this.crumbsEl);
    parts.forEach((p, i) => {
      if (i) this.crumbsEl.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '/' }));
      this.crumbsEl.append(h('span', { class: i === parts.length - 1 ? 'crumb is-current' : 'crumb', text: p }));
    });
  }

  async buildWindowControls() {
    const box = document.getElementById('win-controls');
    const state = await api.window.state();
    const app = document.getElementById('app');
    app.dataset.platform = state?.platform || '';
    if (!state || state.platform === 'darwin') return; // macOS keeps its native traffic lights
    const glyph = captionGlyphs();
    const min = h('button', { class: 'wc', title: 'تصغير', 'aria-label': 'تصغير', onclick: () => api.window.minimize() }, glyph('min'));
    const max = h('button', { class: 'wc', onclick: () => api.window.toggleMaximize() });
    const close = h('button', { class: 'wc wc-close', title: 'إغلاق', 'aria-label': 'إغلاق', onclick: () => api.window.close() }, glyph('close'));
    clear(box).append(min, max, close);
    const apply = (s) => {
      if (!s) return;
      const label = s.maximized || s.fullscreen ? 'استعادة الحجم' : 'تكبير';
      max.replaceChildren(glyph(s.maximized || s.fullscreen ? 'restore' : 'max'));
      max.title = label;
      max.setAttribute('aria-label', label);
      app.classList.toggle('is-maximized', !!s.maximized);
      app.classList.toggle('is-blurred', !s.focused);
    };
    apply(state);
    api.window.onState(apply);
  }

  updateThemeButton() {
    if (!this.themeBtn) return;
    const cur = document.documentElement.dataset.theme;
    const names = { light: 'فاتح', sepia: 'ورقي', dark: 'داكن' };
    this.themeBtn.replaceChildren(icon(cur === 'dark' ? 'moon' : 'sun'), h('span', { class: 'nav-label', text: `المظهر: ${names[cur] || ''}` }));
    this.themeBtn.title = 'تبديل المظهر';
  }

  cycleTheme() {
    const order = ['light', 'sepia', 'dark'];
    const cur = document.documentElement.dataset.theme;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.setSetting('theme', next);
    toast({ light: 'المظهر الفاتح', sepia: 'المظهر الورقي', dark: 'المظهر الداكن' }[next]);
  }

  // -------------------------------------------------------------- sync with the original app
  onSyncEvent(ev) {
    const running = ev.phase !== 'done' && ev.phase !== 'error';
    if (this.syncChip) {
      this.syncChip.hidden = !running;
      if (running) this.chipTarget = 'sync';
      this.syncChip.title = digits(ev.message);
      this.syncChip.querySelector('.tb-sync-label').textContent = ev.message ? digits(ev.message).slice(0, 28) : 'تحديث الكتب…';
    }
    if (ev.phase === 'error') toast('تعذّر التحديث من البرنامج الأصلي: ' + ev.message, 'error');
    this.sections.get('settings')?.onSyncEvent?.(ev);
  }

  // -------------------------------------------------------------- published library updates
  onUpdateEvent(ev) {
    const running = !['done', 'error', 'status', 'published'].includes(ev.phase);
    if (this.syncChip) {
      this.syncChip.hidden = !running;
      const label = ev.phase === 'publish' ? 'نشر التحديث…' : 'تحديث المكتبة…';
      this.syncChip.title = digits(ev.message || label);
      this.syncChip.querySelector('.tb-sync-label').textContent = label;
      if (running) this.chipTarget = 'updates';
    }
    if (ev.phase === 'error') toast(ev.message, 'error');
    if (ev.phase === 'published') {
      const r = ev.report || {};
      toast(r.changed ? `نُشر التحديث ${num(r.version)}: ${num((r.added || 0) + (r.updated || 0))} كتاب` : 'لا جديد للنشر');
    }
    this.sections.get('settings')?.onUpdateEvent?.(ev);
  }

  async onLibraryChanged({ added = [], updated = [], removed = [], source = 'original' }) {
    const [books, cats] = await Promise.all([this.db('books'), this.db('categories')]);
    this.books = books;
    this.bookMap = new Map(books.map((b) => [b.id, b]));
    this.categories = cats;
    this.catMap = new Map(cats.map((c) => [c.id, c]));
    // Open books whose text changed are reopened at the same page; removed books are closed.
    for (const t of [...this.tabs]) {
      if (removed.includes(t.bookId) || !this.bookMap.has(t.bookId)) this.closeTab(t.id);
      else if (updated.includes(t.bookId)) t.view.reloadBook?.();
    }
    this.sections.get('library')?.refreshData?.();
    const authors = this.sections.get('authors');
    if (authors) authors.authors = null;
    const parts = [];
    if (added.length) parts.push(`أُضيف ${num(added.length)} كتاب`);
    if (updated.length) parts.push(`حُدِّث ${num(updated.length)}`);
    if (removed.length) parts.push(`أُزيل ${num(removed.length)}`);
    if (parts.length) toast(parts.join('، ') + (source === 'update' ? ' من تحديثات المكتبة' : ' من البرنامج الأصلي'));
  }

  markNav() {
    const onSection = this.active === 'section';
    for (const b of document.querySelectorAll('#sidebar [data-section]')) {
      const cur = onSection && b.dataset.section === this.section;
      if (cur) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
  }

  go(sectionId, arg) {
    if (!this.books && sectionId !== 'settings') {
      if (this.setupView) {
        this.section = 'setup';
        this.activate('section');
      }
      return;
    }
    let view = this.sections.get(sectionId);
    if (!view) {
      const def = SECTIONS.find((s) => s.id === sectionId);
      view = new def.View(this);
      view.el.classList.add('view');
      view.el.hidden = true;
      this.views.append(view.el);
      this.sections.set(sectionId, view);
    }
    this.section = sectionId;
    this.activate('section');
    view.onShow?.(arg);
  }

  activate(id) {
    this.active = id;
    for (const [sid, v] of this.sections) v.el.hidden = !(id === 'section' && sid === this.section);
    if (this.setupView) this.setupView.hidden = this.section !== 'setup';
    for (const t of this.tabs) {
      const on = t.id === id;
      t.el.hidden = !on;
      if (on) t.view.onShow?.();
      else t.view.onHide?.();
    }
    this.markNav();
    this.renderTabs();
    this.updateCrumbs();
  }

  /** Open books, listed in the sidebar. Each entry is a pair of sibling buttons (open, close). */
  renderTabs() {
    clear(this.tabsEl);
    if (this.openGroup) this.openGroup.hidden = !this.tabs.length;
    if (this.openHead) {
      const closeAll = h('button', { class: 'icon-btn sm', title: 'إغلاق كل الكتب', 'aria-label': 'إغلاق كل الكتب', onclick: () => this.closeAllTabs() }, icon('close'));
      clear(this.openHead).append(h('span', { class: 'sb-label', text: 'الكتب المفتوحة' }), h('span', { class: 'sb-count num', text: num(this.tabs.length) }), closeAll);
    }
    for (const t of this.tabs) {
      const selected = this.active === t.id;
      const book = this.bookMap.get(t.bookId);
      const open = h(
        'button',
        { class: 'book-open', role: 'tab', title: t.title, 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', onclick: () => this.activate(t.id) },
        book ? coverEl(book, { small: true }) : null,
        h('span', { class: 'book-label', text: t.title }),
      );
      const close = h('button', { class: 'book-close', title: 'إغلاق الكتاب (Ctrl+W)', 'aria-label': `إغلاق ${t.title}`, onclick: () => this.closeTab(t.id) }, icon('close'));
      const row = h('div', { class: 'book-item' + (selected ? ' is-selected' : '') }, open, close);
      row.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.closeTab(t.id);
      });
      open.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const list = [...this.tabsEl.querySelectorAll('.book-open')];
        const i = list.indexOf(open) + (e.key === 'ArrowDown' ? 1 : -1);
        list[(i + list.length) % list.length]?.focus();
      });
      this.tabsEl.append(row);
    }
    this.tabsEl.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  closeAllTabs() {
    for (const t of [...this.tabs]) this.closeTab(t.id);
  }

  /**
   * Opens a book in a reading tab. loc: { pid } | { index } | { last } ; hl: { words, flexible }
   * Reuses an existing tab for the same book unless newTab is requested.
   */
  async openBook(bookId, loc = null, hl = null, { newTab = false } = {}) {
    bookId = Number(bookId);
    if (!this.bookMap.has(bookId)) {
      toast('الكتاب غير موجود في المكتبة.', 'error');
      return;
    }
    let tab = !newTab && this.tabs.find((t) => t.bookId === bookId);
    if (!tab) {
      if (this.tabs.length >= 14) this.closeTab(this.tabs[0].id);
      const view = new ReaderView(this, bookId);
      const el = view.el;
      el.classList.add('view');
      el.hidden = true;
      this.views.append(el);
      tab = { id: 'b' + Math.random().toString(36).slice(2), bookId, title: this.bookMap.get(bookId).name, view, el };
      this.tabs.push(tab);
      if (!loc) {
        const pid = await this.db('userGetPosition', bookId).catch(() => null);
        loc = pid != null ? { pid } : { index: 1 };
      }
      view.open(loc, hl);
    } else if (loc) tab.view.goto(loc, hl);
    this.activate(tab.id);
    this.saveTabs();
  }

  closeTab(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    t.view.dispose?.();
    t.el.remove();
    if (this.active === id) this.activate(this.tabs[i]?.id || this.tabs[i - 1]?.id || 'section');
    else this.renderTabs();
    this.saveTabs();
  }

  saveTabs = debounce(() => {
    api.settings.set(
      'openTabs',
      this.tabs.map((t) => ({ book: t.bookId, pid: t.view.current?.pid ?? null })),
    );
  }, 600);

  restoreTabs() {
    const saved = Array.isArray(this.settings.openTabs) ? this.settings.openTabs : [];
    for (const s of saved.slice(0, 10)) {
      if (!this.bookMap.has(s.book)) continue;
      const view = new ReaderView(this, s.book);
      view.el.classList.add('view');
      view.el.hidden = true;
      this.views.append(view.el);
      const tab = { id: 'b' + Math.random().toString(36).slice(2), bookId: s.book, title: this.bookMap.get(s.book).name, view, el: view.el };
      view.deferredLoc = s.pid != null ? { pid: s.pid } : { index: 1 };
      this.tabs.push(tab);
    }
    this.renderTabs();
  }

  activeReader() {
    return this.tabs.find((t) => t.id === this.active)?.view || null;
  }

  // -------------------------------------------------------------- favorites
  isFavorite(id) {
    return this.favorites.has(id);
  }
  async toggleFavorite(id) {
    const on = await this.db('userToggleFavorite', id);
    if (on) this.favorites.add(id);
    else this.favorites.delete(id);
    toast(on ? 'أُضيف إلى المفضّلة' : 'أُزيل من المفضّلة');
    this.sections.get('library')?.onFavoritesChanged?.();
    return on;
  }

  bookInfo(id) {
    return showBookInfo(this, id);
  }

  // -------------------------------------------------------------- command palette
  palette(initial = '') {
    if (!this.books) return;
    const input = h('input', { class: 'input pal-input', placeholder: 'اكتب اسم كتاب أو مؤلف…', value: initial, spellcheck: false });
    const list = h('div', { role: 'listbox' });
    let items = [];
    let sel = 0;
    const { close } = modal({ body: h('div', null, input, list), cls: 'palette' });
    const mark = () => items.forEach((it, i) => it.el.setAttribute('aria-selected', String(i === sel)));
    const choose = (it) => {
      close();
      it.run();
    };
    let token = 0;
    const render = async () => {
      const text = input.value.trim();
      const my = ++token;
      const add = (it) => {
        items.push(it);
        it.el.addEventListener('click', () => choose(it));
        list.append(it.el);
      };
      const group = (label) => list.append(h('div', { class: 'pal-group', text: label }));
      let recent = null;
      let res = null;
      if (!text) recent = await this.db('userHistory', 8);
      else res = await this.db('quickFind', text, 25);
      if (my !== token) return; // a newer keystroke superseded this one
      clear(list);
      items = [];
      if (recent) {
        if (recent.length) group('قرأتها مؤخرًا');
        for (const r of recent) {
          const b = this.bookMap.get(r.book);
          if (b) add(this.palItem(b, () => this.openBook(b.id)));
        }
      } else {
        if (res.books.length) group('الكتب');
        for (const r of res.books) {
          const b = this.bookMap.get(r.id);
          if (b) add(this.palItem(b, () => this.openBook(b.id)));
        }
        if (res.authors.length) group('المؤلفون');
        for (const a of res.authors) {
          add({
            el: h('button', { class: 'pal-item' }, icon('users'), h('div', { class: 't' }, h('div', { text: a.name }), h('div', { class: 's', text: deathLabel(a.death, a.deathText) }))),
            run: () => this.go('authors', { author: a.id }),
          });
        }
        group('بحث');
        add({
          el: h('button', { class: 'pal-item' }, icon('search'), h('div', { class: 't' }, h('div', { text: `البحث في نصوص المكتبة عن «${text}»` }))),
          run: () => this.go('search', { q: text }),
        });
      }
      sel = 0;
      mark();
    };
    const rerender = debounce(render, 120);
    input.addEventListener('input', rerender);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        sel = Math.min(items.length - 1, sel + 1);
        mark();
        items[sel]?.el.scrollIntoView({ block: 'nearest' });
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        sel = Math.max(0, sel - 1);
        mark();
        items[sel]?.el.scrollIntoView({ block: 'nearest' });
        e.preventDefault();
      } else if (e.key === 'Enter' && items[sel]) {
        e.preventDefault();
        choose(items[sel]);
      }
    });
    render();
    input.focus();
  }

  palItem(b, run) {
    const el = h(
      'button',
      { class: 'pal-item' },
      coverEl(b, { small: true }),
      h('div', { class: 't' }, h('div', { class: 'ellipsis', text: b.name }), h('div', { class: 's ellipsis', text: b.author || '' })),
    );
    return { el, run };
  }

  // -------------------------------------------------------------- keyboard & menus
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.palette();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const sel = String(getSelection() || '').trim();
        this.go('search', sel ? { q: sel } : { focus: true });
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'f' && this.active === 'section' && this.section === 'library') {
        e.preventDefault();
        this.sections.get('library')?.focusFilter();
      } else if (mod && e.key.toLowerCase() === 'w') {
        if (this.active !== 'section') {
          e.preventDefault();
          this.closeTab(this.active);
        }
      } else if (mod && e.key === 'Tab') {
        e.preventDefault();
        const ids = ['section', ...this.tabs.map((t) => t.id)];
        const i = ids.indexOf(this.active);
        this.activate(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleRail();
      } else if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        this.go(SECTIONS[Number(e.key) - 1].id);
      } else if (e.key === 'F1') {
        e.preventDefault();
        this.shortcutsHelp();
      }
    });
  }

  onMenu(action, arg) {
    if (action === 'search') this.go('search', { q: arg });
    else if (action === 'search-book') {
      const r = this.activeReader();
      if (r) r.openSearch(arg);
      else this.go('search', { q: arg });
    } else if (action === 'copy-cite') {
      const r = this.activeReader();
      if (r) r.copyWithCitation();
      else api.copy(String(getSelection() || ''));
    }
  }

  shortcutsHelp() {
    const rows = [
      ['Ctrl + K', 'بحث سريع عن كتاب أو مؤلف'],
      ['Ctrl + Shift + F', 'البحث في المكتبة'],
      ['Ctrl + F', 'البحث في الكتاب المفتوح'],
      ['← / →', 'الصفحة التالية / السابقة'],
      ['Home / End', 'أول الكتاب / آخره'],
      ['Ctrl + G', 'الانتقال إلى صفحة'],
      ['Ctrl + D', 'إضافة علامة'],
      ['Ctrl + = / Ctrl + -', 'تكبير الخط / تصغيره'],
      ['Ctrl + W', 'إغلاق الكتاب'],
      ['Ctrl + Tab', 'التنقّل بين الكتب المفتوحة'],
      ['Ctrl + B', 'طيّ الشريط الجانبي وإظهاره'],
      ['Alt + 1…6', 'الانتقال بين الأقسام'],
    ];
    modal({
      title: 'اختصارات لوحة المفاتيح',
      cls: 'small',
      body: h('table', { class: 'table' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', { text: k })), h('td', { text: v }))))),
    });
  }

  // -------------------------------------------------------------- first run
  /**
   * First run: download the library (the normal path), or point at an existing library folder.
   * The download resumes where it stopped if it is interrupted or cancelled.
   */
  showSetup(status) {
    document.getElementById('app').classList.add('no-library');
    clear(this.views);
    const gb = (n) => {
      const s = num(Math.max(0.1, n / 1e9).toFixed(1));
      return `${/[٠-٩]/.test(s) ? s.replace('.', '٫') : s} غ.ب`; // Arabic decimal separator
    };
    const err = status?.error ? h('p', { class: 'setup-error', text: 'تعذّر فتح المكتبة: ' + status.error }) : null;
    const sizeLine = h('p', { class: 'faint', text: 'جارٍ التحقّق من حجم المكتبة…' });
    const download = h('button', { class: 'btn primary setup-main' }, icon('goto'), 'تنزيل المكتبة');
    const elsewhere = h('button', { class: 'btn ghost sm' }, 'التنزيل إلى مجلّد آخر…');
    const existing = h('button', { class: 'btn ghost sm' }, icon('folder'), 'لديّ مجلّد المكتبة');
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
    const barLabel = h('div', { class: 'progress-label num' });
    const cancel = h('button', { class: 'btn sm', text: 'إيقاف مؤقّت' });
    const progress = h('div', { class: 'setup-progress', hidden: true }, barLabel, bar, cancel);
    const actions = h('div', { class: 'setup-actions' }, download, h('div', { class: 'setup-alt' }, existing, elsewhere));
    const message = h('p', { class: 'setup-error', hidden: true });
    const card = h(
      'div',
      { class: 'setup-card' },
      ...[
        logo(),
        h('h1', { text: 'الموسوعة الإباضية' }),
        h('p', { text: 'مرحبًا بك. تحتاج إلى مكتبة الكتب لتبدأ القراءة: نحو ثلاثة آلاف كتاب بنصوصها وأغلفتها وفهارسها، تُنزَّل مرّة واحدة وتعمل بعدها بلا إنترنت.' }),
        sizeLine,
        err,
        message,
        actions,
        progress,
      ].filter(Boolean),
    );
    const view = h('div', { class: 'view' }, h('div', { class: 'setup' }, card));
    this.views.append(view);
    this.setupView = view;
    this.section = 'setup';
    this.renderTabs();

    api.library.remote().then((r) => {
      if (r?.ok) sizeLine.textContent = `حجم التنزيل ${gb(r.download)}، وتشغل بعد التثبيت ${gb(r.installed)}.`;
      else sizeLine.textContent = 'تعذّر الوصول إلى خادم التنزيل الآن. تحقّق من الاتصال بالإنترنت، أو اختر مجلّد مكتبة موجودًا.';
    });

    let started = 0;
    let startBytes = 0;
    const off = api.library.onDownload((ev) => {
      if (ev.total) {
        const pct = Math.min(100, (ev.received / ev.total) * 100);
        bar.firstChild.style.transform = `scaleX(${pct / 100})`;
        bar.setAttribute('aria-valuenow', String(Math.round(pct)));
        let eta = '';
        if (ev.phase === 'download') {
          if (!started) {
            started = Date.now();
            startBytes = ev.received;
          }
          const secs = (Date.now() - started) / 1000;
          const rate = secs > 2 ? (ev.received - startBytes) / secs : 0;
          if (rate > 0) {
            const left = Math.round((ev.total - ev.received) / rate / 60);
            eta = `، ${num((rate / 1e6).toFixed(1)).replace('.', '٫')} م.ب/ث، بقي نحو ${left < 1 ? 'أقلّ من دقيقة' : num(left) + ' دقيقة'}`;
          }
        }
        barLabel.textContent = `${digits(ev.message)} — ${num(Math.round(pct))}٪ (${gb(ev.received)} من ${gb(ev.total)})${eta}`;
      }
      if (ev.phase === 'restore') cancel.hidden = true;
    });
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');

    const begin = async (choose) => {
      message.hidden = true;
      actions.hidden = true;
      progress.hidden = false;
      cancel.hidden = false;
      started = 0;
      barLabel.textContent = 'بدء التنزيل…';
      const r = await api.library.download(choose);
      if (r?.ok) {
        off();
        view.remove();
        this.setupView = null;
        toast('تمّ تثبيت المكتبة');
        await this.loadLibrary(r.info);
        return;
      }
      progress.hidden = true;
      actions.hidden = false;
      download.lastChild.textContent = r?.canceled ? 'تنزيل المكتبة' : 'متابعة التنزيل';
      if (r && !r.canceled) {
        message.textContent = r.error;
        message.classList.toggle('is-paused', !!r.paused); // a pause the user chose is not an error
        message.hidden = false;
      }
    };
    download.addEventListener('click', () => begin(false));
    elsewhere.addEventListener('click', () => begin(true));
    cancel.addEventListener('click', () => api.library.cancelDownload());
    existing.addEventListener('click', async () => {
      const r = await api.library.choose();
      if (r?.ok) {
        off();
        view.remove();
        this.setupView = null;
        toast('تمّ فتح المكتبة');
        await this.loadLibrary(r.info);
      } else if (r && !r.canceled) toast(r.error || 'تعذّر فتح المكتبة', 'error');
    });
  }
}

export const app = new App();
window.addEventListener('DOMContentLoaded', () => app.start().catch((e) => toast(String(e.message || e), 'error')));
