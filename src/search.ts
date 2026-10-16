// Mode search: word-by-word, any order, typo-tolerant, ranked.
// Pure functions so they can be unit-tested outside the browser.

export interface Searchable {
  name: string;
  group: string;
  description: string;
}

const WORD_RE = /[a-z0-9]+/g;

// Crude plural folding so "enemy" finds "Enemies" and "pest" finds "Pests".
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) || []).map(stem);
}

// Size words people use interchangeably. A search word also matches its synonyms.
const SYNONYMS: string[][] = [
  ['tiny', 'small', 'smaller', 'little', 'mini', 'tinies'],
  ['giant', 'large', 'larger', 'big', 'bigger', 'huge'],
];
function alternatives(token: string): string[] {
  for (const set of SYNONYMS) {
    if (set.map(stem).includes(token)) return Array.from(new Set(set.map(stem)));
  }
  return [token];
}

// Levenshtein distance with an early exit once it exceeds `max`.
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How many typos a search word may contain. Short words must match exactly,
// otherwise "law" would match half the list.
function allowedTypos(token: string): number {
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

// 3 = exact word, 2 = word starts with token / contains it, 1 = typo match, 0 = none.
function matchWord(token: string, fieldWords: string[], fieldText: string, fuzzy: boolean): number {
  let best = 0;
  for (const w of fieldWords) {
    if (w === token) return 3;
    if (w.startsWith(token)) best = Math.max(best, 2);
  }
  if (best === 0 && token.length >= 3 && fieldText.includes(token)) best = 2;
  if (best > 0 || !fuzzy) return best;
  const max = allowedTypos(token);
  if (max === 0) return 0;
  for (const w of fieldWords) {
    // Compare against the whole word and against a prefix of the same length,
    // so a misspelled half-typed word ("tecnol") still finds "technology".
    if (editDistance(token, w, max) <= max) return 1;
    if (w.length > token.length && editDistance(token, w.slice(0, token.length), max) <= max) return 1;
  }
  return 0;
}

export function tokenize(query: string): string[] {
  return words(query);
}

function matchAny(token: string, fieldWords: string[], fieldText: string, fuzzy: boolean): number {
  const alts = alternatives(token);
  let best = matchWord(token, fieldWords, fieldText, fuzzy);
  // Synonyms count slightly less than the word actually typed.
  for (const a of alts) if (a !== token) best = Math.max(best, Math.min(2, matchWord(a, fieldWords, fieldText, false)));
  return best;
}

/**
 * Score a mode against the search words. Returns 0 when any word is missing
 * (every word must match somewhere), otherwise a positive relevance score.
 * Name matches weigh most, then group, then description. Typos are only
 * tolerated in the name and group; descriptions are long enough that fuzzy
 * matching them would pull in noise.
 */
export function scoreMode(mode: Searchable, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const nameText = mode.name.toLowerCase();
  const groupText = mode.group.toLowerCase();
  const descText = mode.description.toLowerCase();
  const nameWords = words(nameText);
  const groupWords = words(groupText);
  const descWords = words(descText);
  let score = 0;
  for (const t of tokens) {
    const n = matchAny(t, nameWords, nameText, true);
    const g = matchAny(t, groupWords, groupText, true);
    const d = matchAny(t, descWords, descText, false);
    const best = Math.max(n * 10, g * 4, d * 1);
    if (best === 0) return 0;
    score += best;
  }
  // Bonus when the whole query appears in the name as typed.
  if (nameText.includes(tokens.join(' '))) score += 15;
  return score;
}

// Natural order so "Tech Era 10" comes after "Tech Era 9".
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// "Tiny Treatment 3: Wary" -> "Tiny Treatment". Names without a "<number>:"
// part have no family.
export function familyOf(name: string): string | null {
  const m = name.match(/^(.*?\S)\s+\d+\s*:/);
  return m ? m[1] : null;
}
