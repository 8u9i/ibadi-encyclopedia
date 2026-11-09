import { h, icon, clear, num, spinnerRow, emptyState, coverEl, toast, modal } from '../dom.js';

const TABS = [
  ['marks', 'العلامات والملاحظات', 'bookmark'],
  ['favorites', 'المفضّلة', 'star'],
  ['history', 'سجلّ القراءة', 'history'],
  ['searches', 'سجلّ البحث', 'search'],
];

const fmtDate = (t) => new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));

export class SavedView {
  constructor(app) {
    this.app = app;
    this.tab = 'marks';
    this.seg = h('div', { class: 'seg' });
    for (const [id, label] of TABS) {
      const b = h('button', { 'aria-pressed': String(id === this.tab) }, label);
      b.addEventListener('click', () => {
        this.tab = id;
        for (const x of this.seg.children) x.setAttribute('aria-pressed', String(x === b));
        this.render();
      });
      this.seg.append(b);
    }
    this.actions = h('div', { style: { display: 'flex', gap: '8px' } });
    this.body = h('div', { class: 'content' });
    this.el = h('section', null, h('div', { class: 'pane-head' }, h('h1', { text: 'المحفوظات' }), this.seg, h('span', { style: { flex: 1 } }), this.actions), this.body);
  }

  onShow() {
    this.render();
  }

  async render() {
    clear(this.actions);
    clear(this.body).append(spinnerRow());
    const wrap = h('div', { style: { maxWidth: '980px', margin: '0 auto', padding: '10px 20px 60px' } });
    if (this.tab === 'marks') {
      const marks = await this.app.db('userBookmarks');
      if (!marks.length) return this.empty('bookmark', 'لا علامات بعد', 'استخدم زر العلامة في شريط القراءة أو Ctrl+D لحفظ موضع أو تدوين ملاحظة.');
      this.actions.append(h('button', { class: 'btn sm', onclick: () => this.exportMarks(marks) }, icon('copy'), 'نسخ الكلّ نصًّا'));
      const list = h('div', { class: 'results' });
      for (const m of marks) {
        list.append(
          h(
            'div',
            { class: 'result', style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
            h(
              'button',
              { class: 'linkish', style: { flex: 1, textAlign: 'start', color: 'var(--text)' }, onclick: () => this.app.openBook(m.book, { pid: m.pid }) },
              h('div', { class: 'rh' }, h('span', { class: 'rb', text: m.bookName }), h('span', { class: 'rl', text: fmtDate(m.updated) })),
              h('div', { style: { fontWeight: 600 }, text: m.label || '' }),
              m.note ? h('div', { class: 'prose', style: { fontSize: '16px', marginTop: '4px' }, text: m.note }) : null,
            ),
            h('button', {
              class: 'icon-btn',
              title: 'حذف',
              onclick: async () => {
                await this.app.db('userDeleteBookmark', m.id);
                toast('حُذفت العلامة');
                this.render();
              },
            }, icon('trash')),
          ),
        );
      }
      wrap.append(list);
    } else if (this.tab === 'favorites') {
      const ids = await this.app.db('userFavorites');
      this.app.favorites = new Set(ids);
      if (!ids.length) return this.empty('star', 'لا كتب في المفضّلة', 'انقر النجمة على غلاف أيّ كتاب لإضافته.');
      const grid = h('div', { class: 'grid', style: { padding: '10px 0' } });
      for (const id of ids) {
        const b = this.app.bookMap.get(id);
        if (!b) continue;
        grid.append(
          h('div', { class: 'card', role: 'button', tabindex: '0', title: b.name, onclick: () => this.app.openBook(id) }, coverEl(b), h('div', { class: 't', text: b.name }), h('div', { class: 's', text: b.author || '' })),
        );
      }
      wrap.append(grid);
    } else if (this.tab === 'history') {
      const hist = await this.app.db('userHistory', 300);
      if (!hist.length) return this.empty('history', 'السجلّ فارغ');
      this.actions.append(h('button', { class: 'btn sm danger', onclick: () => this.confirmClear('userClearHistory', 'سجلّ القراءة') }, icon('trash'), 'مسح السجلّ'));
      const list = h('div', { class: 'results' });
      for (const r of hist) {
        const b = this.app.bookMap.get(r.book);
        list.append(
          h(
            'button',
            { class: 'result', style: { display: 'flex', gap: '12px', alignItems: 'center' }, onclick: () => this.app.openBook(r.book) },
            b ? coverEl(b, { small: true }) : null,
            h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'rb ellipsis', text: r.bookName }), h('div', { class: 'faint', style: { fontSize: '12px' }, text: `آخر قراءة: ${fmtDate(r.opened)}` })),
          ),
        );
      }
      for (const cv of list.querySelectorAll('.cv')) Object.assign(cv.style, { width: '38px', height: '52px', borderRadius: '5px', overflow: 'hidden', flex: 'none' });
      wrap.append(list);
    } else {
      const qs = await this.app.db('userSearchHistory');
      if (!qs.length) return this.empty('search', 'لا عمليات بحث محفوظة');
      this.actions.append(h('button', { class: 'btn sm danger', onclick: () => this.confirmClear('userClearSearchHistory', 'سجلّ البحث') }, icon('trash'), 'مسح السجلّ'));
      const list = h('div', { class: 'results' });
      for (const q of qs) list.append(h('button', { class: 'result', onclick: () => this.app.go('search', { q }) }, h('div', { class: 'rs', text: q })));
      wrap.append(list);
    }
    clear(this.body).append(wrap);
  }

  empty(iconName, title, text) {
    clear(this.body).append(emptyState(iconName, title, text));
  }

  confirmClear(method, what) {
    const yes = h('button', { class: 'btn primary', text: 'مسح' });
    const no = h('button', { class: 'btn', text: 'إلغاء' });
    const dlg = modal({ title: `مسح ${what}`, cls: 'small', body: h('p', { text: `سيُحذف ${what} نهائيًّا. هل تريد المتابعة؟` }), foot: [no, yes] });
    no.addEventListener('click', () => dlg.close());
    yes.addEventListener('click', async () => {
      await this.app.db(method);
      dlg.close();
      this.render();
    });
  }

  exportMarks(marks) {
    const text = marks
      .map((m) => `• ${m.bookName} — ${m.label || ''}${m.note ? '\n  ' + m.note.replace(/\n/g, '\n  ') : ''}`)
      .join('\n\n');
    window.ibadi.copy(text);
    toast(`نُسخت ${num(marks.length)} علامة`);
  }
}
