// Arabic text utilities shared by the library builder, the database worker and the renderer.
// The same normalisation is applied when indexing and when querying, so search results are
// insensitive to diacritics, tatweel, alef/hamza forms, ta marbuta, alef maqsura and digit styles.

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;

export function normalize(text) {
  if (!text) return '';
  return text
    .replace(DIACRITICS, '')
    .replace(/[آأإٱٲٳ]/g, 'ا') // آ أ إ ٱ → ا
    .replace(/ة/g, 'ه') // ة → ه
    .replace(/[ىی]/g, 'ي') // ى ی → ي
    .replace(/ک/g, 'ك') // ک → ك
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/¬/g, '');
}

/** Splits a (normalised) query into search words: Arabic/Latin letters and digits, optional trailing *. */
export function tokenize(text) {
  return normalize(text).match(/[\p{L}\p{N}]+\*?/gu) || [];
}

const LETTER_CLASS = {
  'ا': '[اآأإٱٲٳ]',
  'ه': '[هة]',
  'ي': '[يىی]',
  'ك': '[كک]',
};
const MARKS = '[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ¬]*';

function escapeRe(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source matching one normalised word inside original (un-normalised) text. */
export function wordPattern(word) {
  const prefix = word.endsWith('*');
  const w = prefix ? word.slice(0, -1) : word;
  let src = '';
  for (const ch of w) {
    if (/[0-9]/.test(ch)) {
      const d = Number(ch);
      src += `[${ch}${String.fromCharCode(0x0660 + d)}${String.fromCharCode(0x06f0 + d)}]`;
    } else {
      src += (LETTER_CLASS[ch] || escapeRe(ch)) + MARKS;
    }
  }
  return prefix ? src + '[\\p{L}\\p{M}]*' : src;
}

const CONJ = ['', 'و', 'ف'];
const DEF = ['ال', 'بال', 'كال', 'لل'];
const PREP = ['', 'ب', 'ك', 'ل'];

/**
 * Flexible matching: the forms of a normalised word with Arabic proclitics, e.g. علم → علم، العلم،
 * والعلم، بالعلم، للعلم … FTS5 matches whole tokens, so these forms are OR-ed together in the query.
 */
export function expandWord(word) {
  if (word.endsWith('*') || word.length < 2 || !/[ء-ي]/.test(word)) return [word];
  const definite = word.startsWith('ال') && word.length > 3;
  const base = definite ? word.slice(2) : word;
  const out = new Set();
  for (const c of CONJ) {
    for (const d of DEF) out.add(c + d + base);
    if (!definite) for (const p of PREP) out.add(c + p + base);
  }
  return [...out];
}

/**
 * Builds a global, unicode regex that finds any of the given words in original text, as whole
 * words. With `proclitics` the forms produced by expandWord are matched too.
 * Capture group 1 is the proclitic part, group 2 the word itself.
 */
export function highlightRegex(words, proclitics = true) {
  const parts = [...new Set(words.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(wordPattern);
  if (!parts.length) return null;
  const body = `(?:${parts.join('|')})`;
  const M = MARKS;
  const pre = proclitics
    ? `((?:[وف]${M})?(?:(?:[بك]${M})?ا${M}ل${M}|ل${M}ل${M}|[بكل]${M})?)`
    : '()';
  return new RegExp(`(?<![\\p{L}\\p{M}])${pre}(${body})(?![\\p{L}\\p{M}])`, 'gu');
}

/** Regex matching the words as one consecutive phrase (any whitespace/punctuation between words). */
export function phraseRegex(words) {
  const ws = words.filter(Boolean);
  if (!ws.length) return null;
  const body = ws.map(wordPattern).join('[\\s\\p{P}¬]+');
  return new RegExp(`(?<![\\p{L}\\p{M}])()(${body})(?![\\p{L}\\p{M}])`, 'gu');
}

/** Same word list for highlighting: a word given with ال is highlighted by its base too. */
export function highlightWords(words) {
  const out = [];
  for (const w of words) out.push(w.startsWith('ال') && w.length > 3 ? w.slice(2) : w);
  return out;
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function toArabicDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => ARABIC_DIGITS[d]);
}
