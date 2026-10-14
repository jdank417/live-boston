// Finds stations, lines, vehicles and docks by name or number. Every word of
// the query has to match the start of some word in the item ("park st" finds
// Park Street); a match at the start of the name ranks highest.

export interface SearchItem {
  kind: 'line' | 'station' | 'vehicle' | 'dock';
  id: string;
  title: string;
  subtitle: string;
  color: string;
  /** Extra words that should find it: train numbers, destinations, aliases. */
  terms: string;
  /** Tie-breaker: lines and stations above individual vehicles. */
  boost: number;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Common shorthand riders type. */
const ALIASES: [RegExp, string][] = [
  [/\bst\b/g, 'street'],
  [/\bsq\b/g, 'square'],
  [/\bctr\b/g, 'center'],
  [/\bjfk\b/g, 'jfk umass'],
];

export function search(items: SearchItem[], query: string, limit = 12): SearchItem[] {
  let q = normalize(query);
  if (!q) return [];
  for (const [re, to] of ALIASES) q = q.replace(re, to);
  const tokens = q.split(' ');
  const numeric = /^\d+$/.test(q);
  const scored: [number, SearchItem][] = [];
  for (const item of items) {
    const title = normalize(item.title);
    const words = `${title} ${normalize(item.terms)}`.split(' ');
    // Each token must be the start of some word (or the token "street" may be
    // satisfied by "st" in the data, and vice versa).
    if (!tokens.every((t) => words.some((w) => w.startsWith(t) || (t === 'street' && w === 'st')))) continue;
    let score = item.boost;
    // A bare number is a train, bus or car number far more often than a street address.
    if (numeric) score += item.kind === 'vehicle' ? 80 : item.kind === 'dock' ? -60 : 0;
    // The exact number or word, not just its start ("508", not "5081").
    if (tokens.every((t) => words.includes(t))) score += 30;
    if (title === q) score += 100;
    else if (title.startsWith(q)) score += 70;
    else if (title.split(' ').some((w) => w.startsWith(tokens[0]))) score += 40;
    score -= title.length / 40;
    scored.push([score, item]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, item]) => item);
}
