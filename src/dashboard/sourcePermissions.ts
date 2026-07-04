/**
 * Runtime host permissions + install-time referer rules for user sources.
 * Extension-page only (chrome.permissions / chrome.declarativeNetRequest).
 *
 * Rule mechanics live in @/shared/refererRules (shared with the background,
 * which merges runtime-discovered CDN hostnames into the same rule).
 */

import { refererRuleId, hostForRuleTarget, buildRefererRule } from '@/shared/refererRules';

/**
 * Request access to the given URLs' origins (no-op when already granted).
 * Entries containing a wildcard are treated as ready-made match patterns.
 */
export async function ensureOriginPermissions(urls: Array<string | undefined>): Promise<boolean> {
  const origins = [...new Set(
    urls
      .filter((u): u is string => !!u)
      .map((u) => u.includes('*') ? u : new URL(u).origin + '/*')
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
