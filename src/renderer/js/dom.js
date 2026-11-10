// Tiny DOM toolkit. All text goes through textContent — data is never parsed as HTML.
import { toArabicDigits } from '../shared/arabic.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// ------------------------------------------------------------------ icons (24×24 stroke paths)
const ICONS = {
  library: 'M4 19V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v14M9 19V8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v11M14.5 8.5l2.9-.8a1 1 0 0 1 1.2.7l2.6 9.7a1 1 0 0 1-.7 1.2l-2.9.8a1 1 0 0 1-1.2-.7L13.8 9.7a1 1 0 0 1 .7-1.2ZM3 20h18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5',
  quran: 'M12 6.5C10.2 5 7.6 4.5 4 4.8v13.4c3.6-.3 6.2.2 8 1.7 1.8-1.5 4.4-2 8-1.7V4.8c-3.6-.3-6.2.2-8 1.7ZM12 6.5v13.4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.5 3.5 5.2',
  bookmark: 'M6 4h12a1 1 0 0 1 1 1v15.5l-7-4.5-7 4.5V5a1 1 0 0 1 1-1Z',
  bookmarkFill: 'M6 4h12a1 1 0 0 1 1 1v15.5l-7-4.5-7 4.5V5a1 1 0 0 1 1-1Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.5 7.5 0 0 1-2 1.2L14.8 21h-4l-.4-2.4a7.5 7.5 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.6 7.6 0 0 1 0-2.4L4.5 9.9l2-3.4 1.9.7a7.5 7.5 0 0 1 2-1.2L10.8 3h4l.4 2.4a7.5 7.5 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 2.4Z',
  close: 'M6 6l12 12M18 6 6 18',
  chevronLeft: 'M15 5l-7 7 7 7',
  chevronRight: 'M9 5l7 7-7 7',
  chevronsLeft: 'M18 5l-7 7 7 7M12 5l-7 7 7 7',
  chevronsRight: 'M6 5l7 7-7 7M12 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  toc: 'M4 6h2M9 6h11M4 12h2M9 12h11M4 18h2M9 18h11',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.5v.5',
  pdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h4',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  textSize: 'M4 18 9 6l5 12M5.6 14h6.8M15 18l3-7 3 7M15.8 16h4.4',
  scroll: 'M7 4h10M7 20h10M12 8v8M9 13l3 3 3-3',
  page: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM9 8h6M9 12h6M9 16h4',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4M12 8v4l3 2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  filter: 'M4 5h16l-6 7v6l-4 2v-8L4 5Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  goto: 'M5 12h14M13 6l6 6-6 6',
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5',
};

export function icon(name, cls) {
  const span = document.createElement('span');
  span.className = 'ico' + (cls ? ' ' + cls : '');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  if (name === 'bookmarkFill' || name === 'starFill') path.setAttribute('fill', 'currentColor');
  svg.append(path);
  span.append(svg);
  return span;
}

export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
}

export function logo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('class', 'logo');
  svg.setAttribute('aria-hidden', 'true');
  const parts = [
    ['path', { d: 'M24 4 29 10.5 37 9.5 36 17.5 42.5 22.5 36 27.5 37 35.5 29 34.5 24 41 19 34.5 11 35.5 12 27.5 5.5 22.5 12 17.5 11 9.5 19 10.5Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M24 15.5c-2.3-1.7-5.2-2.2-8.5-2v14.5c3.3-.2 6.2.3 8.5 2 2.3-1.7 5.2-2.2 8.5-2V13.5c-3.3-.2-6.2.3-8.5 2Zm0 0V30', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' }],
  ];
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

// ------------------------------------------------------------------ formatting
let arabicDigits = true;
export function setDigitStyle(arabic) {
  arabicDigits = !!arabic;
}
export function num(n) {
  if (n == null || n === '') return '';
  const s = typeof n === 'number' ? n.toLocaleString('en-US').replace(/,/g, '٬') : String(n);
  return arabicDigits ? toArabicDigits(s) : s.replace(/٬/g, ',');
}

/** True when a death text is a date (e.g. "93", "ق 2", "بعد 1200") rather than a label such as "مؤسسة". */
export function isDeathDate(text) {
  return !text || /\d/.test(text);
}

/** Applies the digit style to numbers inside a message composed elsewhere (main process). */
export function digits(text) {
  return String(text || '').replace(/\d+/g, (d) => num(d));
}

export function deathLabel(death, text) {
  if (text) {
    if (!isDeathDate(text)) return text; // معاصر، مؤسسة، دورية، جماعي …
    return `ت ${num(text)}${/^\d+$/.test(text) ? 'هـ' : ''}`;
  }
  if (death == null || death >= 99999) return 'معاصر';
  return `ت ${num(death)}هـ`;
}

/** Sort key by death year; contemporaries and non-person entities go last. */
export function deathSortKey(death, text) {
  if (!isDeathDate(text)) return 100000;
  return death ?? 99999;
}

export function pageLabel(part, num_, parts) {
  const p = num_ != null ? `ص ${num(num_)}` : '';
  if (parts > 1 && part) return `ج ${num(part)}${p ? ' · ' + p : ''}`;
  return p;
}

// ------------------------------------------------------------------ covers
// Bookcloth colours for books without a scanned cover: muted, ink-heavy bindings.
const PALETTE = [
  ['#7d2e24', '#5c1f18'], ['#2b3a52', '#1c2638'], ['#4a5230', '#323820'], ['#6a4423', '#4a2e16'],
  ['#5a2a35', '#3e1c24'], ['#2f4a48', '#1f3331'], ['#3b3530', '#27231f'], ['#6e5a2a', '#4d3e1c'],
];

export function placeholderCover(name, author, small = false) {
  let hash = 0;
  for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const [a, b] = PALETTE[Math.abs(hash) % PALETTE.length];
  return h(
    'div',
    { class: 'ph' + (small ? ' small' : ''), style: { background: `linear-gradient(160deg, ${a}, ${b})` } },
    h('div', { class: 'pt', text: name || '' }),
    author && !small ? h('div', { class: 'pa', text: author }) : null,
  );
}

export function coverEl(book, { small = false, full = false } = {}) {
  const box = h('div', { class: 'cv' });
  if (book.cover) {
    const img = h('img', {
      src: `app://cover/${book.id}${full ? '?size=full' : ''}`,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      draggable: 'false',
    });
    img.addEventListener('error', () => img.replaceWith(placeholderCover(book.name, book.author, small)), { once: true });
    box.append(img);
  } else box.append(placeholderCover(book.name, book.author, small));
  return box;
}

// ------------------------------------------------------------------ feedback
export function toast(message, kind = '') {
  const el = h('div', { class: 'toast ' + kind, text: message });
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2600);
}

export function spinnerRow() {
  return h('div', { class: 'loading-row' }, h('div', { class: 'spinner' }));
}

export function emptyState(iconName, title, text) {
  return h('div', { class: 'empty' }, icon(iconName), h('h3', { text: title }), text ? h('div', { text }) : null);
}

/** Opens a modal dialog. Returns { dialog, close, done } where done resolves with the close value. */
export function modal({ title, body, foot, cls = '', onClose } = {}) {
  const closeBtn = h('button', { class: 'icon-btn', title: 'إغلاق', 'aria-label': 'إغلاق' }, icon('close'));
  const dlg = h(
    'dialog',
    { class: 'modal ' + cls },
    title != null ? h('div', { class: 'modal-head' }, h('h2', { text: title }), closeBtn) : null,
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null,
  );
  let resolve;
  const done = new Promise((r) => (resolve = r));
  let value;
  const close = (v) => {
    value = v;
    if (dlg.open) dlg.close();
  };
  closeBtn.addEventListener('click', () => close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.(value);
    resolve(value);
  });
  document.body.append(dlg);
  dlg.showModal();
  return { dialog: dlg, close, done };
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Renders text with highlighted regex matches into a parent node. */
export function appendHighlighted(parent, text, re) {
  if (!re || !text) {
    parent.append(text || '');
    return parent;
  }
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) parent.append(text.slice(last, m.index));
    parent.append(h('mark', { text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
  return parent;
}

/** Renders snippet parts [[text, isMatch], …]. */
export function snippetEl(sn, cls = 'rs') {
  const el = h('div', { class: cls });
  if (!sn) return el;
  if (sn.before) el.append('… ');
  for (const [t, m] of sn.parts) el.append(m ? h('mark', { text: t }) : t);
  if (sn.after) el.append(' …');
  return el;
}
