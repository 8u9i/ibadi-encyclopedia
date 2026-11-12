import { h, icon, clear, num, debounce, spinnerRow, emptyState, appendHighlighted, toast } from '../dom.js';
import { SURA_NAMES, SURA_AYAT } from '../../shared/quran.js';
import { normalize, highlightRegex, toArabicDigits } from '../../shared/arabic.js';

const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

export class QuranView {
  constructor(app) {
    this.app = app;
    this.sura = app.settings.lastSura || 1;
    this.selected = null;
    this.build();
  }

  build() {
    this.filter = h('input', { class: 'input', type: 'search', placeholder: 'اسم السورة أو رقمها، أو كلمات من آية…' });
    this.filter.addEventListener('input', debounce(() => this.onFilter(), 200));
    this.filter.addEventListener('keydown', (e) => e.key === 'Enter' && this.onFilter(true));
    this.list = h('div');
    this.side = h('nav', { class: 'side', style: { width: '250px', display: 'flex', flexDirection: 'column', padding: 0 } },
      h('div', { class: 'panel-filter' }, h('div', { class: 'search-field' }, icon('search'), this.filter)),
      h('div', { style: { overflow: 'auto', flex: 1, padding: '6px' } }, this.list),
    );
    this.pane = h('div', { class: 'q-pane' });
    this.tafsir = h('div', { class: 'tafsir-box', hidden: true });
    this.content = h('div', { class: 'content', style: { display: 'flex', flexDirection: 'column' } }, h('div', { style: { flex: 1, overflow: 'auto' } }, this.pane), this.tafsir);
    this.scroller = this.content.firstChild;
    this.el = h('section', null, h('div', { class: 'split' }, this.side, this.content));
    this.renderList();
  }

  onShow() {
    if (!this.loaded) {
      this.loaded = true;
      this.showSura(this.sura);
    }
  }

  renderList(match) {
    clear(this.list);
    SURA_NAMES.forEach((name, i) => {
      const n = i + 1;
      if (match && !match(n, name)) return;
      this.list.append(
        h(
          'button',
          { class: 'list-btn', dataset: { sura: n }, 'aria-current': String(n === this.sura), onclick: () => this.showSura(n) },
          h('span', { class: 'n', style: { minWidth: '26px' }, text: num(n) }),
          h('span', { class: 't', text: name }),
          h('span', { class: 'n', text: `${num(SURA_AYAT[i])} آية` }),
        ),
      );
    });
  }

  async onFilter(force) {
    const raw = this.filter.value.trim();
    const v = normalize(raw);
    if (!v) {
      this.renderList();
      if (this.searching) {
        this.searching = false;
        this.showSura(this.sura);
      }
      return;
    }
    const asNum = Number(v);
    const names = SURA_NAMES.map((n) => normalize(n));
    const nameHits = (n, name) => (asNum ? n === asNum : names[n - 1].includes(v) || normalize(name).replace(/^ال/, '').startsWith(v));
    this.renderList(nameHits);
    if (asNum && asNum >= 1 && asNum <= 114) return;
    const anyName = SURA_NAMES.some((name, i) => nameHits(i + 1, name));
    if (anyName && !force) return;
    if (v.length < 2) return;
    this.searchAyat(raw);
  }

  async showSura(n) {
    this.sura = n;
    this.searching = false;
    this.app.setSetting('lastSura', n);
    for (const b of this.list.querySelectorAll('.list-btn')) b.setAttribute('aria-current', String(Number(b.dataset.sura) === n));
    this.list.querySelector(`[data-sura="${n}"]`)?.scrollIntoView({ block: 'nearest' });
    clear(this.pane).append(spinnerRow());
    const ayat = await this.app.db('ayat', n);
    if (this.sura !== n) return;
    const text = h('div', { class: 'q-text' });
    for (const a of ayat) {
      const span = h('span', { class: 'aya', dataset: { id: a.id }, title: 'انقر لعرض التفسير' }, a.uthmani, ' ', h('span', { class: 'aya-no', text: `﴿${toArabicDigits(a.num)}﴾` }), ' ');
      span.addEventListener('click', () => this.selectAya(a, span));
      text.append(span);
    }
    const nav = h(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', marginTop: '28px' } },
      n > 1 ? h('button', { class: 'btn', onclick: () => this.showSura(n - 1) }, icon('chevronRight'), `سورة ${SURA_NAMES[n - 2]}`) : h('span'),
      n < 114 ? h('button', { class: 'btn', onclick: () => this.showSura(n + 1) }, `سورة ${SURA_NAMES[n]}`, icon('chevronLeft')) : h('span'),
    );
    // Native append() would print a null child as the text "null", so optional parts are filtered.
    clear(this.pane).append(
      ...[
        h('div', { class: 'q-head' }, h('h2', { text: `سورة ${SURA_NAMES[n - 1]}` }), h('div', { class: 'sub', text: `${num(ayat.length)} آية` })),
        n !== 1 && n !== 9 ? h('div', { class: 'basmala', text: BASMALA }) : null,
        text,
        nav,
      ].filter(Boolean),
    );
    this.scroller.scrollTop = 0;
    this.tafsir.hidden = true;
  }

  async selectAya(a, span) {
    for (const s of this.pane.querySelectorAll('.aya.sel')) s.classList.remove('sel');
    span?.classList.add('sel');
    this.selected = a;
    const list = await this.app.db('tafsir', a.id);
    const sura = a.sura || this.sura;
    clear(this.tafsir).append(
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 18px', flexWrap: 'wrap' } },
        h('strong', { text: `${SURA_NAMES[sura - 1]}، الآية ${num(a.num)}` }),
        h('span', { class: 'faint', text: list.length ? 'التفسير في:' : 'لا تفسير مرتبط بهذه الآية في المكتبة' }),
        ...list.map((t) => h('button', { class: 'btn sm', onclick: () => this.app.openBook(t.book, { pid: t.pid, aya: a.id }) }, icon('quran'), t.name)),
        h('span', { style: { flex: 1 } }),
        h('button', {
          class: 'btn sm ghost',
          onclick: () => {
            window.ibadi.copy(`﴿${a.uthmani}﴾ [${SURA_NAMES[sura - 1]}: ${a.num}]`);
            toast('نُسخت الآية');
          },
        }, icon('copy'), 'نسخ الآية'),
        h('button', { class: 'icon-btn', title: 'إغلاق', onclick: () => (this.tafsir.hidden = true) }, icon('close')),
      ),
    );
    this.tafsir.hidden = false;
  }

  async searchAyat(text) {
    this.searching = true;
    clear(this.pane).append(spinnerRow());
    const r = await this.app.db('searchAyat', text);
    if (!this.searching) return;
    const re = highlightRegex(r.words, true);
    if (!r.results.length) {
      clear(this.pane).append(emptyState('search', 'لا آيات مطابقة'));
      return;
    }
    const list = h('div', { class: 'results' });
    for (const a of r.results) {
      const item = h(
        'button',
        { class: 'result' },
        h('div', { class: 'rh' }, h('span', { class: 'rb', text: `سورة ${SURA_NAMES[a.sura - 1]}` }), h('span', { class: 'rl', text: `الآية ${num(a.num)}` })),
        appendHighlighted(h('div', { class: 'rs', style: { fontSize: '19px' } }), a.text, re),
      );
      item.addEventListener('click', () => this.selectAya(a, null));
      item.addEventListener('dblclick', async () => {
        await this.showSura(a.sura);
        const span = this.pane.querySelector(`.aya[data-id="${a.id}"]`);
        span?.scrollIntoView({ block: 'center' });
        this.selectAya(a, span);
      });
      list.append(item);
    }
    clear(this.pane).append(
      h('div', { class: 'q-head' }, h('h2', { style: { fontSize: '22px' }, text: 'نتائج البحث في الآيات' }), h('div', { class: 'sub', text: `${num(r.results.length)} آية — انقر لعرض التفسير، وانقر مرّتين للانتقال إلى موضعها` })),
      list,
    );
    this.scroller.scrollTop = 0;
  }
}
