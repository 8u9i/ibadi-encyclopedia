import { h, icon, clear, coverEl, num, deathLabel, deathSortKey, debounce, emptyState, digits } from '../dom.js';
import { normalize } from '../../shared/arabic.js';

const CHUNK = 96;
const collator = new Intl.Collator('ar');
const relTime = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });

/** "منذ ٣ ساعات" for a timestamp in ms (or seconds, as older history rows stored). */
function ago(t) {
  const ms = t < 1e12 ? t * 1000 : t;
  const s = Math.round((ms - Date.now()) / 1000);
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return digits(relTime.format(Math.round(v), unit));
    v /= size;
  }
  return '';
}

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.cat = 'all';
    this.filter = '';
    this.sort = app.settings.librarySort || 'name';
    this.layout = app.settings.libraryView || 'grid';
    this.norm = new Map(app.books.map((b) => [b.id, normalize(`${b.name} ${b.author || ''}`)]));
    this.build();
    this.renderFolders();
    this.apply();
  }

  build() {
    this.input = h('input', { class: 'input', type: 'search', placeholder: 'تصفية بالعنوان أو المؤلف', 'aria-label': 'تصفية الكتب بالعنوان أو المؤلف' });
    this.input.addEventListener('input', debounce(() => {
      this.filter = normalize(this.input.value.trim());
      this.apply();
    }, 120));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.input.value) {
        this.input.value = '';
        this.filter = '';
        this.apply();
      }
    });
    this.sortSel = h(
      'select',
      { class: 'select', 'aria-label': 'ترتيب الكتب' },
      h('option', { value: 'name', text: 'حسب العنوان' }),
      h('option', { value: 'author', text: 'حسب المؤلف' }),
      h('option', { value: 'death', text: 'حسب وفاة المؤلف' }),
      h('option', { value: 'pages', text: 'الأكبر حجمًا' }),
      h('option', { value: 'id', text: 'الأحدث إضافة' }),
    );
    this.sortSel.value = this.sort;
    this.sortSel.addEventListener('change', () => {
      this.sort = this.sortSel.value;
      this.app.setSetting('librarySort', this.sort);
      this.apply();
    });
    this.btnGrid = h('button', { class: 'icon-btn', title: 'عرض شبكي', 'aria-label': 'عرض شبكي', onclick: () => this.setLayout('grid') }, icon('grid'));
    this.btnList = h('button', { class: 'icon-btn', title: 'عرض قائمة', 'aria-label': 'عرض قائمة', onclick: () => this.setLayout('list') }, icon('list'));

    // categories as folder shortcuts
    this.folders = h('div', { class: 'folders', role: 'listbox', 'aria-label': 'التصنيفات' });
    const scrollBy = (dir) => this.folders.scrollBy({ left: dir * this.folders.clientWidth * 0.8, behavior: 'smooth' });
    const shortcuts = h(
      'section',
      { class: 'panel shortcuts' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', { text: 'التصنيفات' }),
        h('span', { class: 'panel-sub num', text: `${num(this.app.categories.length)} تصنيفًا` }),
        h(
          'div',
          { class: 'panel-tools' },
          h('button', { class: 'icon-btn sm', title: 'السابق', 'aria-label': 'التصنيفات السابقة', onclick: () => scrollBy(1) }, icon('chevronRight')),
          h('button', { class: 'icon-btn sm', title: 'التالي', 'aria-label': 'التصنيفات التالية', onclick: () => scrollBy(-1) }, icon('chevronLeft')),
        ),
      ),
      this.folders,
    );

    this.booksTitle = h('h2');
    this.count = h('span', { class: 'panel-sub num' });
    this.body = h('div', { class: 'books-body' });
    const books = h(
      'section',
      { class: 'panel books' },
      h('div', { class: 'panel-head' }, this.booksTitle, this.count, h('div', { class: 'panel-tools seg-icons' }, this.btnGrid, this.btnList)),
      this.body,
    );

    this.recentList = h('div', { class: 'recent-list' });
    this.recent = h(
      'aside',
      { class: 'panel recent-panel', 'aria-label': 'تابع القراءة' },
      h('div', { class: 'panel-head col' }, h('h2', { text: 'تابع القراءة' }), h('p', { class: 'panel-sub', text: 'آخر الكتب التي فتحتها، من حيث توقّفت.' })),
      this.recentList,
    );

    this.content = h(
      'div',
      { class: 'content page-scroll' },
      h(
        'header',
        { class: 'page-head' },
        h(
          'div',
          { class: 'page-head-row' },
          h('h1', { text: 'المكتبة' }),
          h(
            'div',
            { class: 'page-tools' },
            h('div', { class: 'search-field' }, icon('filter'), this.input, h('kbd', { text: 'Ctrl F' })),
            this.sortSel,
          ),
        ),
      ),
      shortcuts,
      h('div', { class: 'lib-body' }, books, this.recent),
    );
    this.el = h('section', { class: 'lib' }, this.content);
    this.updateLayoutButtons();
  }

  onShow() {
    this.renderRecent();
  }

  /** Ctrl+F while the library is showing filters the books. */
  focusFilter() {
    this.input.focus();
    this.input.select();
  }

  refreshData() {
    this.norm = new Map(this.app.books.map((b) => [b.id, normalize(`${b.name} ${b.author || ''}`)]));
    if (this.cat !== 'all' && this.cat !== 'fav' && !this.app.catMap.has(Number(this.cat))) this.cat = 'all';
    this.renderFolders();
    this.apply();
    this.renderRecent();
  }

  onFavoritesChanged() {
    if (this.cat === 'fav') this.apply();
    else for (const b of this.body.querySelectorAll('.fav')) b.setAttribute('aria-pressed', String(this.app.isFavorite(Number(b.dataset.id))));
  }

  setLayout(l) {
    this.layout = l;
    this.app.setSetting('libraryView', l);
    this.updateLayoutButtons();
    this.apply();
  }

  updateLayoutButtons() {
    this.btnGrid.setAttribute('aria-pressed', String(this.layout === 'grid'));
    this.btnList.setAttribute('aria-pressed', String(this.layout === 'list'));
  }

  renderFolders() {
    clear(this.folders);
    const folder = (id, label, count, glyph) =>
      h(
        'button',
        { class: 'folder', role: 'option', dataset: { cat: id }, 'aria-selected': String(this.cat === id), title: label, onclick: () => this.selectCat(id) },
        h('span', { class: 'folder-art', 'aria-hidden': 'true' }, glyph ? icon(glyph) : null),
        h('span', { class: 'folder-name', text: label }),
        count != null ? h('span', { class: 'folder-count num', text: num(count) }) : null,
      );
    this.folders.append(folder('all', 'كل الكتب', this.app.books.length, 'library'), folder('fav', 'المفضّلة', null, 'star'));
    for (const c of this.app.categories) this.folders.append(folder(String(c.id), c.name, c.count));
  }

  selectCat(id) {
    this.cat = id;
    for (const b of this.folders.querySelectorAll('.folder')) b.setAttribute('aria-selected', String(b.dataset.cat === id));
    this.apply();
  }

  async renderRecent() {
    const hist = await this.app.db('userHistory', 8).catch(() => []);
    clear(this.recentList);
    const rows = hist.filter((r) => this.app.bookMap.has(r.book));
    this.recent.classList.toggle('is-empty', !rows.length);
    if (!rows.length) {
      this.recentList.append(h('p', { class: 'recent-empty', text: 'افتح كتابًا من المكتبة، وسيظهر هنا لتعود إليه من آخر صفحة قرأتها.' }));
      return;
    }
    for (const r of rows) {
      const b = this.app.bookMap.get(r.book);
      this.recentList.append(
        h(
          'article',
          { class: 'recent-item' },
          h('div', { class: 'recent-top' }, coverEl(b, { small: true }), h('div', { class: 'recent-text' }, h('h3', { text: b.name }), h('p', { text: b.author || '' }))),
          h(
            'dl',
            { class: 'recent-meta' },
            h('dt', { text: 'آخر قراءة' }),
            h('dd', { text: r.opened ? ago(r.opened) : '—' }),
            h('dt', { text: 'الحجم' }),
            h('dd', { class: 'num', text: `${num(b.pages)} صفحة` }),
          ),
          h('div', { class: 'recent-actions' }, h('button', { class: 'btn sm', onclick: () => this.app.openBook(b.id) }, 'متابعة القراءة'), h('button', { class: 'btn sm ghost', onclick: () => this.app.bookInfo(b.id) }, 'البطاقة')),
        ),
      );
    }
  }

  apply() {
    let list = this.app.books;
    if (this.cat === 'fav') list = list.filter((b) => this.app.isFavorite(b.id));
    else if (this.cat !== 'all') list = list.filter((b) => String(b.cat) === this.cat);
    if (this.filter) {
      const words = this.filter.split(/\s+/).filter(Boolean);
      list = list.filter((b) => {
        const n = this.norm.get(b.id);
        return words.every((w) => n.includes(w));
      });
    }
    const s = this.sort;
    list = [...list].sort((a, b) => {
      if (s === 'author') return collator.compare(a.author || '', b.author || '') || collator.compare(a.name, b.name);
      if (s === 'death') return deathSortKey(a.death, a.deathText) - deathSortKey(b.death, b.deathText) || collator.compare(a.name, b.name);
      if (s === 'pages') return (b.pages || 0) - (a.pages || 0);
      if (s === 'id') return b.id - a.id;
      return collator.compare(a.name, b.name);
    });
    this.list = list;
    this.booksTitle.textContent = this.cat === 'all' ? 'كل الكتب' : this.cat === 'fav' ? 'المفضّلة' : this.app.catMap.get(Number(this.cat))?.name || '';
    this.count.textContent = `${num(list.length)} كتابًا`;
    clear(this.body);
    if (this.io) this.io.disconnect();
    if (!list.length) {
      this.body.append(
        this.cat === 'fav' && !this.filter
          ? emptyState('star', 'لا كتب في المفضّلة', 'مرّر المؤشر على غلاف كتاب وانقر النجمة لإضافته.')
          : emptyState('filter', 'لا كتب مطابقة', 'جرّب كلمات أخرى، أو اختر «كل الكتب».'),
      );
      return;
    }
    if (this.layout === 'grid') {
      this.container = h('div', { class: 'grid' });
    } else {
      this.tbody = h('tbody');
      this.container = h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', { text: 'الكتاب' }), h('th', { text: 'المؤلف' }), h('th', { text: 'الوفاة' }), h('th', { text: 'التصنيف' }), h('th', { text: 'الصفحات' }))),
        this.tbody,
      );
    }
    this.body.append(this.container);
    this.rendered = 0;
    this.sentinel = h('div', { style: { height: '1px' } });
    this.body.append(this.sentinel);
    this.renderChunk();
    this.io = new IntersectionObserver((e) => e[0].isIntersecting && this.renderChunk(), { root: this.content, rootMargin: '800px' });
    this.io.observe(this.sentinel);
  }

  renderChunk() {
    const end = Math.min(this.list.length, this.rendered + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = this.rendered; i < end; i++) frag.append(this.layout === 'grid' ? this.card(this.list[i]) : this.row(this.list[i]));
    (this.layout === 'grid' ? this.container : this.tbody).append(frag);
    this.rendered = end;
    if (end >= this.list.length) this.io?.disconnect();
  }

  card(b) {
    const fav = h('button', { class: 'fav', title: 'المفضّلة', 'aria-label': `المفضّلة: ${b.name}`, 'aria-pressed': String(this.app.isFavorite(b.id)), dataset: { id: b.id } }, icon('star'));
    fav.addEventListener('click', async (e) => {
      e.stopPropagation();
      const on = await this.app.toggleFavorite(b.id);
      fav.setAttribute('aria-pressed', String(on));
    });
    const info = h('button', { class: 'fav fav-info', title: 'بطاقة الكتاب', 'aria-label': `بطاقة الكتاب: ${b.name}` }, icon('info'));
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      this.app.bookInfo(b.id);
    });
    return h(
      'div',
      { class: 'card', role: 'button', tabindex: '0', title: b.name, onclick: () => this.app.openBook(b.id), onkeydown: (e) => e.key === 'Enter' && this.app.openBook(b.id) },
      coverEl(b),
      fav,
      info,
      h('div', { class: 't', text: b.name }),
      h('div', { class: 's', text: b.author || '' }),
    );
  }

  row(b) {
    return h(
      'tr',
      { class: 'row', tabindex: '0', onclick: () => this.app.openBook(b.id), onkeydown: (e) => e.key === 'Enter' && this.app.openBook(b.id) },
      h('td', null, h('span', { class: 'row-title', text: b.name })),
      h('td', { class: 'muted', text: b.author || '' }),
      h('td', { class: 'faint num', text: b.author ? deathLabel(b.death, b.deathText) : '' }),
      h('td', { class: 'faint', text: this.app.catMap.get(b.cat)?.name || '' }),
      h('td', { class: 'faint num', text: num(b.pages) }),
    );
  }
}
