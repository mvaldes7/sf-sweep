import type { SideRecord } from './data';

/** Grouped by street, dictionary-free tuples: house+suffix, lng/lat 1e-5 offsets, CNN. */
export type AddressRow = [string, number, number, number];
export interface AddressIndex { version: 1; streets: Record<string, AddressRow[]> }
export interface AddressHit { label: string; street: string; point: [number, number]; cnn: string; baseFallback: boolean }
const TYPES: Record<string, string> = { street: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy' };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
export function normalizeStreet(value: string): string {
  return value.toLowerCase().replace(/[.'’]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(twenty|thirty|forty|fifty)\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g, (_, ten: string, one: string) => String(TENS[ten] + ORDINALS[one]))
    .replace(/\b[a-z]+\b/g, word => ORDINALS[word] ? String(ORDINALS[word]) : TYPES[word] || word)
    .replace(/\b0*(\d+)(?:st|nd|rd|th)?\b/g, (_, n: string) => String(Number(n))).replace(/\s+/g, ' ').trim();
}
export function parseAddress(query: string): { house: string; street: string } | null {
  // Dataset contains base addresses, not apartment units. Never send the query off-device.
  const clean = query.trim().replace(/\s*(?:#|\bapt\.?\s|\bapartment\s|\bunit\s|\bsuite\s).*/i, '')
    .replace(/,\s*(?:san francisco|sf)\b.*/i, '').trim();
  // A single letter suffix is part of the base address; don't mistake "30th Ave" for house 30.
  const match = clean.match(/^(\d+)\s*([a-z])?\s+(.+)$/i);
  if (!match) return null;
  const street = normalizeStreet(match[3]);
  return street ? { house: String(Number(match[1])) + (match[2] || '').toUpperCase(), street } : null;
}

export function lookupAddresses(index: AddressIndex, query: string, limit = 8): AddressHit[] {
  const parsed = parseAddress(query);
  if (!parsed) return [];
  const matches = Object.keys(index.streets).filter(street => {
    const norm = normalizeStreet(street);
    return norm === parsed.street || norm.startsWith(parsed.street + ' ');
  }).sort((a, b) => Number(normalizeStreet(b) === parsed.street) - Number(normalizeStreet(a) === parsed.street) || a.localeCompare(b));
  const hits: AddressHit[] = [];
  for (const street of matches) {
    const rows = index.streets[street];
    let found = rows.filter(r => r[0] === parsed.house);
    const baseFallback = found.length === 0 && /[A-Z]$/.test(parsed.house);
    if (baseFallback) found = rows.filter(r => r[0] === parsed.house.slice(0, -1));
    for (const row of found) {
      hits.push({ label: `${row[0]} ${street}`, street, point: [row[1] / 1e5 - 122, row[2] / 1e5 + 37], cnn: String(row[3]), baseFallback });
      if (hits.length === limit) return hits;
    }
  }
  return hits;
}

/** EAS supplies the exact block CNN. Compare its two offset sides, not arbitrary nearby blocks.
 * Midpoints differ only by the pipeline's perpendicular offset; the nearest one estimates
 * the building's side. Building points/setbacks/corners are imperfect: posted signs win.
 */
export function selectAddressSide(sides: SideRecord[], hit: AddressHit): SideRecord | undefined {
  const candidates = sides.filter(s => s.cnn === hit.cnn && normalizeStreet(s.street) === normalizeStreet(hit.street));
  const distance = (s: SideRecord) => ((s.mid[0] - hit.point[0]) * Math.cos(hit.point[1] * Math.PI / 180)) ** 2 + (s.mid[1] - hit.point[1]) ** 2;
  return candidates.sort((a, b) => distance(a) - distance(b) || a.id - b.id)[0];
}

let pending: Promise<AddressIndex> | undefined;
export function loadAddresses(): Promise<AddressIndex> {
  return pending ??= fetch('/addresses.json').then(async res => {
    if (!res.ok) throw new Error('Address index unavailable');
    const index = await res.json() as AddressIndex;
    if (index.version !== 1 || !index.streets) throw new Error('Address index invalid');
    return index;
  }).catch(error => { pending = undefined; throw error; });
}
