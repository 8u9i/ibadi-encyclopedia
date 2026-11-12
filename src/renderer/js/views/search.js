import { h, icon, clear, modal, num, pageLabel, spinnerRow, emptyState, snippetEl, appendHighlighted } from '../dom.js';
import { highlightRegex, phraseRegex, normalize } from '../../shared/arabic.js';

const MODES = [
  ['all', 'كل الكلمات'],
  ['any', 'أيّ كلمة'],
  ['phrase', 'عبارة متّصلة'],
  ['root', 'بالجذر'],
];

export class SearchView {
  constructor(app) {
    this.app = app;
    this.opts = { mode: 'all', flexible: true, foot: true, target: 'text', order: 'book' };
    this.scope = { cats: new Set(), books: new Set() };
    this.facet = null; // restrict to one book from facets
    this.state = null;
    this.build();
  }

  build() {
    this.input = h('input', { class: 'input', type: 'search', placeholder: 'اكتب كلمات البحث… (يدعم * في آخر الكلمة للبحث ببدايتها)', list: 'search-history', autocomplete: 'off' });
    this.datalist = h('datalist', { id: 'search-history' });
    this.input.addEventListener('keydown', (e) => e.key === 'Enter' && this.run());
    const go = h('button', { class: 'btn primary', onclick: () => this.run() }, icon('search'), 'ابحث');

    this.modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'نوع البحث' });
    for (const [m, label] of MODES) {
      const b = h('button', { 'aria-pressed': String(this.opts.mode === m), text: label });
      b.addEventListener('click', () => {
        this.opts.mode = m;
        for (const x of this.modeSeg.children) x.setAttribute('aria-pressed', String(x === b));
        this.flexLabel.hidden = m === 'phrase' || m === 'root';
        if (this.input.value.trim()) this.run();
      });
      this.modeSeg.append(b);
    }
    this.targetSeg = h('div', { class: 'seg' });
    for (const [t, label] of [['text', 'النصوص'], ['titles', 'العناوين']]) {
      const b = h('button', { 'aria-pressed': String(this.opts.target === t), text: label });
      b.addEventListener('click', () => {
        this.opts.target = t;
        for (const x of this.targetSeg.children) x.setAttribute('aria-pressed', String(x === b));
        if (this.input.value.trim()) this.run();
      });
      this.targetSeg.append(b);
    }
    const check = (key, label, title) => {
      const c = h('input', { type: 'checkbox', checked: this.opts[key] });
      c.addEventListener('change', () => {
        this.opts[key] = c.checked;
        if (this.input.value.trim()) this.run();
      });
      return h('label', { class: 'check', title }, c, label);
    };
    this.flexLabel = check('flexible', 'مطابقة مرنة', 'تطابق الكلمة مع السوابق: و، ف، ب، ك، ل، ال — مثل: العلم، والعلم، بالعلم، للعلم');
    const footLabel = check('foot', 'يشمل الحواشي', 'البحث في الحواشي أيضًا');
    this.orderSel = h('select', { class: 'select', title: 'ترتيب النتائج' }, h('option', { value: 'book', text: 'ترتيب الكتب' }), h('option', { value: 'rank', text: 'الأكثر صلة' }));
    this.orderSel.addEventListener('change', () => {
      this.opts.order = this.orderSel.value;
      if (this.input.value.trim()) this.run();
    });
    this.scopeBtn = h('button', { class: 'btn', onclick: () => this.scopeDialog() }, icon('filter'), h('span', { text: 'نطاق البحث: كل المكتبة' }));

    this.summary = h('div', { class: 's-summary', hidden: true });
    this.facets = h('nav', { class: 'side facets', hidden: true });
    this.results = h('div', { class: 'content' });
    this.results.append(this.welcome());

    this.el = h(
      'section',
      null,
      h('div', { class: 'pane-head' }, h('h1', { text: 'البحث في المكتبة' })),
      h(
        'div',
        { class: 's-form' },
        h('div', { class: 's-row' }, h('div', { class: 'search-field' }, icon('search'), this.input), go, this.datalist),
        h('div', { class: 's-row' }, this.modeSeg, this.flexLabel, footLabel, h('span', { style: { flex: 1 } }), this.targetSeg, this.orderSel, this.scopeBtn),
      ),
      this.summary,
      h('div', { class: 'split' }, this.facets, this.results),
    );
  }

  welcome() {
    const tips = [
      ['كل الكلمات', 'صفحات تحتوي جميع الكلمات في أيّ موضع منها.'],
      ['عبارة متّصلة', 'الكلمات متتالية كما كُتبت.'],
      ['بالجذر', 'يبحث بكلّ الصيغ المشتقّة من جذر الكلمة: «كتب» ← كتاب، مكتوب، الكاتب…'],
      ['مطابقة مرنة', 'تتجاهل الحركات والهمزات والتاء المربوطة، وتطابق السوابق: و، ف، ب، ل، ال.'],
      ['النجمة *', 'في آخر الكلمة للبحث ببدايتها: «اباض*».'],
    ];
    return h(
      'div',
      { class: 'empty', style: { maxWidth: '640px', margin: '0 auto', textAlign: 'start' } },
      icon('search'),
      h('h3', { text: 'البحث في نصوص المكتبة كاملة' }),
      h('table', { class: 'table' }, h('tbody', null, tips.map(([k, v]) => h('tr', null, h('td', { style: { fontWeight: 600, whiteSpace: 'nowrap' }, text: k }), h('td', { class: 'muted', text: v }))))),
    );
  }

  async onShow(arg) {
    const hist = await this.app.db('userSearchHistory').catch(() => []);
    clear(this.datalist).append(...hist.map((q) => h('option', { value: q })));
    if (arg?.q) {
      this.input.value = arg.q;
      this.run();
    }
    if (arg?.focus || !this.state) setTimeout(() => this.input.focus(), 30);
  }

  scopeIds() {
    return { cats: [...this.scope.cats], books: this.facet ? [this.facet] : [...this.scope.books] };
  }

  updateScopeLabel() {
    const c = this.scope.cats.size;
    const b = this.scope.books.size;
    const parts = [];
    if (c) parts.push(`${num(c)} تصنيف`);
    if (b) parts.push(`${num(b)} كتاب`);
    this.scopeBtn.lastChild.textContent = 'نطاق البحث: ' + (parts.length ? parts.join(' + ') : 'كل المكتبة');
    this.scopeBtn.classList.toggle('primary', parts.length > 0);
  }

  async run(more = false) {
    const q = this.input.value.trim();
    if (!q) return;
    if (!more) {
      this.facet = null;
      this.state = { q, offset: 0, results: [], total: 0 };
      this.app.db('userAddSearch', q).catch(() => {});
      clear(this.results).append(spinnerRow());
    }
    const st = this.state;
    const my = (this.runId = (this.runId || 0) + 1);
    try {
      if (this.opts.target === 'titles') {
        const r = await this.app.db('searchTitles', { q, mode: this.opts.mode, flexible: this.opts.flexible, ...this.scopeIds() });
        if (my !== this.runId) return;
        this.renderTitles(r);
        return;
      }
      const r = await this.app.db('search', {
        q,
        mode: this.opts.mode,
        flexible: this.opts.flexible,
        foot: this.opts.foot,
        order: this.opts.order,
        offset: st.offset,
        limit: 40,
        ...this.scopeIds(),
      });
      if (my !== this.runId) return;
      if (r.total != null) {
        st.total = r.total;
        st.words = r.words;
        st.flexible = r.flexible;
        st.phrase = r.phrase;
        st.roots = r.roots;
        if (!this.facet) st.facets = r.facets;
      }
      st.results = st.results.concat(r.results);
      st.offset += r.results.length;
      this.renderResults();
    } catch (e) {
      clear(this.results).append(emptyState('info', 'تعذّر البحث', e.message));
    }
  }

  renderSummary(text, extra = []) {
    this.summary.hidden = false;
    clear(this.summary).append(h('strong', { text }), ...extra);
  }

  renderResults() {
    const st = this.state;
    const books = st.facets?.length || 0;
    const extra = [];
    if (st.roots?.length) {
      for (const r of st.roots) extra.push(h('span', { class: 'chip accent', text: r.roots.length ? `جذر «${r.word}»: ${r.roots.join('، ')} — ${num(r.count)} صيغة` : `«${r.word}»: لا جذر معروف` }));
    }
    if (this.facet) {
      extra.push(
        h('span', { class: 'chip accent' }, `في: ${this.app.bookMap.get(this.facet)?.name || ''}`, h('button', { title: 'إلغاء', onclick: () => this.selectFacet(null) }, icon('close'))),
      );
    }
    this.renderSummary(st.total ? `${num(st.total)} صفحة مطابقة${books && !this.facet ? ` في ${num(books)} كتابًا` : ''}` : 'لا نتائج', extra);
    this.renderFacets();

    if (!st.results.length) {
      clear(this.results).append(emptyState('search', 'لا نتائج', this.opts.flexible ? 'جرّب البحث بالجذر أو بكلمات أقلّ.' : 'جرّب تفعيل المطابقة المرنة أو البحث بالجذر.'));
      return;
    }
    const list = h('div', { class: 'results' });
    for (const r of st.results) list.append(this.resultEl(r, st));
    if (st.results.length < (this.facet ? this.facetTotal : st.total)) {
      const more = h('button', { class: 'btn', text: 'المزيد من النتائج' });
      more.addEventListener('click', () => {
        more.replaceWith(spinnerRow());
        this.run(true);
      });
      list.append(h('div', { class: 'loading-row' }, more));
    }
    const top = this.results.scrollTop;
    clear(this.results).append(list);
    this.results.scrollTop = top;
  }

  resultEl(r, st) {
    const parts = this.app.bookMap.get(r.book)?.parts || 1;
    const loc = pageLabel(r.part, r.num, parts);
    return h(
      'button',
      {
        class: 'result',
        onclick: (e) => this.app.openBook(r.book, { pid: r.pid }, { words: st.words, flexible: st.flexible, phrase: st.phrase }, { newTab: e.ctrlKey }),
        title: 'انقر لفتح الصفحة (Ctrl+نقرة لفتحها في لسان جديد)',
      },
      h('div', { class: 'rh' }, h('span', { class: 'rb', text: r.bookName }), r.inFoot ? h('span', { class: 'tag', text: 'حاشية' }) : null, h('span', { class: 'rl num', text: loc })),
      snippetEl(r.snippet),
    );
  }

  renderFacets() {
    const st = this.state;
    const f = st.facets || [];
    this.facets.hidden = f.length < 2;
    if (f.length < 2) return;
    clear(this.facets).append(
      h('div', { class: 'side-title', text: 'النتائج حسب الكتاب' }),
      h('button', { class: 'list-btn', 'aria-current': String(!this.facet), onclick: () => this.selectFacet(null) }, h('span', { class: 't', text: 'كل الكتب' }), h('span', { class: 'n', text: num(st.total) })),
      ...f.slice(0, 400).map((x) =>
        h('button', { class: 'list-btn', title: x.name, 'aria-current': String(this.facet === x.book), onclick: () => this.selectFacet(x.book, x.count) }, h('span', { class: 't', text: x.name }), h('span', { class: 'n', text: num(x.count) })),
      ),
    );
  }

  selectFacet(book, count) {
    this.facet = book;
    this.facetTotal = count || 0;
    const st = this.state;
    st.offset = 0;
    st.results = [];
    clear(this.results).append(spinnerRow());
    this.runFacet();
  }

  async runFacet() {
    const st = this.state;
    if (!this.facet) {
      // back to all books
      const q = st.q;
      this.input.value = q;
      return this.run();
    }
    const r = await this.app.db('search', { q: st.q, mode: this.opts.mode, flexible: this.opts.flexible, foot: this.opts.foot, order: this.opts.order, offset: 0, limit: 40, book: this.facet });
    st.results = r.results;
    st.offset = r.results.length;
    this.renderResults();
  }

  renderTitles(r) {
    const words = r.words;
    const re = r.phrase ? phraseRegex(words) : highlightRegex(words, r.flexible);
    this.renderSummary(r.results.length ? `${num(r.results.length)}${r.results.length >= 1000 ? '+' : ''} عنوانًا مطابقًا` : 'لا نتائج');
    this.facets.hidden = true;
    if (!r.results.length) {
      clear(this.results).append(emptyState('toc', 'لا عناوين مطابقة'));
      return;
    }
    const list = h('div', { class: 'results' });
    for (const t of r.results) {
      list.append(
        h(
          'button',
          { class: 'result', onclick: () => this.app.openBook(t.book, { pid: t.pid }, { words, flexible: r.flexible, phrase: r.phrase }) },
          h('div', { class: 'rh' }, h('span', { class: 'rb', text: t.bookName })),
          appendHighlighted(h('div', { class: 'rs' }), t.text, re),
        ),
      );
    }
    clear(this.results).append(list);
  }

  scopeDialog() {
    const filter = h('input', { class: 'input', type: 'search', placeholder: 'تصفية الكتب…', style: { width: '100%' } });
    const catBox = h('div', { class: 'scope-box' });
    for (const c of this.app.categories) {
      const cb = h('input', { type: 'checkbox', checked: this.scope.cats.has(c.id) });
      cb.addEventListener('change', () => (cb.checked ? this.scope.cats.add(c.id) : this.scope.cats.delete(c.id)));
      catBox.append(h('label', { class: 'check' }, cb, `${c.name} (${num(c.count)})`));
    }
    const bookBox = h('div', { class: 'scope-box', style: { gridTemplateColumns: '1fr' } });
    const selectedOnly = h('input', { type: 'checkbox' });
    const renderBooks = () => {
      const q = normalize(filter.value.trim());
      clear(bookBox);
      let n = 0;
      for (const b of this.app.books) {
        if (selectedOnly.checked && !this.scope.books.has(b.id)) continue;
        if (q && !normalize(b.name + ' ' + (b.author || '')).includes(q)) continue;
        if (++n > 300) break;
        const cb = h('input', { type: 'checkbox', checked: this.scope.books.has(b.id) });
        cb.addEventListener('change', () => (cb.checked ? this.scope.books.add(b.id) : this.scope.books.delete(b.id)));
        bookBox.append(h('label', { class: 'check', style: { color: 'var(--text)' } }, cb, b.name, h('span', { class: 'faint', text: b.author ? ` — ${b.author}` : '' })));
      }
      if (!n) bookBox.append(h('div', { class: 'faint', style: { padding: '8px' }, text: 'لا كتب مطابقة' }));
    };
    filter.addEventListener('input', renderBooks);
    selectedOnly.addEventListener('change', renderBooks);
    renderBooks();
    const clearBtn = h('button', { class: 'btn ghost', text: 'كل المكتبة' });
    const done = h('button', { class: 'btn primary', text: 'تطبيق' });
    const dlg = modal({
      title: 'نطاق البحث',
      body: h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('strong', { text: 'التصنيفات' }),
        catBox,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('strong', { text: 'كتب محدّدة', style: { flex: 1 } }), h('label', { class: 'check' }, selectedOnly, 'المحدّدة فقط')),
        filter,
        bookBox,
        h('div', { class: 'faint', text: 'يُبحث في اتّحاد التصنيفات والكتب المحدّدة. اترك الكلّ فارغًا للبحث في المكتبة كاملة.' }),
      ),
      foot: [clearBtn, done],
    });
    clearBtn.addEventListener('click', () => {
      this.scope.cats.clear();
      this.scope.books.clear();
      dlg.close();
    });
    done.addEventListener('click', () => dlg.close());
    dlg.done.then(() => {
      this.updateScopeLabel();
      if (this.input.value.trim()) this.run();
    });
  }
}

