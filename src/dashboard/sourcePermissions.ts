/**
 * Runtime host permissions + install-time referer rules for user sources.
 * Extension-page only (chrome.permissions / chrome.declarativeNetRequest).
 *
 * Rule mechanics live in @/shared/refererRules (shared with the background,
 * which merges runtime-discovered CDN hostnames into the same rule).
 */

import { refererRuleId, hostForRuleTarget, buildRefererRule } from '@/shared/refererRules';

/**
 * Match patterns covering a site AND the origins its requests redirect to.
 * MV3 re-checks CORS on every redirect hop: a fetch to a granted origin that
 * 301s to an un-granted one (the ubiquitous apex⇄www hop, or a same-site CDN
 * subdomain) loses the CORS bypass and throws "Failed to fetch". Granting the
 * registrable-domain scope (apex + www + `*.{bare}`) keeps the bypass across
 * those hops. `bare` strips only a leading `www.` (never a public suffix), so
 * the wildcard stays site-scoped: never a public-suffix wildcard, never an
 * all-hosts pattern. Wildcard inputs are passed through untouched.
 */
export function originPatternsFor(url: string): string[] {
  if (url.includes('*')) return [url];
  try {
    const host = new URL(url).hostname;
    const bare = host.replace(/^www\./, '');
    // Both schemes: sites bounce through a plain-http hop mid-redirect
    // (zinmanga.net's trailing-slash normalization goes https → http →
    // https), and an https-only grant loses the CORS bypass on that hop.
    // http://*/* is in optional_host_permissions, so this is requestable.
    return [...new Set(['https', 'http'].flatMap((scheme) => [
      `${scheme}://${host}/*`,
      `${scheme}://${bare}/*`,
      `${scheme}://www.${bare}/*`,
      `${scheme}://*.${bare}/*`,
    ]))];
  } catch {
    return [];
  }
}

/**
 * Request access to the given URLs' registrable-domain scope (no-op when
 * already granted). Entries containing a wildcard are treated as ready-made
 * match patterns. See originPatternsFor for why the scope is domain-wide.
 */
export async function ensureOriginPermissions(urls: Array<string | undefined>): Promise<boolean> {
  const origins = [...new Set(
    urls.filter((u): u is string => !!u).flatMap(originPatternsFor)
  )];
  if (origins.length === 0) return true;
  if (await chrome.permissions.contains({ origins })) return true;
  return await chrome.permissions.request({ origins });
}

/**
 * Install (or remove, when referer is null) the source's Referer rule,
 * seeded with its base domain and any concrete imageHosts. Wildcard-only
 * imageHosts contribute nothing here; the background grows the rule with
 * hostnames discovered from real thumbnail/page URLs at runtime.
 */
export async function setRefererRule(
  sourceId: string,
  baseUrl: string,
  referer: string | null,
  imageHosts: string[] = []
): Promise<void> {
  const id = refererRuleId(sourceId);
  const removeRuleIds = [id];
  if (!referer) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    return;
  }

  const requestDomains = [...new Set([baseUrl, ...imageHosts]
    .map(hostForRuleTarget)
    .filter((domain): domain is string => !!domain))];

  if (requestDomains.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: [buildRefererRule(id, referer, requestDomains)],
  });
}
