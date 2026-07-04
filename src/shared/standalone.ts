/**
 * Standalone manga identity.
 *
 * Everything (reading state, source mappings, stats) is keyed by a "comick
 * slug". Manga opened from the dashboard's search have no comick page, so
 * they get a synthetic slug carrying their source identity. The leading
 * tilde can never appear in a real comick slug, which makes the two
 * namespaces impossible to confuse.
 */

const MARKER = '~';

export function standaloneSlug(sourceId: string, sourceSlug: string): string {
  return `${MARKER}${sourceId}${MARKER}${sourceSlug}`;
}

export function isStandaloneSlug(slug: string): boolean {
  return slug.startsWith(MARKER);
}

export function parseStandaloneSlug(slug: string): { sourceId: string; sourceSlug: string } | null {
  if (!isStandaloneSlug(slug)) return null;
  const rest = slug.slice(1);
  const split = rest.indexOf(MARKER);
  if (split <= 0) return null;
  return {
    sourceId: rest.slice(0, split),
    sourceSlug: rest.slice(split + 1),
  };
}
