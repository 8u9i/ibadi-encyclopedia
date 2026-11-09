import { h, icon, modal, coverEl, num, deathLabel, spinnerRow, toast } from '../dom.js';


export async function showBookInfo(app, id) {
  const meta = app.bookMap.get(id);
  const holder = h('div', null, spinnerRow());
  const read = h('button', { class: 'btn primary' }, icon('quran'), 'قراءة الكتاب');
  const fav = h('button', { class: 'btn' }, icon('star'), app.isFavorite(id) ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة');
  const pdf = h('button', { class: 'btn', hidden: true }, icon('pdf'), 'المصوَّرة (PDF)');
  const dlg = modal({ title: 'بطاقة الكتاب', body: holder, foot: [pdf, fav, read] });
  read.addEventListener('click', () => {
    dlg.close();
    app.openBook(id);
  });
  fav.addEventListener('click', async () => {
    const on = await app.toggleFavorite(id);
    fav.lastChild.textContent = on ? 'إزالة من المفضّلة' : 'إضافة إلى المفضّلة';
  });

  let b;
  try {
    b = await app.db('book', id);
  } catch (e) {
    holder.replaceChildren(h('div', { class: 'muted', text: e.message }));
    return;
  }
  if (!b) return;
  pdf.hidden = !b.hasPdf;
  pdf.addEventListener('click', async () => {
    const url = await app.db('pdfLink', id, b.parts?.[0]?.pid ?? 1);
    if (url) window.ibadi.openPdf(url, `${b.name} — مصوَّرة`);
    else toast('لا تتوفّر مصوَّرة', 'error');
  });

  const authorLink = (a) =>
    h('button', {
      class: 'linkish',
      text: a.name,
      onclick: () => {
        dlg.close();
        app.go('authors', { author: a.aid ?? a.id });
      },
    });

  const dl = h('dl', { class: 'meta-grid' });
  const row = (k, v) => v && dl.append(h('dt', { text: k }), h('dd', null, v));
  if (b.authors.length) {
    const span = h('span');
    b.authors.forEach((a, i) => {
      if (i) span.append('، ');
      span.append(authorLink(a), h('span', { class: 'faint', text: ` (${deathLabel(a.death, a.deathText)})` }));
    });
    row(b.authors.length > 1 ? 'المؤلفون' : 'المؤلف', span);
  }
  const contrib = b.contributors.filter((c) => !b.authors.some((a) => a.id === c.aid) && c.role);
  if (contrib.length) {
    const span = h('span');
    contrib.forEach((c, i) => {
      if (i) span.append('، ');
      span.append(c.aid ? authorLink(c) : c.name, h('span', { class: 'faint', text: ` (${c.role})` }));
    });
    row('مشاركون', span);
  }
  row('التصنيف', b.catName);
  row('الحجم', `${num(b.pages)} صفحة${b.parts?.length > 1 ? ` في ${num(b.parts.length)} أجزاء` : ''}`);
  if (b.series.length) row('السلسلة', b.series.map((s) => s.series + (s.number ? ` (${s.number})` : '')).join('، '));
  if (b.country) row('البلد', b.country);

  const sections = [];
  if (b.card) sections.push(h('div', { class: 'info-section' }, h('h3', { text: 'بطاقة الكتاب' }), h('div', { class: 'prose', style: { fontSize: '16px' }, text: b.card })));
  if (b.desc.length) sections.push(h('div', { class: 'info-section' }, h('h3', { text: 'نبذة' }), ...b.desc.map((d) => h('div', { class: 'prose', style: { fontSize: '16.5px', marginBottom: '10px' }, text: d }))));

  holder.replaceChildren(
    h('div', { class: 'info-head' }, coverEl({ ...meta, ...b, cover: meta.cover }, { full: true }), h('div', { style: { flex: 1, minWidth: 0 } }, h('h2', { text: b.name }), dl)),
    ...sections,
  );
}
