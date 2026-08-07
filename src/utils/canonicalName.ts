/**
 * One canonical key for a building, so the three vocabularies can be joined.
 *
 * The same building is spelled differently in each source:
 *   energy data     'Bibliotek'      'Kårresturangen'
 *   node positions  'bibliotek'      (absent)
 *   Rhino layers    'Bibliotek'      'Kårresturangen'
 *
 * Exact string matching therefore drops buildings silently - the dashboard was
 * failing to place Bibliotek purely because of the leading capital. Folding
 * case, accents and punctuation makes the join survive that.
 */
export const canonicalName = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Build a lookup keyed by canonical name. Later entries do not overwrite
 * earlier ones, so callers can express precedence by insertion order.
 */
export const byCanonicalName = <T>(
  entries: Iterable<[string, T]>
): Map<string, T> => {
  const map = new Map<string, T>();
  for (const [name, value] of entries) {
    const key = canonicalName(name);
    if (!map.has(key)) map.set(key, value);
  }
  return map;
};
