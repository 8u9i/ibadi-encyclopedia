import { h, icon, num, toast } from '../dom.js';
import { DEFAULTS } from '../app.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.el = h('section', null, h('div', { class: 'content' }, (this.wrap = h('div', { class: 'settings' }))));
    this.render();
  }

  onShow() {
    this.render();
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
    const digits = h('input', { type: 'checkbox', checked: !!s.arabicDigits });
    digits.addEventListener('change', () => {
      set('arabicDigits', digits.checked);
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
        row('الأرقام المشرقية', 'عرض الأرقام بالشكل ١٢٣ بدل 123', digits),
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
          ? row('المحتوى', `بُنيت في ${info.built_at ? new Date(info.built_at).toLocaleDateString('ar') : '—'} من الإصدار ${info.source_label || '—'}`, h('span', { class: 'muted num', text: `${num(Number(info.books))} كتابًا · ${num(Number(info.pages))} صفحة` }))
          : null,
      ),
      h(
        'div',
        { class: 'set-card' },
        h('h2', { text: 'حول البرنامج' }),
        row('الموسوعة الإباضية', `الإصدار ${about?.version || ''} · Electron ${about?.electron || ''}`, h('button', { class: 'btn', onclick: () => this.app.shortcutsHelp() }, 'اختصارات لوحة المفاتيح (F1)')),
        row('الموقع', 'ibadi.net', h('button', { class: 'btn ghost', onclick: () => window.ibadi.openExternal('https://ibadi.net') }, icon('external'), 'زيارة')),
      ),
    );
  }

  syncPreview() {}
}
