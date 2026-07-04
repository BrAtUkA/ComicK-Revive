/**
 * Referer DNR rule helpers shared by the dashboard (install-time rules) and
 * the background (runtime domain discovery). Pure functions only: this is
 * imported by the service worker.
 *
 * One dynamic rule per source (stable hashed id) sets the source's Referer
 * on requests to its known domains. Domains come from two places: the spec
 * (baseUrl + concrete imageHosts) at install time, and hostnames discovered
 * at runtime from actual thumbnail/cover/page URLs, which is the only way
 * to cover rotating or unknown image CDNs.
 */

/** Stable DNR rule id per source (dynamic rule ids must be integers). */
export function refererRuleId(sourceId: string): number {
  let hash = 0;
  for (let i = 0; i < sourceId.length; i++) {
    hash = (hash * 31 + sourceId.charCodeAt(i)) | 0;
  }
  return 900000 + (Math.abs(hash) % 90000);
}

/**
 * Extract a rule-usable domain from a URL or match pattern.
 * Wildcard-only patterns (https://*\/*) yield null: those grant permission
 * breadth but cannot seed a rule; runtime discovery covers them instead.
 */
export function hostForRuleTarget(target: string): string | null {
  try {
    const host = target.includes('*')
      ? target.match(/^[a-z]+:\/\/([^/]+)/i)?.[1]
      : new URL(target).hostname;
    if (!host || host === '*') return null;
    return host.startsWith('*.') ? host.slice(2) : host;
  } catch {
    return null;
  }
}

/** Build the modifyHeaders rule for a source's Referer over its domains. */
export function buildRefererRule(
  id: number,
  referer: string,
  requestDomains: string[]
): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{
        header: 'Origin',
        operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
      }, {
        header: 'Referer',
        operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
        value: referer,
      }],
    },
    condition: {
      requestDomains,
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'image' as chrome.declarativeNetRequest.ResourceType,
        'media' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}
