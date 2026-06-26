/**
 * Source Domain Configuration
 *
 * Centralizes domain-matching rules for all manga sources.
 * Used by background (referer/header injection), imageLoader (proxy detection),
 * and anywhere else that needs to map URLs to source behavior.
 *
 * When adding a new source, add its config here instead of scattering
 * domain checks across multiple files.
 */

export interface SourceDomainConfig {
  /** Source identifier (matches MangaSource.id) */
  sourceId: string;
  /** Referer to send with requests to this source's domains */
  referer: string;
  /**
   * Domain patterns to match against URLs.
   * Uses simple `.includes()` matching — so 'mangakatana.com' matches
   * both 'mangakatana.com' and 'i1.mangakatana.com'.
   */
  domains: string[];
}

/**
 * All registered source domain configs.
 * Order doesn't matter — first match wins in getConfigForUrl.
 */
const SOURCE_DOMAIN_CONFIGS: SourceDomainConfig[] = [
  {
    sourceId: 'asura',
    referer: 'https://asurascans.com/',
    domains: ['asurascans.com', 'api.asurascans.com', 'cdn.asurascans.com'],
  },
  {
    sourceId: 'mangakatana',
    referer: 'https://mangakatana.com/',
    domains: ['mangakatana.com'],
  },
  {
    sourceId: 'mangadex',
    referer: 'https://mangadex.org/',
    domains: ['mangadex.org', 'mangadex.network'],
  },
];

/**
 * Find the source config that matches a given URL.
 */
export function getConfigForUrl(url: string): SourceDomainConfig | null {
  return SOURCE_DOMAIN_CONFIGS.find(config =>
    config.domains.some(domain => url.includes(domain))
  ) ?? null;
}

/**
 * Get the referer header for a URL, or empty string if no match.
 */
export function getRefererForUrl(url: string): string {
  return getConfigForUrl(url)?.referer ?? '';
}

/**
 * Check if a URL belongs to any registered source (needs proxying).
 */
export function isSourceUrl(url: string): boolean {
  return getConfigForUrl(url) !== null;
}
