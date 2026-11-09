import { h, icon, clear, num, deathLabel, deathSortKey, debounce, spinnerRow, emptyState, coverEl } from '../dom.js';
import { normalize } from '../../shared/arabic.js';

export class AuthorsView {
  constructor(app) {
    this.app = app;
    this.authors = null;
    this.current = null;
    this.filter = h('input', { class: 'input', type: 'search', placeholder: 'تصفية بالاسم…' });
    this.filter.addEventListener('input', debounce(() => this.renderList(), 150));
    this.sort = h('select', { class: 'select' }, h('option', { value: 'death', text: 'حسب الوفاة' }), h('option', { value: 'name', text: 'حسب الاسم' }), h('option', { value: 'books', text: 'الأكثر تأليفًا' }));
    this.sort.addEventListener('change', () => this.renderList());
    this.list = h('div', { style: { overflow: 'auto', flex: 1, padding: '6px' } });
    this.count = h('div', { class: 'faint num', style: { fontSize: '12px', padding: '0 12px 6px' } });
    this.detail = h('div', { class: 'content' });
    this.el = h(
      'section',
      null,
      h(
        'div',
        { class: 'split' },
        h('nav', { class: 'side', style: { width: '320px', display: 'flex', flexDirection: 'column', padding: 0 } },
          h('div', { class: 'panel-filter', style: { display: 'flex', gap: '6px' } }, h('div', { class: 'search-field', style: { flex: 1 } }, icon('filter'), this.filter), this.sort),
          this.count,
          this.list,
        ),
        this.detail,
      ),
    );
    this.detail.append(emptyState('users', 'اختر مؤلفًا', 'لعرض ترجمته ومؤلفاته في المكتبة.'));
  }

  async onShow(arg) {
    if (!this.authors) {
      this.list.append(spinnerRow());
      this.authors = await this.app.db('authors');
      this.norm = new Map(this.authors.map((a) => [a.id, normalize(a.name)]));
      this.renderList();
    }
    if (arg?.author) this.show(arg.author);
  }

  renderList() {
    const q = normalize(this.filter.value.trim());
    let list = this.authors;
    if (q) list = list.filter((a) => q.split(/\s+/).every((w) => this.norm.get(a.id).includes(w)));
    const s = this.sort.value;
    const coll = new Intl.Collator('ar');
    list = [...list].sort((a, b) =>
      s === 'name' ? coll.compare(a.name, b.name) : s === 'books' ? b.books - a.books : deathSortKey(a.death, a.deathText) - deathSortKey(b.death, b.deathText) || coll.compare(a.name, b.name),
    );
    this.count.textContent = `${num(list.length)} مؤلفًا`;
    clear(this.list);
    const frag = document.createDocumentFragment();
    for (const a of list.slice(0, 1500)) {
      frag.append(
        h(
          'button',
          { class: 'list-btn', dataset: { id: a.id }, 'aria-current': String(a.id === this.current), onclick: () => this.show(a.id) },
          h('span', { class: 't', title: a.name, text: a.name }),
          h('span', { class: 'n', text: deathLabel(a.death, a.deathText) }),
        ),
      );
    }
    this.list.append(frag);
  }

  async show(id) {
    this.current = id;
    for (const b of this.list.querySelectorAll('.list-btn')) b.setAttribute('aria-current', String(Number(b.dataset.id) === id));
    this.list.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    clear(this.detail).append(spinnerRow());
    const a = await this.app.db('author', id);
    if (this.current !== id) return;
    if (!a) {
      clear(this.detail).append(emptyState('users', 'المؤلف غير موجود'));
      return;
    }
    const grid = h('div', { class: 'grid', style: { padding: '0' } });
    for (const b of a.books) grid.append(this.bookCard(b));
    const contrib = a.contributions.length
      ? h(
          'div',
          { class: 'info-section' },
          h('h3', { text: 'مشاركات أخرى (تحقيق، تقديم، مراجعة…)' }),
          h('div', { class: 'results' }, a.contributions.map((c) => h('button', { class: 'result compact', onclick: () => this.app.openBook(c.id) }, h('div', { class: 'rh' }, h('span', { class: 'rb', text: c.name }), h('span', { class: 'rl', text: c.role || '' }))))),
        )
      : null;
    clear(this.detail).append(
      h(
        'div',
        { style: { maxWidth: '980px', margin: '0 auto', padding: '24px 28px 60px' } },
        h('h2', { style: { fontFamily: 'var(--read-font)', fontSize: '26px', margin: '0 0 4px', lineHeight: 1.5 }, text: a.name }),
        h('div', { class: 'muted', text: deathLabel(a.death, a.deathText) }),
        a.bio ? h('div', { class: 'info-section' }, h('h3', { text: 'الترجمة' }), h('div', { class: 'prose', style: { fontSize: '17.5px' }, text: a.bio })) : null,
        h('div', { class: 'info-section' }, h('h3', { text: `مؤلفاته في المكتبة (${num(a.books.length)})` }), grid),
        contrib,
      ),
    );
    this.detail.scrollTop = 0;
  }

  bookCard(b) {
    const meta = this.app.bookMap.get(b.id) || b;
    return h(
      'div',
      { class: 'card', role: 'button', tabindex: '0', title: b.name, onclick: () => this.app.openBook(b.id), onkeydown: (e) => e.key === 'Enter' && this.app.openBook(b.id) },
      coverEl(meta),
      h('div', { class: 't', text: b.name }),
      h('div', { class: 's', text: `${num(b.pages)} صفحة` }),
    );
  }
}
