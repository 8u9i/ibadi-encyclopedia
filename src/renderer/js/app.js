import { h, icon, clear, modal, toast, coverEl, debounce, setDigitStyle, deathLabel, logo, fillIcons } from './dom.js';
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
    this.rail = document.getElementById('rail');
    this.media = matchMedia('(prefers-color-scheme: dark)');
    this.media.addEventListener('change', () => this.applySettings());
  }

  async start() {
    fillIcons();
    const stored = await api.settings.all();
    this.settings = { ...DEFAULTS, ...stored };
    this.applySettings();
    this.buildRail();
    document.getElementById('quick-open').addEventListener('click', () => this.palette());
    this.bindKeys();
    api.onMenu((action, arg) => this.onMenu(action, arg));

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
  }

  // -------------------------------------------------------------- navigation
  buildRail() {
    clear(this.rail);
    this.rail.append(h('div', { class: 'brand', title: 'الموسوعة الإباضية' }, logo()));
    for (const s of SECTIONS) {
      if (s.id === 'settings') this.rail.append(h('div', { class: 'spacer' }));
      this.rail.append(
        h('button', { dataset: { section: s.id }, title: s.label, onclick: () => this.go(s.id) }, icon(s.icon), h('span', { text: s.label })),
      );
    }
    const theme = h('button', { title: 'تبديل المظهر', onclick: () => this.cycleTheme() }, icon('moon'), h('span', { text: 'المظهر' }));
    this.rail.append(theme);
  }

  cycleTheme() {
    const order = ['light', 'sepia', 'dark'];
    const cur = document.documentElement.dataset.theme;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.setSetting('theme', next);
    toast({ light: 'المظهر الفاتح', sepia: 'المظهر الورقي', dark: 'المظهر الداكن' }[next]);
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
    for (const b of this.rail.querySelectorAll('button[data-section]')) b.setAttribute('aria-current', String(b.dataset.section === sectionId));
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
    if (id !== 'section') for (const b of this.rail.querySelectorAll('button[data-section]')) b.setAttribute('aria-current', 'false');
    else for (const b of this.rail.querySelectorAll('button[data-section]')) b.setAttribute('aria-current', String(b.dataset.section === this.section));
    this.renderTabs();
  }

  renderTabs() {
    clear(this.tabsEl);
    const sec = SECTIONS.find((s) => s.id === this.section) || { icon: 'library', label: 'البداية' };
    this.tabsEl.append(
      h('button', { class: 'tab', role: 'tab', 'aria-selected': String(this.active === 'section'), onclick: () => this.activate('section') }, icon(sec.icon), h('span', { class: 'label', text: sec.label })),
    );
    for (const t of this.tabs) {
      const close = h('button', { class: 'close', title: 'إغلاق (Ctrl+W)', 'aria-label': 'إغلاق' }, icon('close'));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(t.id);
      });
      const tab = h(
        'button',
        { class: 'tab', role: 'tab', title: t.title, 'aria-selected': String(this.active === t.id), onclick: () => this.activate(t.id) },
        icon('page'),
        h('span', { class: 'label', text: t.title }),
        close,
      );
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.closeTab(t.id);
      });
      this.tabsEl.append(tab);
    }
    const sel = this.tabsEl.querySelector('[aria-selected="true"]');
    sel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
      ['Ctrl + Tab', 'التنقل بين الألسنة'],
      ['Alt + 1…6', 'الانتقال بين الأقسام'],
    ];
    modal({
      title: 'اختصارات لوحة المفاتيح',
      cls: 'small',
      body: h('table', { class: 'table' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', { text: k })), h('td', { text: v }))))),
    });
  }

  // -------------------------------------------------------------- first run
  showSetup(status) {
    document.getElementById('app').classList.add('no-library');
    clear(this.views);
    const err = status?.error ? h('p', { class: 'muted', style: { color: 'var(--danger)' }, text: 'تعذّر فتح المكتبة: ' + status.error }) : null;
    const btn = h('button', { class: 'btn primary', style: { height: '42px', padding: '0 26px' } }, icon('folder'), 'اختر مجلّد المكتبة');
    const card = h(
      'div',
      { class: 'setup-card' },
      logo(),
      h('h1', { text: 'الموسوعة الإباضية' }),
      h('p', { text: 'مرحبًا بك. لم يُعثر على مجلّد المكتبة بعد. اختر المجلّد الذي يحتوي على الملفّ ibadi.db (ويُستحسن أن يكون معه covers.db لأغلفة الكتب).' }),
      h('p', { class: 'faint' }, 'يُنشأ هذا المجلّد مرّة واحدة بأداة التحويل المرفقة من بيانات الموسوعة الأصلية، ويمكن وضعه بجوار البرنامج باسم ', h('code', { text: 'library' }), ' ليُكتشف تلقائيًا.'),
      err,
      btn,
    );
    const view = h('div', { class: 'view' }, h('div', { class: 'setup' }, card));
    this.views.append(view);
    this.setupView = view;
    this.section = 'setup';
    this.renderTabs();
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await api.library.choose();
      btn.disabled = false;
      if (r?.ok) {
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
