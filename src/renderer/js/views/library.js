import { h, icon, clear, coverEl, num, deathLabel, deathSortKey, debounce, emptyState } from '../dom.js';
import { normalize } from '../../shared/arabic.js';

const CHUNK = 96;
const collator = new Intl.Collator('ar');

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.cat = 'all';
    this.filter = '';
    this.sort = app.settings.librarySort || 'name';
    this.layout = app.settings.libraryView || 'grid';
    this.norm = new Map(app.books.map((b) => [b.id, normalize(`${b.name} ${b.author || ''}`)]));
    this.build();
    this.renderSide();
    this.apply();
  }

  build() {
    this.side = h('nav', { class: 'side', 'aria-label': 'الأقسام' });
    this.input = h('input', { class: 'input', type: 'search', placeholder: 'تصفية بعنوان الكتاب أو اسم المؤلف…' });
    this.input.addEventListener('input', debounce(() => {
      this.filter = normalize(this.input.value.trim());
      this.apply();
    }, 120));
    this.sortSel = h(
      'select',
      { class: 'select', title: 'الترتيب' },
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
    this.btnGrid = h('button', { class: 'icon-btn', title: 'عرض شبكي', onclick: () => this.setLayout('grid') }, icon('grid'));
    this.btnList = h('button', { class: 'icon-btn', title: 'عرض قائمة', onclick: () => this.setLayout('list') }, icon('list'));
    this.count = h('span', { class: 'lib-count num' });
    this.recent = h('div', { class: 'recent' });
    this.body = h('div');
    this.content = h(
      'div',
      { class: 'content' },
      h('div', { class: 'lib-toolbar' }, h('div', { class: 'search-field' }, icon('filter'), this.input), this.sortSel, this.btnGrid, this.btnList, this.count),
      this.recent,
      this.body,
    );
    this.el = h('section', null, h('div', { class: 'split' }, this.side, this.content));
    this.updateLayoutButtons();
  }

  onShow() {
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

  renderSide() {
    clear(this.side);
    const item = (id, label, count, iconName) =>
      h(
        'button',
        { class: 'list-btn', dataset: { cat: id }, 'aria-current': String(this.cat === id), onclick: () => this.selectCat(id) },
        iconName ? icon(iconName) : null,
        h('span', { class: 't', text: label }),
        count != null ? h('span', { class: 'n', text: num(count) }) : null,
      );
    this.side.append(item('all', 'كل الكتب', this.app.books.length, 'library'), item('fav', 'المفضّلة', null, 'star'), h('div', { class: 'side-title', text: 'التصنيفات' }));
    for (const c of this.app.categories) this.side.append(item(String(c.id), c.name, c.count));
  }

  selectCat(id) {
    this.cat = id;
    for (const b of this.side.querySelectorAll('.list-btn')) b.setAttribute('aria-current', String(b.dataset.cat === id));
    this.apply();
    this.content.scrollTop = 0;
  }

  async renderRecent() {
    const hist = await this.app.db('userHistory', 12).catch(() => []);
    clear(this.recent);
    const show = hist.length && this.cat === 'all' && !this.filter;
    this.recent.hidden = !show;
    if (!show) return;
    const row = h('div', { class: 'recent-row' });
    for (const r of hist) {
      const b = this.app.bookMap.get(r.book);
      if (!b) continue;
      row.append(
        h(
          'button',
          { class: 'recent-card', title: b.name, onclick: () => this.app.openBook(b.id) },
          coverEl(b, { small: true }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 't', text: b.name }), h('div', { class: 's', text: 'متابعة القراءة' })),
        ),
      );
    }
    this.recent.append(h('h2', { text: 'تابع القراءة' }), row);
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
    this.count.textContent = `${num(list.length)} كتابًا`;
    this.recent.hidden = !(this.cat === 'all' && !this.filter && this.recent.childElementCount);
    clear(this.body);
    if (this.io) this.io.disconnect();
    if (!list.length) {
      this.body.append(
        this.cat === 'fav' && !this.filter
          ? emptyState('star', 'لا كتب في المفضّلة', 'مرّر المؤشر على غلاف كتاب وانقر النجمة لإضافته.')
          : emptyState('filter', 'لا كتب مطابقة', 'جرّب كلمات أخرى.'),
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
    const fav = h('button', { class: 'fav', title: 'المفضّلة', 'aria-pressed': String(this.app.isFavorite(b.id)), dataset: { id: b.id } }, icon('star'));
    fav.addEventListener('click', async (e) => {
      e.stopPropagation();
      const on = await this.app.toggleFavorite(b.id);
      fav.setAttribute('aria-pressed', String(on));
    });
    const info = h('button', { class: 'fav', title: 'بطاقة الكتاب', style: { insetInlineStart: 'auto', insetInlineEnd: '6px' } }, icon('info'));
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
      h('div', { class: 's', text: b.author ? `${b.author}` : '' }),
    );
  }

  row(b) {
    return h(
      'tr',
      { class: 'row', onclick: () => this.app.openBook(b.id) },
      h('td', null, h('span', { style: { fontWeight: 600 }, text: b.name })),
      h('td', { class: 'muted', text: b.author || '' }),
      h('td', { class: 'faint num', text: b.author ? deathLabel(b.death, b.deathText) : '' }),
      h('td', { class: 'faint', text: this.app.catMap.get(b.cat)?.name || '' }),
      h('td', { class: 'faint num', text: num(b.pages) }),
    );
  }
}
