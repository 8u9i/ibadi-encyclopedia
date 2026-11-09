// Converts stored page text into DOM. The text is plain; the only structure recognised is:
//   (¬N) / (N)           footnote references (linked to the footnote block)
//   { … }                Qur'an quotations
//   <span id="aya-N">…</span>  verse anchors used by tafsir books
// Everything else is inserted as text, so nothing in the data can inject markup.
import { h, appendHighlighted } from './dom.js';
import { normalize } from '../shared/arabic.js';

const INLINE = /<span id="aya-(\d+)">([\s\S]*?)<\/span>|\(¬?(\d{1,3})\)|\{([^{}\n]{1,3000})\}/g;
const FOOT_LINE = /^\s*\(¬?(\d{1,3})\)\s*/;

function inline(parent, text, ctx) {
  INLINE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = INLINE.exec(text))) {
    const [all, aya, ayaText, fn, quran] = m;
    if (fn && !ctx.notes.has(fn) && !all.includes('¬')) continue; // plain "(3)" without a matching footnote
    if (m.index > last) appendHighlighted(parent, text.slice(last, m.index), ctx.re);
    if (aya) {
      parent.append(appendHighlighted(h('span', { class: 'aya-ref', id: `${ctx.prefix}aya-${aya}`, dataset: { aya } }), ayaText, ctx.re));
    } else if (fn) {
      parent.append(h('a', { class: 'fn-ref', dataset: { fn, scope: ctx.prefix }, role: 'button', tabindex: '0', text: `(${fn})` }));
    } else if (quran != null) {
      const q = h('span', { class: 'quran' }, h('span', { class: 'orn', text: '﴿' }));
      appendHighlighted(q, quran.trim(), ctx.re);
      q.append(h('span', { class: 'orn', text: '﴾' }));
      parent.append(q);
    }
    last = m.index + all.length;
  }
  if (last < text.length) appendHighlighted(parent, text.slice(last), ctx.re);
}

function parseFoot(foot) {
  if (!foot) return [];
  const lines = foot.split('\n');
  while (lines.length && /^[\s_\-–—*]*$/.test(lines[0])) lines.shift();
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s*_{4,}\s*$/.test(line)) {
      items.push({ sep: true });
      continue;
    }
    const m = FOOT_LINE.exec(line);
    if (m) items.push({ n: m[1], text: line.slice(m[0].length) });
    else if (items.length && !items[items.length - 1].sep) items[items.length - 1].text += '\n' + line;
    else items.push({ n: null, text: line });
  }
  return items;
}

/**
 * Renders one page into a fresh element.
 * opts: { re (highlight regex), titles ([{text}]), prefix (unique id prefix), footer (node) }
 */
export function renderPage(page, opts = {}) {
  const prefix = opts.prefix || 'p' + page.rid + '-';
  const notes = parseFoot(page.foot);
  const ctx = { re: opts.re || null, prefix, notes: new Set(notes.filter((n) => n.n).map((n) => n.n)) };
  const titleSet = new Set((page.titles || []).map((t) => normalize(t.text).replace(/\s+/g, ' ').trim()));
  const el = h('article', { class: 'page', dataset: { rid: page.rid, pid: page.pid } });

  // drop stray footnote markers (a ¬ that is not part of a "(¬N)" reference)
  const body = (page.body || '').replace(/\r/g, '').replace(/¬(?!\d)/g, '');
  let any = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    any = true;
    const key = normalize(line).replace(/\s+/g, ' ').trim();
    const isTitle = titleSet.size && line.length < 200 && titleSet.has(key);
    const node = h(isTitle ? 'h3' : 'p');
    inline(node, line, ctx);
    el.append(node);
  }
  if (!any && !notes.length) el.append(h('p', { class: 'faint', text: '(صفحة فارغة)' }));

  if (notes.length) {
    const foot = h('div', { class: 'foot' });
    for (const n of notes) {
      if (n.sep) {
        foot.append(h('hr', { style: { border: 0, borderTop: '1px dashed var(--line)', margin: '.4em 0' } }));
        continue;
      }
      const row = h('div', { class: 'fn', id: n.n ? `${prefix}fn-${n.n}` : null });
      if (n.n) row.append(h('span', { class: 'fn-num', dataset: { back: n.n, scope: prefix }, text: `(${n.n}) ` }));
      const parts = n.text.split('\n');
      parts.forEach((p, i) => {
        if (i) row.append(h('br'));
        inline(row, p, { ...ctx, notes: new Set() });
      });
      foot.append(row);
    }
    el.append(foot);
  }
  if (opts.footer) el.append(opts.footer);
  return el;
}

/** Handles clicks on footnote references and back-links inside a reading container. */
export function wireFootnotes(container) {
  const flash = (el) => {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  const go = (target) => {
    const ref = target.closest('.fn-ref');
    if (ref) {
      const note = container.querySelector(`#${CSS.escape(ref.dataset.scope + 'fn-' + ref.dataset.fn)}`);
      if (note) {
        note.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(note);
      }
      return true;
    }
    const back = target.closest('.fn-num');
    if (back) {
      const refs = container.querySelectorAll(`.fn-ref[data-fn="${CSS.escape(back.dataset.back)}"][data-scope="${CSS.escape(back.dataset.scope)}"]`);
      if (refs[0]) {
        refs[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(refs[0]);
      }
      return true;
    }
    return false;
  };
  container.addEventListener('click', (e) => go(e.target));
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && go(e.target)) e.preventDefault();
  });
}
