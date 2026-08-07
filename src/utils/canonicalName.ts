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
/**
 * Misspellings in one source that folding case and accents cannot reconcile.
 *
 * Kept as an explicit list rather than fuzzy matching: a near-match would also
 * happily pair 'Vasa 11' with 'Vasa 1', which are different buildings, and
 * silently attaching one building's roof or geometry to another is worse than
 * reporting it missing. Each entry is a letter dropped in the Rhino layer name.
 */
const ALIASES: Record<string, string> = {
  elkrafteknik: 'elkraftteknik',   // Rhino layer is missing a 't'
  bibiotek: 'bibliotek',           // Rhino layer was missing an 'l'
};

export const canonicalName = (value: string): string => {
  const folded = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ALIASES[folded] ?? folded;
};

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
