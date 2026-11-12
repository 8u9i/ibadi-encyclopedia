import { h, icon, num, toast, digits } from '../dom.js';
import { DEFAULTS } from '../app.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.el = h('section', null, h('div', { class: 'content' }, (this.wrap = h('div', { class: 'settings' }))));
    this.render();
  }

  async onShow(arg) {
    await this.render();
    if (arg?.section === 'sync') this.syncCard?.scrollIntoView({ block: 'start' });
    if (arg?.section === 'updates') this.updateCard?.scrollIntoView({ block: 'start' });
  }

  async render() {
    const s = this.app.settings;
    const set = (k, v) => {
      this.app.setSetting(k, v);
      this.syncPreview();
    };
    const row = (label, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'lbl' }, label, hint ? h('small', { text: hint }) : null), control);
    const seg = (key, options) => {
      const el = h('div', { class: 'seg' });
      for (const [v, label] of options) {
        const b = h('button', { 'aria-pressed': String(s[key] === v), text: label });
        b.addEventListener('click', () => {
          set(key, v);
          for (const x of el.children) x.setAttribute('aria-pressed', String(x === b));
        });
        el.append(b);
      }
      return el;
    };
    const range = (key, min, max, step, fmt) => {
      const out = h('span', { class: 'num', style: { minWidth: '52px', textAlign: 'center' }, text: fmt(s[key]) });
      const input = h('input', { type: 'range', min, max, step, value: String(s[key]), style: { width: '200px', accentColor: 'var(--accent)' } });
      input.addEventListener('input', () => {
        set(key, Number(input.value));
        out.textContent = fmt(Number(input.value));
      });
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, input, out);
    };
    const fontSel = h(
      'select',
      { class: 'select' },
      h('option', { value: 'Amiri', text: 'أميري (Amiri)' }),
      h('option', { value: 'Noto Naskh Arabic', text: 'نوتو نسخ (Noto Naskh)' }),
      h('option', { value: 'system', text: 'خطّ النظام' }),
    );
    fontSel.value = s.readFont;
    fontSel.addEventListener('change', () => set('readFont', fontSel.value));
    const digitsBox = h('input', { type: 'checkbox', checked: !!s.arabicDigits });
    digitsBox.addEventListener('change', () => {
      set('arabicDigits', digitsBox.checked);
      toast('يسري التغيير على ما يُعرض من الآن');
    });
    const gpu = h('input', { type: 'checkbox', checked: !!s.hardwareAcceleration });
    gpu.addEventListener('change', () => {
      this.app.setSetting('hardwareAcceleration', gpu.checked);
      toast('يسري بعد إعادة تشغيل البرنامج');
    });
    const modeSel = h('select', { class: 'select' }, h('option', { value: 'single', text: 'صفحةً صفحة' }), h('option', { value: 'continuous', text: 'تمرير متّصل' }));
    modeSel.value = s.readerMode;
    modeSel.addEventListener('change', () => set('readerMode', modeSel.value));

    this.preview = h(
      'div',
      { class: 'preview-text page', style: { padding: '8px 0', maxWidth: 'none' } },
      'قال الإمام جابر بن زيد: ',
      h('span', { class: 'quran' }, h('span', { class: 'orn', text: '﴿' }), 'إِنَّمَا يَخْشَى اللَّهَ مِنْ عِبَادِهِ الْعُلَمَاءُ', h('span', { class: 'orn', text: '﴾' })),
      ' والعلم نورٌ يُستضاء به في ظلمات الجهل',
      h('a', { class: 'fn-ref', text: '(1)' }),
      '.',
    );

    const status = await window.ibadi.library.status();
    const about = await window.ibadi.appInfo();
    const info = status?.info || {};
    const changeLib = h('button', { class: 'btn' }, icon('folder'), 'تغيير مجلّد المكتبة');
    changeLib.addEventListener('click', async () => {
      const r = await window.ibadi.library.choose();
      if (r?.ok) {
        toast('تمّ تغيير المكتبة — يُعاد التحميل…');
        setTimeout(() => location.reload(), 600);
      } else if (r && !r.canceled) toast(r.error || 'تعذّر فتح المكتبة', 'error');
    });
    const reset = h('button', { class: 'btn ghost' }, 'استعادة الإعدادات الافتراضية للعرض');
    reset.addEventListener('click', () => {
      for (const k of ['theme', 'readFont', 'readSize', 'readLeading', 'readWidth', 'arabicDigits']) this.app.setSetting(k, DEFAULTS[k]);
      this.render();
    });

    this.wrap.replaceChildren(
      h('div', { class: 'pane-head', style: { border: 0, background: 'none', padding: '0 4px' } }, h('h1', { text: 'الإعدادات' })),
      h(
        'div',
        { class: 'set-card' },
        h('h2', { text: 'المظهر والقراءة' }),
        row('المظهر', null, seg('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['sepia', 'ورقي'], ['dark', 'داكن']])),
        row('خطّ القراءة', null, fontSel),
        row('حجم الخط', 'أو Ctrl + = و Ctrl + - أثناء القراءة', range('readSize', 14, 44, 1, (v) => `${num(v)}`)),
        row('تباعد الأسطر', null, range('readLeading', 1.4, 2.8, 0.1, (v) => num(v.toFixed(1)))),
        row('عرض النص', 'أقصى عرض لعمود القراءة', range('readWidth', 560, 1400, 20, (v) => num(v))),
        row('الأرقام المشرقية', 'عرض الأرقام بالشكل ١٢٣ بدل 123', digitsBox),
        row('طريقة القراءة الافتراضية', null, modeSel),
        this.preview,
        h('div', { class: 'set-row' }, reset),
      ),
      h(
        'div',
        { class: 'set-card' },
        h('h2', { text: 'المكتبة' }),
        row('المجلّد', status?.path || 'لم يُحدَّد', changeLib),
        row('تسريع الرسوميات', 'مُعطّل افتراضيًا لتقليل استهلاك الذاكرة (~150 م.ب). يسري بعد إعادة التشغيل.', gpu),
        status?.ok
          ? row('المحتوى', `بُنيت في ${info.built_at ? new Date(info.built_at).toLocaleDateString('ar') : '—'} من الإصدار ${info.source_label || '—'}`, h('span', { class: 'muted num', text: `${num(Number(info.books))} كتابًا، ${num(Number(info.pages))} صفحة` }))
          : null,
      ),
      (this.updateCard = h('div', { class: 'set-card', id: 'updates' })),
      (this.syncCard = h('div', { class: 'set-card', id: 'sync' })),
      h(
        'div',
        { class: 'set-card' },
        h('h2', { text: 'حول البرنامج' }),
        row('الموسوعة الإباضية', `الإصدار ${about?.version || ''}، Electron ${about?.electron || ''}`, h('button', { class: 'btn', onclick: () => this.app.shortcutsHelp() }, 'اختصارات لوحة المفاتيح (F1)')),
        row('الموقع', 'ibadi.net', h('button', { class: 'btn ghost', onclick: () => window.ibadi.openExternal('https://ibadi.net') }, icon('external'), 'زيارة')),
      ),
    );
    this.renderSync();
    this.renderUpdates();
  }

  syncPreview() {}

  onUpdateEvent(ev) {
    if (!this.el.hidden) this.renderUpdates(ev);
  }

  /** New and corrected books published for every copy of the app. */
  async renderUpdates(ev) {
    const card = this.updateCard;
    if (!card) return;
    const st = await window.ibadi.update.status();
    if (!st) return;
    const row = (label, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'lbl' }, label, hint ? h('small', { text: hint }) : null), control);
    const when = (t) => new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));
    const busy = st.running || st.publisher?.running;

    const auto = h('input', { type: 'checkbox', checked: !!st.auto, 'aria-label': 'تنزيل التحديثات تلقائيًا' });
    auto.addEventListener('change', () => window.ibadi.update.setAuto(auto.checked));
    const now = h('button', { class: 'btn primary', disabled: !!busy }, icon('history'), st.running ? 'جارٍ التحديث…' : 'تحديث الآن');
    now.addEventListener('click', async () => {
      now.disabled = true;
      now.lastChild.textContent = 'جارٍ التحقّق…';
      const r = await window.ibadi.update.run();
      if (r && !r.error && !r.pending.count && !r.running) toast('مكتبتك محدَّثة');
      this.renderUpdates();
    });

    let state;
    if (st.running) {
      const msg = digits((ev && ev.message) || st.progress?.message || 'جارٍ التحديث');
      state = h('span', { class: 'muted', style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, h('span', { class: 'spinner' }), msg);
    } else if (st.error) state = h('span', { style: { color: 'var(--danger)' }, text: st.error });
    else if (st.pending.count) {
      const bits = [];
      if (st.pending.added) bits.push(`${num(st.pending.added)} كتاب جديد`);
      if (st.pending.updated) bits.push(`${num(st.pending.updated)} معدَّل`);
      if (st.pending.removed) bits.push(`${num(st.pending.removed)} محذوف`);
      state = h('span', { style: { color: 'var(--accent)' }, text: `يتوفّر تحديث: ${bits.join('، ') || 'تصحيحات'}` });
    } else if (st.last) {
      const bits = [`أُضيف ${num(st.last.added)}`, `حُدِّث ${num(st.last.updated)}`];
      if (st.last.removed) bits.push(`أُزيل ${num(st.last.removed)}`);
      state = h('span', { class: 'muted', text: `${when(st.last.at)}، ${bits.join('، ')}` });
    } else state = h('span', { class: 'muted', text: st.lastCheck ? 'مكتبتك محدَّثة' : 'لم يُتحقَّق بعد' });

    const version = st.installed == null ? '—' : `الإصدار ${num(st.installed)}${st.lastCheck ? `، آخر تحقّق ${when(st.lastCheck)}` : ''}`;
    const rows = [
      h('h2', { text: 'تحديثات المكتبة' }),
      h('p', { class: 'muted', style: { margin: '6px 0 4px', fontSize: '13px', lineHeight: 1.8 }, text: 'تصل الكتب الجديدة والمصحَّحة في حزم صغيرة تُنزَّل وتُطبَّق دون إعادة تنزيل المكتبة كلّها.' }),
      row('الحالة', version, state),
      row('تنزيل التحديثات تلقائيًا', 'يتحقّق عند التشغيل وكلّ ستّ ساعات', auto),
      h('div', { class: 'set-row' }, h('span', { style: { flex: 1 } }), now),
    ];

    if (st.publisher) {
      const p = st.publisher;
      const autoPub = h('input', { type: 'checkbox', checked: !!p.auto, 'aria-label': 'النشر التلقائي' });
      autoPub.addEventListener('change', () => window.ibadi.update.setAutoPublish(autoPub.checked));
      const pub = h('button', { class: 'btn', disabled: !!busy }, icon('external'), p.running ? 'جارٍ النشر…' : 'نشر الآن');
      pub.addEventListener('click', async () => {
        pub.disabled = true;
        await window.ibadi.update.publish();
        this.renderUpdates();
      });
      let pstate;
      if (p.running) pstate = h('span', { class: 'muted', style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, h('span', { class: 'spinner' }), digits((ev && ev.message) || p.progress?.message || 'جارٍ النشر'));
      else if (p.error) pstate = h('span', { style: { color: 'var(--danger)' }, text: p.error });
      else if (p.last) pstate = h('span', { class: 'muted', text: p.last.changed ? `${when(p.last.at)}، الإصدار ${num(p.last.version)}: ${num(p.last.added + p.last.updated)} كتاب` : `${when(p.last.at)}، لا جديد` });
      else pstate = h('span', { class: 'muted', text: '—' });
      rows.push(
        h('h3', { text: 'النشر (للمشرف)', style: { margin: '14px 0 2px', fontSize: '14px' } }),
        row('نشر التحديثات تلقائيًا', 'بعد كلّ نقلٍ من البرنامج الأصلي تُرفع الكتب المتغيّرة إلى GitHub ليتلقّاها الجميع.', autoPub),
        row('آخر نشر', null, pstate),
        h('div', { class: 'set-row' }, h('span', { style: { flex: 1 } }), pub),
      );
    }
    card.replaceChildren(...rows);
  }

  onSyncEvent(ev) {
    if (!this.el.hidden) this.renderSync(ev);
  }

  /** "Update from the original app": where it is, whether it runs automatically, and what happened last. */
  async renderSync(ev) {
    const card = this.syncCard;
    if (!card) return;
    const st = await window.ibadi.sync.status();
    if (!st) return;
    const row = (label, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'lbl' }, label, hint ? h('small', { text: hint }) : null), control);
    const choose = h('button', { class: 'btn' }, icon('folder'), st.root ? 'تغيير' : 'تحديد المجلّد');
    choose.addEventListener('click', async () => {
      const r = await window.ibadi.sync.choose();
      if (r?.ok) toast('رُبط البرنامج الأصلي');
      else if (r && !r.canceled) toast(r.error, 'error');
      this.renderSync();
    });
    const auto = h('input', { type: 'checkbox', checked: !!st.auto, 'aria-label': 'التحديث التلقائي' });
    auto.addEventListener('change', () => window.ibadi.sync.setAuto(auto.checked));
    const now = h('button', { class: 'btn primary', disabled: !st.root || st.running }, icon('history'), st.running ? 'جارٍ النقل…' : 'نقل الآن');
    now.addEventListener('click', async () => {
      await window.ibadi.sync.run();
      this.renderSync();
    });

    let state;
    if (st.running) {
      const msg = digits((ev && ev.message) || st.progress?.message || 'جارٍ التحديث');
      state = h('span', { class: 'muted', style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, h('span', { class: 'spinner' }), msg);
    } else if (st.error) state = h('span', { style: { color: 'var(--danger)' }, text: st.error });
    else if (st.last) {
      const when = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(st.last.at));
      const bits = [`أُضيف ${num(st.last.added)}`, `حُدِّث ${num(st.last.updated)}`];
      if (st.last.removed) bits.push(`أُزيل ${num(st.last.removed)}`);
      state = h('span', { class: 'muted', text: `${when}، ${bits.join('، ')}` });
    } else state = h('span', { class: 'faint', text: st.root ? 'لم يُجرَ تحديث بعد' : '—' });

    // Optional rows are null; native replaceChildren would print them as "null", so filter first.
    card.replaceChildren(...[
      h('h2', { text: 'التحديث من البرنامج الأصلي' }),
      h('p', { class: 'muted', style: { margin: '6px 0 4px', fontSize: '13px', lineHeight: 1.8 }, text: 'عندما يُنزّل البرنامج الأصلي كتبًا جديدة أو محدَّثة، تُنقل إلى هذه المكتبة تلقائيًا. افتح البرنامج الأصلي ودعه يحدّث نفسه، وسيلتقط هذا البرنامج التغييرات خلال دقيقتين.' }),
      row('مجلّد البرنامج الأصلي', st.root || 'لم يُعثر عليه بعد. يُكتشف تلقائيًا عند تشغيل البرنامج الأصلي، أو حدّد مجلّد تثبيته.', choose),
      st.root && st.java === false ? row('Java', 'لم يُعثر على مجلّد jre في البرنامج الأصلي؛ ثبّت Java 21 أو أحدث.', h('span')) : null,
      row('التحديث التلقائي', 'يتحقّق كل دقيقة دون إبطاء القراءة', auto),
      row('آخر تحديث', st.changed && !st.running ? 'في البرنامج الأصلي تغييرات لم تُنقل بعد' : null, state),
      h('div', { class: 'set-row' }, h('span', { style: { flex: 1 } }), now),
    ].filter(Boolean));
  }
}
