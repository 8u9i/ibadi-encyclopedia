import { h, icon, clear, modal, toast, num, pageLabel, debounce, spinnerRow, emptyState, snippetEl, appendHighlighted } from '../dom.js';
import { renderPage, wireFootnotes } from '../text.js';
import { highlightRegex, phraseRegex, normalize } from '../../shared/arabic.js';

const KEEP_PAGES = 14; // continuous mode: max pages kept in the DOM

export class ReaderView {
  constructor(app, bookId) {
    this.app = app;
    this.bookId = bookId;
    this.meta = app.bookMap.get(bookId);
    this.book = null;
    this.current = null;
    this.mode = app.settings.readerMode === 'continuous' ? 'continuous' : 'single';
    this.hl = null;
    this.re = null;
    this.panel = null;
    this.toc = null;
    this.loading = 0;
    this.searchState = { q: '', mode: 'all', flexible: true, offset: 0, total: 0 };
    this.build();
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
  }

  // -------------------------------------------------------------- layout
  build() {
    const b = this.meta;
    this.titleEl = h('div', { class: 't', text: b.name });
    this.crumbsEl = h('div', { class: 'crumbs' });
    const tb = (iconName, title, onclick, extra = {}) =>
      h('button', { class: 'icon-btn', title, 'aria-label': title, onclick, ...extra }, icon(iconName));

    this.btnToc = tb('toc', 'الفهرس (Ctrl+T)', () => this.togglePanel('toc'));
    this.btnSearch = tb('search', 'البحث في الكتاب (Ctrl+F)', () => this.togglePanel('search'));
    this.btnMarks = tb('bookmark', 'العلامات والملاحظات', () => this.togglePanel('marks'));
    this.btnMode = tb(this.mode === 'single' ? 'scroll' : 'page', '', () => this.toggleMode());
    this.btnMark = tb('bookmark', 'إضافة علامة لهذه الصفحة (Ctrl+D)', () => this.addBookmark());
    this.btnFav = tb('star', 'المفضّلة', async () => {
      const on = await this.app.toggleFavorite(this.bookId);
      this.btnFav.setAttribute('aria-pressed', String(on));
    });
    this.btnFav.setAttribute('aria-pressed', String(this.app.isFavorite(this.bookId)));
    this.btnPdf = tb('pdf', 'عرض المصوَّرة (PDF) لهذه الصفحة — يتطلّب اتصالًا بالإنترنت', () => this.openPdf());
    this.btnPdf.hidden = true;
    this.updateModeButton();

    const toolbar = h(
      'div',
      { class: 'r-toolbar' },
      this.btnToc,
      this.btnSearch,
      this.btnMarks,
      h('div', { class: 'r-sep' }),
      h('div', { class: 'r-title' }, this.titleEl, this.crumbsEl),
      this.btnMode,
      tb('minus', 'تصغير الخط (Ctrl+-)', () => this.fontStep(-1)),
      tb('textSize', 'حجم الخط الافتراضي', () => this.fontStep(0)),
      tb('plus', 'تكبير الخط (Ctrl+=)', () => this.fontStep(1)),
      h('div', { class: 'r-sep' }),
      this.btnMark,
      this.btnFav,
      this.btnPdf,
      tb('copy', 'نسخ الصفحة مع التوثيق', () => this.copyPage()),
      tb('info', 'بطاقة الكتاب', () => this.app.bookInfo(this.bookId)),
    );

    this.panelEl = h('aside', { class: 'r-panel', hidden: true });
    this.scroll = h('div', { class: 'r-scroll', tabindex: '-1' });
    wireFootnotes(this.scroll);
    this.scroll.addEventListener('scroll', debounce(() => this.onScroll(), 90), { passive: true });

    this.posInput = h('input', { class: 'input num', type: 'text', inputmode: 'numeric', title: 'رقم الصفحة — اضغط Enter للانتقال' });
    this.posTotal = h('span', { class: 'num' });
    this.posInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = Number(String(this.posInput.value).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
        if (Number.isFinite(v) && v > 0) this.goto({ index: v });
      }
    });
    this.slider = h('input', { type: 'range', min: '1', max: '1', value: '1', title: 'التنقّل في الكتاب', 'aria-label': 'موضع القراءة' });
    this.slider.addEventListener('input', () => {
      this.posInput.value = this.slider.value;
    });
    this.slider.addEventListener('change', () => this.goto({ index: Number(this.slider.value) }));
    this.locEl = h('span', { class: 'chip num' });

    const nav = h(
      'div',
      { class: 'r-nav' },
      h('button', { class: 'icon-btn', title: 'أول الكتاب (Home)', onclick: () => this.goto({ index: 1 }) }, icon('chevronsRight')),
      h('button', { class: 'icon-btn', title: 'الصفحة السابقة (→)', onclick: () => this.step(-1) }, icon('chevronRight')),
      h('div', { class: 'pos' }, h('span', { text: 'صفحة' }), this.posInput, h('span', { text: 'من' }), this.posTotal),
      this.slider,
      this.locEl,
      h('button', { class: 'btn ghost sm', title: 'الانتقال إلى جزء وصفحة (Ctrl+G)', onclick: () => this.gotoDialog() }, icon('goto'), 'انتقال'),
      h('button', { class: 'icon-btn', title: 'الصفحة التالية (←)', onclick: () => this.step(1) }, icon('chevronLeft')),
      h('button', { class: 'icon-btn', title: 'آخر الكتاب (End)', onclick: () => this.goto({ last: true }) }, icon('chevronsLeft')),
    );

    this.el = h('section', { class: 'reader' }, toolbar, h('div', { class: 'r-body' }, this.panelEl, this.scroll), nav);
  }

  // -------------------------------------------------------------- lifecycle
  onShow() {
    if (this.deferredLoc) {
      const loc = this.deferredLoc;
      this.deferredLoc = null;
      this.open(loc);
    }
    requestAnimationFrame(() => {
      if (!this.el.contains(document.activeElement)) this.scroll.focus({ preventScroll: true });
    });
  }

  dispose() {
    document.removeEventListener('keydown', this.onKey);
    this.savePosition.cancel?.();
    if (this.current) this.app.db('userSavePosition', this.bookId, this.current.pid).catch(() => {});
  }

  /** The book's text was updated by a sync: reload it at the same page id. */
  reloadBook() {
    const loc = this.current ? { pid: this.current.pid } : { index: 1 };
    this.book = null;
    this.toc = null;
    this.meta = this.app.bookMap.get(this.bookId) || this.meta;
    this.titleEl.textContent = this.meta.name;
    if (this.el.hidden) this.deferredLoc = loc;
    else this.open(loc);
    if (this.panel) this.renderPanel();
  }

  async open(loc, hl) {
    this.scroll.replaceChildren(spinnerRow());
    try {
      this.book = await this.app.db('book', this.bookId);
    } catch (e) {
      this.scroll.replaceChildren(emptyState('info', 'تعذّر فتح الكتاب', e.message));
      return;
    }
    this.btnPdf.hidden = !this.book.hasPdf;
    this.slider.max = String(this.book.pages || 1);
    this.posTotal.textContent = num(this.book.pages || 0);
    if (this.app.settings.readerPanelOpen && !this.panel) this.togglePanel('toc');
    await this.goto(loc, hl);
  }

  // -------------------------------------------------------------- navigation
  async goto(loc, hl) {
    if (!this.book) {
      this.deferredLoc = null;
      return this.open(loc, hl);
    }
    if (hl !== undefined) this.setHighlight(hl);
    const my = ++this.loading;
    let page;
    try {
      page = await this.app.db('page', this.bookId, loc || { index: 1 });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    if (my !== this.loading || !page) return;
    if (this.mode === 'continuous') await this.showContinuous(page, loc);
    else this.showSingle(page, loc);
  }

  step(delta) {
    if (!this.current) return;
    if (this.mode === 'continuous') {
      const target = this.current.index + delta;
      if (target < 1 || target > this.book.pages) return;
      const el = this.scroll.querySelector(`.page[data-rid="${this.current.rid + delta}"]`);
      if (el) {
        this.scroll.scrollTop = el.offsetTop - 4;
        return;
      }
      this.goto({ index: target });
      return;
    }
    const target = this.current.index + delta;
    if (target < 1 || target > this.book.pages) {
      toast(delta > 0 ? 'هذه آخر صفحة في الكتاب' : 'هذه أول صفحة في الكتاب');
      return;
    }
    this.goto({ index: target });
  }

  pageFooter(page) {
    const label = pageLabel(page.part, page.num, this.book.parts?.length || 1);
    return h('div', { class: 'page-foot' }, h('span', { class: 'pg num', text: label || `${num(page.index)}` }));
  }

  showSingle(page, loc) {
    const el = renderPage(page, { re: this.re, footer: this.pageFooter(page) });
    this.scroll.replaceChildren(el);
    this.scroll.scrollTop = 0;
    this.setCurrent(page);
    this.afterRender(loc);
  }

  async showContinuous(page, loc) {
    const wrap = h('div', { class: 'cont' });
    wrap.append(this.contPage(page));
    this.scroll.replaceChildren(wrap);
    this.contWrap = wrap;
    this.contFirst = page.rid;
    this.contLast = page.rid;
    this.setCurrent(page);
    await this.loadMore(1);
    this.afterRender(loc);
    // Load a page above lazily, keeping the position stable.
    this.ensureObservers();
  }

  contPage(page) {
    return renderPage(page, { re: this.re, footer: this.pageFooter(page) });
  }

  ensureObservers() {
    if (this.io) this.io.disconnect();
    const top = h('div', { style: { height: '1px' } });
    const bottom = h('div', { style: { height: '1px' } });
    this.contWrap.before(top);
    this.contWrap.after(bottom);
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target === bottom) this.loadMore(1);
          else this.loadMore(-1);
        }
      },
      { root: this.scroll, rootMargin: '900px 0px' },
    );
    this.io.observe(top);
    this.io.observe(bottom);
  }

  async loadMore(dir) {
    if (this.mode !== 'continuous' || !this.contWrap || this.contBusy) return;
    const b = this.book;
    const first = this.contFirst;
    const last = this.contLast;
    const fromRid = dir > 0 ? last + 1 : first - 1;
    const minRid = this.current.rid - this.current.index + 1;
    const maxRid = minRid + b.pages - 1;
    if (fromRid < minRid || fromRid > maxRid) return;
    this.contBusy = true;
    try {
      const pages = await this.app.db('pages', this.bookId, fromRid, dir > 0 ? 3 : -3);
      if (this.mode !== 'continuous' || !this.contWrap) return;
      if (dir > 0) {
        for (const p of pages) this.contWrap.append(this.contPage(p));
        if (pages.length) this.contLast = pages[pages.length - 1].rid;
      } else {
        const before = this.scroll.scrollHeight;
        const top = this.scroll.scrollTop;
        const frag = document.createDocumentFragment();
        for (const p of pages) frag.append(this.contPage(p));
        this.contWrap.prepend(frag);
        if (pages.length) this.contFirst = pages[0].rid;
        this.scroll.scrollTop = top + (this.scroll.scrollHeight - before);
      }
      this.prune();
    } finally {
      this.contBusy = false;
    }
  }

  prune() {
    const pages = [...this.contWrap.children];
    if (pages.length <= KEEP_PAGES) return;
    const cur = this.current.rid;
    const far = pages.filter((p) => Math.abs(Number(p.dataset.rid) - cur) > KEEP_PAGES / 2);
    for (const p of far) {
      const rid = Number(p.dataset.rid);
      if (rid < cur) {
        const hgt = p.offsetHeight;
        p.remove();
        this.scroll.scrollTop -= hgt;
      } else p.remove();
    }
    const rest = [...this.contWrap.children];
    if (rest.length) {
      this.contFirst = Number(rest[0].dataset.rid);
      this.contLast = Number(rest[rest.length - 1].dataset.rid);
    }
  }

  onScroll() {
    if (this.mode !== 'continuous' || !this.contWrap) return;
    const top = this.scroll.getBoundingClientRect().top + 60;
    let best = null;
    for (const p of this.contWrap.children) {
      const r = p.getBoundingClientRect();
      if (r.top <= top && r.bottom > top) {
        best = p;
        break;
      }
      if (r.top > top) {
        best = best || p;
        break;
      }
      best = p;
    }
    if (best && Number(best.dataset.rid) !== this.current?.rid) {
      const rid = Number(best.dataset.rid);
      this.app.db('page', this.bookId, { rid }).then((p) => p && this.setCurrent(p, true));
    }
  }

  afterRender(loc) {
    if (loc?.aya) {
      const t = this.scroll.querySelector(`.page[data-rid="${this.current.rid}"] [data-aya="${loc.aya}"]`);
      if (t) {
        t.classList.add('target');
        t.scrollIntoView({ block: 'start' });
        return;
      }
    }
    if (this.re) {
      const page = this.scroll.querySelector(`.page[data-rid="${this.current.rid}"]`);
      const m = page?.querySelector('mark');
      if (m) m.scrollIntoView({ block: 'center' });
      else if (this.mode === 'continuous' && page) this.scroll.scrollTop = page.offsetTop - 4;
    } else if (this.mode === 'continuous') {
      const page = this.scroll.querySelector(`.page[data-rid="${this.current.rid}"]`);
      if (page) this.scroll.scrollTop = page.offsetTop - 4;
    }
  }

  setCurrent(page, fromScroll = false) {
    this.current = page;
    this.posInput.value = num(page.index);
    this.slider.value = String(page.index);
    const label = pageLabel(page.part, page.num, this.book.parts?.length || 1);
    this.locEl.textContent = label || '—';
    this.locEl.hidden = !label;
    this.crumbsEl.textContent = page.path.map((t) => t.text).join(' ‹ ');
    this.crumbsEl.title = this.crumbsEl.textContent;
    this.savePosition();
    this.app.saveTabs();
    this.refreshPageMark();
    if (this.panel === 'toc') this.markToc(!fromScroll);
  }

  savePosition = debounce(() => {
    if (this.current) this.app.db('userSavePosition', this.bookId, this.current.pid).catch(() => {});
  }, 800);

  async refreshPageMark() {
    const page = this.current;
    const marks = await this.app.db('userPageBookmarks', this.bookId, page.pid).catch(() => []);
    if (page !== this.current) return;
    this.btnMark.setAttribute('aria-pressed', String(marks.length > 0));
    this.btnMark.title = marks.length ? 'لهذه الصفحة علامة — انقر لإضافة أخرى' : 'إضافة علامة لهذه الصفحة (Ctrl+D)';
  }

  setHighlight(hl) {
    this.hl = hl && hl.words?.length ? hl : null;
    this.re = !this.hl ? null : this.hl.phrase ? phraseRegex(this.hl.words) : highlightRegex(this.hl.words, this.hl.flexible !== false);
  }

  toggleMode() {
    this.mode = this.mode === 'single' ? 'continuous' : 'single';
    this.app.setSetting('readerMode', this.mode);
    this.updateModeButton();
    if (this.io) this.io.disconnect();
    this.io = null;
    this.contWrap = null;
    if (this.current) this.goto({ rid: this.current.rid });
  }

  updateModeButton() {
    clear(this.btnMode).append(icon(this.mode === 'single' ? 'scroll' : 'page'));
    this.btnMode.title = this.mode === 'single' ? 'القراءة المتّصلة (تمرير مستمر)' : 'القراءة صفحةً صفحة';
  }

  fontStep(d) {
    const s = this.app.settings;
    const size = d === 0 ? 22 : Math.max(14, Math.min(44, s.readSize + d * 2));
    this.app.setSetting('readSize', size);
  }

  // -------------------------------------------------------------- keyboard
  handleKey(e) {
    if (this.el.hidden || document.querySelector('dialog[open]')) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      e.preventDefault();
      this.openSearch(String(getSelection() || '').trim());
    } else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      this.gotoDialog();
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.addBookmark();
    } else if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault();
      this.togglePanel('toc');
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.fontStep(1);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      this.fontStep(-1);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      this.fontStep(0);
    } else if (typing || mod || e.altKey) {
      return;
    } else if (e.key === 'ArrowLeft' || e.key === 'PageDown') {
      if (this.mode === 'continuous' && e.key === 'PageDown') return;
      e.preventDefault();
      this.step(1);
    } else if (e.key === 'ArrowRight' || e.key === 'PageUp') {
      if (this.mode === 'continuous' && e.key === 'PageUp') return;
      e.preventDefault();
      this.step(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.goto({ index: 1 });
    } else if (e.key === 'End') {
      e.preventDefault();
      this.goto({ last: true });
    } else if (e.key === 'Escape' && this.hl) {
      this.setHighlight(null);
      if (this.current) this.goto({ rid: this.current.rid });
    }
  }

  // -------------------------------------------------------------- side panel
  togglePanel(name) {
    if (this.panel === name) {
      this.panel = null;
      this.panelEl.hidden = true;
      this.app.setSetting('readerPanelOpen', false);
    } else {
      this.panel = name;
      this.panelEl.hidden = false;
      if (name === 'toc') this.app.setSetting('readerPanelOpen', true);
      this.renderPanel();
    }
    this.btnToc.setAttribute('aria-pressed', String(this.panel === 'toc'));
    this.btnSearch.setAttribute('aria-pressed', String(this.panel === 'search'));
    this.btnMarks.setAttribute('aria-pressed', String(this.panel === 'marks'));
  }

  renderPanel() {
    clear(this.panelEl);
    if (this.panel === 'toc') this.renderToc();
    else if (this.panel === 'search') this.renderSearch();
    else if (this.panel === 'marks') this.renderMarks();
  }

  panelHead(title) {
    return h(
      'div',
      { class: 'r-panel-head' },
      h('strong', { style: { flex: 1 }, text: title }),
      h('button', { class: 'icon-btn', title: 'إغلاق', onclick: () => this.togglePanel(this.panel) }, icon('close')),
    );
  }

  // ---- TOC
  async renderToc() {
    const body = h('div', { class: 'r-panel-body' }, spinnerRow());
    const filter = h('input', { class: 'input', placeholder: 'تصفية العناوين…', type: 'search' });
    this.panelEl.append(this.panelHead('الفهرس'), h('div', { class: 'panel-filter' }, h('div', { class: 'search-field' }, icon('filter'), filter)), body);
    if (!this.toc) this.toc = await this.app.db('toc', this.bookId);
    if (this.panel !== 'toc') return;
    const toc = this.toc;
    if (!toc.length) {
      body.replaceChildren(emptyState('toc', 'لا فهرس لهذا الكتاب'));
      return;
    }
    const children = new Map();
    for (const t of toc) {
      const p = t.parent || 0;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(t);
    }
    const byTid = new Map(toc.map((t) => [t.tid, t]));
    // titles whose parent is missing become roots
    for (const t of toc) if (t.parent && !byTid.has(t.parent)) children.get(0)?.push(t) ?? children.set(0, [t]);
    this.tocChildren = children;
    this.tocById = byTid;
    this.tocBody = body;
    const tree = h('ul', { class: 'toc' });
    this.fillTocLevel(tree, children.get(0) || toc.filter((t) => !t.parent));
    body.replaceChildren(tree);
    this.markToc(true);

    filter.addEventListener(
      'input',
      debounce(() => {
        const q = normalize(filter.value.trim());
        if (!q) {
          body.replaceChildren(tree);
          this.markToc(true);
          return;
        }
        const re = highlightRegex(q.split(/\s+/), false);
        const list = h('ul', { class: 'toc' });
        let n = 0;
        for (const t of toc) {
          if (!normalize(t.text).includes(q)) continue;
          if (++n > 400) break;
          list.append(h('li', null, h('div', { class: 'row' }, h('button', { class: 'tl', onclick: () => this.goto({ pid: t.pid }) }, appendHighlighted(h('span'), t.text, re)))));
        }
        body.replaceChildren(n ? list : emptyState('filter', 'لا عناوين مطابقة'));
      }, 150),
    );
  }

  fillTocLevel(ul, items) {
    for (const t of items) {
      const kids = this.tocChildren.get(t.tid);
      const li = h('li', { dataset: { tid: t.tid } });
      const btn = h('button', { class: 'tl', dataset: { tid: t.tid }, onclick: () => this.goto({ pid: t.pid }), text: t.text });
      const tw = h('button', { class: 'tw', 'aria-label': 'توسيع' }, kids ? icon('chevronDown') : null);
      if (kids) {
        tw.addEventListener('click', () => this.toggleTocNode(li, tw));
        tw.firstChild.style.transform = 'rotate(90deg)';
      }
      li.append(h('div', { class: 'row' }, tw, btn));
      ul.append(li);
    }
  }

  toggleTocNode(li, tw, force) {
    let sub = li.querySelector(':scope > ul');
    const open = force ?? !(sub && !sub.hidden);
    if (open && !sub) {
      sub = h('ul');
      this.fillTocLevel(sub, this.tocChildren.get(Number(li.dataset.tid)) || []);
      li.append(sub);
    }
    if (sub) sub.hidden = !open;
    if (tw.firstChild) tw.firstChild.style.transform = open ? 'rotate(0deg)' : 'rotate(90deg)';
  }

  markToc(scroll) {
    if (!this.tocBody || !this.current || !this.toc) return;
    const pid = this.current.pid;
    let cur = null;
    for (const t of this.toc) if (t.pid != null && t.pid <= pid && (!cur || t.pid >= cur.pid)) cur = t;
    for (const el of this.tocBody.querySelectorAll('.tl[aria-current="true"]')) el.removeAttribute('aria-current');
    if (!cur) return;
    // expand ancestors
    const chain = [];
    let t = cur;
    let guard = 0;
    while (t && guard++ < 20) {
      chain.unshift(t);
      t = t.parent ? this.tocById.get(t.parent) : null;
    }
    let scope = this.tocBody.querySelector('.toc');
    for (const node of chain) {
      const li = scope?.querySelector(`:scope > li[data-tid="${node.tid}"]`);
      if (!li) break;
      if (node !== cur) this.toggleTocNode(li, li.querySelector('.tw'), true);
      if (node === cur) {
        const btn = li.querySelector(':scope > .row > .tl');
        btn.setAttribute('aria-current', 'true');
        if (scroll) btn.scrollIntoView({ block: 'center' });
      }
      scope = li.querySelector(':scope > ul');
    }
  }

  // ---- in-book search
  openSearch(text) {
    if (this.panel !== 'search') this.togglePanel('search');
    if (text) {
      this.searchInput.value = text;
      this.runSearch(true);
    }
    this.searchInput.focus();
    this.searchInput.select();
  }

  renderSearch() {
    const st = this.searchState;
    this.searchInput = h('input', { class: 'input', type: 'search', placeholder: 'ابحث في هذا الكتاب…', value: st.q });
    const modes = [
      ['all', 'كل الكلمات'],
      ['phrase', 'عبارة'],
      ['root', 'الجذر'],
    ];
    const seg = h('div', { class: 'seg' });
    for (const [m, label] of modes) {
      const btn = h('button', { 'aria-pressed': String(st.mode === m), text: label });
      btn.addEventListener('click', () => {
        st.mode = m;
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b === btn));
        if (this.searchInput.value.trim()) this.runSearch(true);
      });
      seg.append(btn);
    }
    const flex = h('input', { type: 'checkbox', checked: st.flexible });
    flex.addEventListener('change', () => {
      st.flexible = flex.checked;
      if (this.searchInput.value.trim()) this.runSearch(true);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runSearch(true);
    });
    this.searchList = h('div', { class: 'r-panel-body' });
    this.searchInfo = h('div', { class: 'faint', style: { fontSize: '12px', padding: '0 12px 6px' } });
    this.panelEl.append(
      this.panelHead('البحث في الكتاب'),
      h(
        'div',
        { class: 'panel-filter', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'search-field' }, icon('search'), this.searchInput),
        seg,
        h('label', { class: 'check', title: 'يطابق الكلمة مع السوابق مثل: و، ف، ب، ك، ل، ال' }, flex, 'مطابقة مرنة (والـ، بالـ، للـ …)'),
      ),
      this.searchInfo,
      this.searchList,
    );
    if (st.results) this.renderSearchResults(false);
  }

  async runSearch(reset) {
    const st = this.searchState;
    st.q = this.searchInput.value.trim();
    if (!st.q) return;
    if (reset) {
      st.offset = 0;
      st.results = [];
      this.searchList.replaceChildren(spinnerRow());
    }
    let r;
    try {
      r = await this.app.db('search', { q: st.q, mode: st.mode, flexible: st.flexible, book: this.bookId, offset: st.offset, limit: 60 });
    } catch (e) {
      this.searchList.replaceChildren(emptyState('info', 'تعذّر البحث', e.message));
      return;
    }
    if (reset) {
      st.total = r.total;
      st.words = r.words;
      st.flex = r.flexible;
      st.phrase = r.phrase;
      st.roots = r.roots;
    }
    st.results = st.results.concat(r.results);
    st.offset += r.results.length;
    this.renderSearchResults(reset);
  }

  renderSearchResults() {
    const st = this.searchState;
    let info = st.total ? `${num(st.total)} صفحة مطابقة` : '';
    if (st.roots?.length) info += ' · الجذر: ' + st.roots.map((r) => (r.roots.length ? r.roots.join('، ') : '—')).join(' / ');
    this.searchInfo.textContent = info;
    if (!st.results.length) {
      this.searchList.replaceChildren(emptyState('search', 'لا نتائج', 'جرّب كلمات أخرى أو فعّل المطابقة المرنة أو البحث بالجذر.'));
      return;
    }
    const ul = h('div', { class: 'results' });
    for (const r of st.results) {
      ul.append(
        h(
          'button',
          { class: 'result compact', onclick: () => this.goto({ pid: r.pid }, { words: st.words, flexible: st.flex, phrase: st.phrase }) },
          h('div', { class: 'rh' }, h('span', { class: 'rl num', text: pageLabel(r.part, r.num, this.book.parts?.length || 1) || num(r.pid) }), r.inFoot ? h('span', { class: 'tag', text: 'حاشية' }) : null),
          snippetEl(r.snippet),
        ),
      );
    }
    if (st.results.length < st.total) {
      ul.append(h('div', { class: 'loading-row' }, h('button', { class: 'btn sm', text: `المزيد (${num(st.total - st.results.length)})`, onclick: () => this.runSearch(false) })));
    }
    this.searchList.replaceChildren(ul);
  }

  // ---- bookmarks
  async renderMarks() {
    const body = h('div', { class: 'r-panel-body' }, spinnerRow());
    this.panelEl.append(
      this.panelHead('العلامات والملاحظات'),
      h('div', { class: 'panel-filter' }, h('button', { class: 'btn primary sm', style: { width: '100%' }, onclick: () => this.addBookmark() }, icon('plus'), 'علامة للصفحة الحالية')),
      body,
    );
    const marks = await this.app.db('userBookmarks', this.bookId);
    if (this.panel !== 'marks') return;
    if (!marks.length) {
      body.replaceChildren(emptyState('bookmark', 'لا علامات بعد', 'أضف علامة أو ملاحظة لأيّ صفحة لتعود إليها لاحقًا.'));
      return;
    }
    const list = h('div', { class: 'results' });
    for (const m of marks) {
      list.append(
        h(
          'div',
          { class: 'result compact', style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
          h(
            'button',
            { class: 'linkish', style: { flex: 1, textAlign: 'start', color: 'var(--text)' }, onclick: () => this.goto({ pid: m.pid }) },
            h('div', { style: { fontWeight: 600 }, text: m.label || `صفحة ${num(m.pid)}` }),
            m.note ? h('div', { class: 'muted', style: { fontSize: '13px', whiteSpace: 'pre-wrap', marginTop: '3px' }, text: m.note }) : null,
          ),
          h('button', { class: 'icon-btn', title: 'تعديل', onclick: () => this.editBookmark(m) }, icon('edit')),
          h('button', {
            class: 'icon-btn',
            title: 'حذف',
            onclick: async () => {
              await this.app.db('userDeleteBookmark', m.id);
              this.renderPanel();
              this.refreshPageMark();
            },
          }, icon('trash')),
        ),
      );
    }
    body.replaceChildren(list);
  }

  addBookmark() {
    if (!this.current) return;
    const page = this.current;
    const defLabel = (page.path[page.path.length - 1]?.text || this.meta.name) + ' — ' + (pageLabel(page.part, page.num, this.book.parts?.length || 1) || `صفحة ${num(page.index)}`);
    this.editBookmark({ book: this.bookId, pid: page.pid, label: defLabel, note: '' }, true);
  }

  editBookmark(m, isNew = false) {
    const label = h('input', { class: 'input', value: m.label || '', style: { width: '100%' } });
    const note = h('textarea', { class: 'input', rows: 6, style: { width: '100%' }, placeholder: 'ملاحظتك (اختياري)…' });
    note.value = m.note || '';
    const save = h('button', { class: 'btn primary', text: isNew ? 'حفظ العلامة' : 'حفظ التعديل' });
    const cancel = h('button', { class: 'btn', text: 'إلغاء' });
    const dlg = modal({
      title: isNew ? 'علامة جديدة' : 'تعديل العلامة',
      cls: 'small',
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, h('label', { class: 'muted', text: 'العنوان' }), label, h('label', { class: 'muted', text: 'الملاحظة' }), note),
      foot: [cancel, save],
    });
    cancel.addEventListener('click', () => dlg.close());
    save.addEventListener('click', async () => {
      if (isNew) await this.app.db('userAddBookmark', { book: m.book, pid: m.pid, label: label.value, note: note.value });
      else await this.app.db('userUpdateBookmark', m.id, { label: label.value, note: note.value, color: m.color });
      dlg.close();
      toast(isNew ? 'حُفظت العلامة' : 'حُفظ التعديل');
      this.refreshPageMark();
      if (this.panel === 'marks') this.renderPanel();
    });
    setTimeout(() => (isNew ? note : label).focus(), 30);
  }

  // -------------------------------------------------------------- dialogs & actions
  gotoDialog() {
    if (!this.book) return;
    const parts = this.book.parts || [];
    const multi = parts.length > 1;
    const partSel = h('select', { class: 'select' }, parts.map((p) => h('option', { value: p.part ?? '', text: `الجزء ${num(p.part)}` })));
    if (this.current?.part != null) partSel.value = this.current.part;
    const pageIn = h('input', { class: 'input num', type: 'number', min: '1', placeholder: 'رقم الصفحة', style: { width: '140px' } });
    const idxIn = h('input', { class: 'input num', type: 'number', min: '1', max: String(this.book.pages), placeholder: `1 – ${this.book.pages}`, style: { width: '140px' } });
    const go = h('button', { class: 'btn primary', text: 'انتقال' });
    const body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'muted', text: 'حسب ترقيم المطبوع:' }),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, multi ? partSel : null, pageIn),
      h('div', { class: 'muted', text: 'أو حسب تسلسل الصفحات في البرنامج:' }),
      idxIn,
    );
    const dlg = modal({ title: 'الانتقال إلى صفحة', cls: 'small', body, foot: [go] });
    const run = () => {
      if (idxIn.value) this.goto({ index: Number(idxIn.value) });
      else if (pageIn.value) this.goto({ num: Number(pageIn.value), part: multi ? partSel.value : undefined });
      dlg.close();
    };
    go.addEventListener('click', run);
    for (const i of [pageIn, idxIn]) i.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    setTimeout(() => pageIn.focus(), 30);
  }

  citation(page = this.current) {
    const b = this.book;
    const loc = pageLabel(page.part, page.num, b.parts?.length || 1);
    return `[${b.name}${b.author ? '، ' + b.author : ''}${loc ? '، ' + loc : ''}]`;
  }

  copyWithCitation() {
    const sel = String(getSelection() || '').trim();
    if (!sel || !this.current) return;
    // find the page the selection belongs to (continuous mode)
    const node = getSelection().anchorNode;
    const pageEl = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('.page');
    const rid = pageEl ? Number(pageEl.dataset.rid) : this.current.rid;
    const finish = (p) => {
      window.ibadi.copy(`${sel}\n\n${this.citation(p)}`);
      toast('نُسخ النص مع التوثيق');
    };
    if (rid === this.current.rid) finish(this.current);
    else this.app.db('page', this.bookId, { rid }).then((p) => finish(p || this.current));
  }

  copyPage() {
    if (!this.current) return;
    const p = this.current;
    const body = (p.body || '').replace(/<span id="aya-\d+">|<\/span>/g, '').replace(/¬/g, '');
    const foot = p.foot ? '\n\n' + p.foot.replace(/¬/g, '').replace(/^[_\s]+/, '______\n') : '';
    window.ibadi.copy(`${body}${foot}\n\n${this.citation(p)}`);
    toast('نُسخت الصفحة');
  }

  async openPdf() {
    if (!this.current) return;
    const url = await this.app.db('pdfLink', this.bookId, this.current.pid);
    if (!url) {
      toast('لا تتوفّر مصوَّرة لهذا الكتاب', 'error');
      return;
    }
    window.ibadi.openPdf(url, `${this.meta.name} — مصوَّرة`);
  }
}
