/**
 * ── SHELVED 2026-07-11 ──────────────────────────────────────────────────
 * No UI entry points import this module anymore (it is tree-shaken out of
 * the bundle). The flow works in principle but consumed rounds of debugging
 * (full story + backlog: docs/bot-wall-unlock-and-cors.md); the catalog now
 * reports bot-walled sites as informational "blocked" instead. Re-entry
 * point when revisiting: wire unlockSite/ensureUnlockAccess back into the
 * catalog chip, SearchTab section, and flask test, then verify with the
 * [Unlock] logs below (dashboard-page console).
 * ────────────────────────────────────────────────────────────────────────
 *
 * Bot-wall unlock flow — the MV3 analogue of Tachiyomi's WebView Cloudflare
 * resolver (references .../yurigarden/CloudflareResolver.kt). Tachiyomi loads
 * the URL in a real, laid-out WebView so the challenge actually runs, then
 * polls the shared cookie jar for cf_clearance — cookie exists = solved,
 * because the WebView and its HTTP client share cookies and User-Agent. Our
 * translation: open the site in a **foreground** tab (a background tab is
 * throttled and Turnstile won't run without focus), poll for cf_clearance
 * (primary signal, Tachiyomi's method) plus a live fetch probe (fallback),
 * close the tab and hand focus back once cleared.
 *
 * The probe MUST bypass caches: manga sites typically run CF "cache
 * everything", so a cached homepage is served challenge-free to anyone —
 * from CF's edge or straight from Chrome's HTTP disk cache — while the
 * dynamic endpoints the sources actually hit stay walled. The probe uses a
 * unique query string (edge cache miss) + cache:'reload' (local cache miss).
 *
 * DIAGNOSTICS: every decision logs via console.warn with an [Unlock] prefix.
 * warn is deliberate — vite strips console.log/debug from production builds
 * (vite.config.ts `pure`), which made earlier rounds undebuggable. Read the
 * log in the DASHBOARD tab's DevTools console (F12 on the dashboard page,
 * not the service-worker console).
 *
 * The caller MUST hold host permission for target.baseUrl before calling
 * (the probe fetch needs it). Use ensureUnlockAccess() — one combined
 * permission prompt, called while the user gesture is still live.
 *
 * Honesty note: cf_clearance expires (commonly ~30 minutes, site-set), so
 * "unlocked" is a temporary state — sites re-challenge later and that is
 * normal, not a regression.
 */

import { fetchWithCors } from '@/utils/fetchWithCors';
import { looksChallenged } from '@/shared/botwall';
import { originPatternsFor } from './sourcePermissions';

const POLL_MS = 2_000;
const TIMEOUT_MS = 120_000;
const SETTLE_MS = 400; // let the clearance cookie commit before we close

/** Always-visible logging (console.log/debug are stripped from prod builds). */
function ulog(...args: unknown[]): void {
  console.warn('[Unlock]', ...args);
}

export type UnlockResult =
  | 'cleared'   // site reachable (cookie present or live probe passed)
  | 'timeout'   // challenge never finished within TIMEOUT_MS (tab left open)
  | 'closed'    // user closed the challenge tab before it cleared
  | 'no-tab';   // could not open a tab at all

export interface UnlockTarget {
  id: string;
  name: string;
  baseUrl: string;
}

export interface UnlockCallbacks {
  /** Fired once the challenge tab is actually opened (not on a pre-check pass). */
  onOpen?: () => void;
}

const inFlight = new Map<string, Promise<UnlockResult>>();

/**
 * Host permission (required — the probe fetch needs it) + cookies permission
 * (optional — lets us detect cf_clearance directly, the reliable signal).
 * All permission checks use contains() first (no gesture needed), then at
 * most ONE permissions.request covering everything missing — a second
 * request after a prompt round-trip has no user gesture left and throws.
 * Returns false only when host access is missing; cookies being declined
 * still allows the fetch-based fallback detection.
 */
export async function ensureUnlockAccess(baseUrls: string[]): Promise<boolean> {
  // Domain-wide scope so the probe survives the site's apex⇄www redirect
  // (the same CORS trap that made cleared sites look permanently blocked).
  const origins = [...new Set(baseUrls.flatMap(originPatternsFor))];
  try {
    const hasOrigins = await chrome.permissions.contains({ origins });
    const hasCookies = await chrome.permissions.contains({ permissions: ['cookies'] });
    ulog(`access: origins=${JSON.stringify(origins)} originsGranted=${hasOrigins} cookiesGranted=${hasCookies}`);
    if (hasOrigins && hasCookies) return true;
    if (!hasOrigins) {
      // One prompt for everything missing; cookies riding along costs nothing
      const granted = await chrome.permissions.request(
        hasCookies ? { origins } : { origins, permissions: ['cookies'] }
      );
      ulog(`combined permission request → ${granted}`);
      return granted;
    }
    // Origins fine, cookies missing: best-effort, declining is acceptable
    try {
      const got = await chrome.permissions.request({ permissions: ['cookies'] });
      ulog(`cookies permission request → ${got}`);
    } catch (error) {
      ulog(`cookies permission request threw (gesture consumed?): ${(error as Error).message}`);
    }
    return true;
  } catch (error) {
    ulog(`permission check failed: ${(error as Error).message}`);
    return false;
  }
}

interface ProbeVerdict {
  cleared: boolean;
  /** One-line summary of what the probe saw; used for logs and timeout notes. */
  summary: string;
}

/**
 * Live, uncacheable probe of the site. Challenge detection is header-first:
 * Cloudflare stamps `cf-mitigated: challenge` on every challenge response,
 * which also distinguishes "site challenges the extension's fetches
 * specifically" from parsing problems. Body sniffing stays as fallback.
 */
async function probeSite(baseUrl: string): Promise<ProbeVerdict> {
  // Unique query = CF edge cache miss; cache:'reload' = Chrome cache miss.
  // Without both, a cached homepage reports "clear" while the site is walled.
  const probeUrl = `${baseUrl.replace(/\/+$/, '')}/?crprobe=${Date.now().toString(36)}`;
  let res: Response;
  try {
    res = await fetchWithCors(
      probeUrl,
      { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      { credentials: 'include', cache: 'reload' },
    );
  } catch (error) {
    const msg = (error as Error).message;
    const summary = `probe fetch FAILED: ${msg}`;
    ulog(`${summary} — url=${probeUrl}. A CORS/TypeError here usually means missing host permission (does the site redirect to another domain?)`);
    return { cleared: false, summary };
  }

  const body = await res.text().catch(() => '');
  const finalUrl = res.url || probeUrl;
  const title = body.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim().slice(0, 60) ?? '';
  const cfMitigated = res.headers.get('cf-mitigated');
  const cfRay = res.headers.get('cf-ray');
  const server = res.headers.get('server');
  const bodyChallenge = looksChallenged(body);

  let redirectNote = '';
  try {
    const fromHost = new URL(probeUrl).hostname;
    const toHost = new URL(finalUrl).hostname;
    if (fromHost !== toHost) {
      redirectNote = ` REDIRECTED ${fromHost} → ${toHost} (host permission must cover the target domain!)`;
    }
  } catch { /* unparsable final url */ }

  const summary =
    `HTTP ${res.status}` +
    (cfMitigated ? ` cf-mitigated=${cfMitigated}` : '') +
    (cfRay ? ' cf-ray=present' : '') +
    (server ? ` server=${server}` : '') +
    ` title="${title}" bodyChallenge=${bodyChallenge} bodyLen=${body.length}` +
    redirectNote;

  const challenged = cfMitigated === 'challenge' || bodyChallenge;
  const cleared = res.ok && !challenged;
  ulog(`probe ${cleared ? 'CLEARED' : 'blocked'}: ${summary}`);
  if (!cleared && !challenged) {
    // Non-challenge failure (other WAF? server error?) — show what came back
    ulog(`probe body starts: "${body.slice(0, 160).replace(/\s+/g, ' ')}"`);
  }
  return { cleared, summary };
}

/** True once the site answers a LIVE, uncacheable request normally. Needs host permission. */
export async function isCleared(baseUrl: string): Promise<boolean> {
  return (await probeSite(baseUrl)).cleared;
}

interface CookieVerdict {
  /** true = cf_clearance present; false = absent; null = cannot tell */
  present: boolean | null;
  detail: string;
}

/**
 * Direct clearance-cookie check (Tachiyomi polls the CookieManager the same
 * way). Includes partitioned cookies in the search: a PARTITIONED
 * cf_clearance is the smoking gun for "tab works, extension fetches stay
 * blocked", because SW requests can't send another partition's cookies.
 * Reading cookies makes no network request, so unlike a fetch it can't
 * perturb a challenge that's mid-flight.
 */
async function clearanceCookieState(baseUrl: string): Promise<CookieVerdict> {
  try {
    if (!chrome.cookies?.getAll) {
      return { present: null, detail: 'cookies API unavailable (permission not granted → detection via probe only)' };
    }
    if (!await chrome.permissions.contains({ permissions: ['cookies'] })) {
      return { present: null, detail: 'cookies permission missing → detection via probe only' };
    }
    let all: chrome.cookies.Cookie[];
    try {
      // partitionKey {} matches partitioned AND unpartitioned cookies
      all = await chrome.cookies.getAll({ url: baseUrl, partitionKey: {} } as chrome.cookies.GetAllDetails);
    } catch {
      all = await chrome.cookies.getAll({ url: baseUrl }); // older Chrome
    }
    const names = all.map((c) => c.name + ((c as { partitionKey?: unknown }).partitionKey ? ' (partitioned)' : ''));
    const clearance = all.find((c) => c.name === 'cf_clearance');
    if (!clearance) {
      return { present: false, detail: `no cf_clearance yet. Site cookies: [${names.join(', ') || 'none'}]` };
    }
    const partitioned = !!(clearance as { partitionKey?: unknown }).partitionKey;
    const expires = clearance.expirationDate
      ? new Date(clearance.expirationDate * 1000).toISOString()
      : 'session';
    return {
      present: true,
      detail: `cf_clearance PRESENT${partitioned ? ' but PARTITIONED — extension fetches cannot send it!' : ''}, expires ${expires}`,
    };
  } catch (error) {
    return { present: null, detail: `cookie check failed: ${(error as Error).message}` };
  }
}

/**
 * Open the site in a foreground tab, wait for the wall to clear, close it.
 * Resolves 'cleared' once the site is reachable; 'timeout' leaves the tab
 * open so the user can keep solving at their own pace.
 */
export function unlockSite(target: UnlockTarget, cb: UnlockCallbacks = {}): Promise<UnlockResult> {
  const existing = inFlight.get(target.id);
  if (existing) return existing;
  const run = doUnlock(target, cb).finally(() => inFlight.delete(target.id));
  inFlight.set(target.id, run);
  return run;
}

async function doUnlock(target: UnlockTarget, cb: UnlockCallbacks): Promise<UnlockResult> {
  ulog(`── unlock start: ${target.name} (${target.baseUrl})`);
  const initialCookie = await clearanceCookieState(target.baseUrl);
  ulog(`initial cookie state: ${initialCookie.detail}`);

  // Already clear (solved earlier, or a sibling site on the same origin).
  // The probe is live + uncacheable, so a pass here is trustworthy.
  if ((await probeSite(target.baseUrl)).cleared) {
    ulog('already clear — no tab needed');
    return 'cleared';
  }

  const dashboardTabId = await currentTabId();
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.create({ url: target.baseUrl, active: true });
  } catch (error) {
    ulog(`could not open a tab: ${(error as Error).message}`);
    return 'no-tab';
  }
  ulog(`challenge tab #${tab.id} opened; polling every ${POLL_MS / 1000}s, timeout ${TIMEOUT_MS / 1000}s`);
  cb.onOpen?.();

  const backToDashboard = async () => {
    if (dashboardTabId != null) {
      try { await chrome.tabs.update(dashboardTabId, { active: true }); } catch { /* dashboard closed */ }
    }
  };

  const startedAt = Date.now();
  let poll = 0;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await sleep(POLL_MS);
    poll++;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    // A present cf_clearance cookie is an instant pass (Tachiyomi trusts it);
    // otherwise fall through to the real fetch probe. The cookie is only ever
    // a fast POSITIVE — its absence must never skip the fetch, or a site that
    // clears without a cf_clearance-named cookie would never be detected.
    const cookie = await clearanceCookieState(target.baseUrl);
    const clearedByCookie = cookie.present === true;
    ulog(`poll #${poll} (${elapsed}s): ${cookie.detail}`);
    const cleared = clearedByCookie || (await probeSite(target.baseUrl)).cleared;

    if (cleared) {
      ulog(`cleared after ${elapsed}s (${clearedByCookie ? 'via cookie' : 'via probe'}) — closing tab`);
      await sleep(SETTLE_MS);
      await removeTab(tab.id);
      await backToDashboard();
      return 'cleared';
    }
    // User closed the challenge tab: treat as cancel, but check once more in
    // case they solved it and closed the tab before our next poll
    if (tab.id !== undefined && !(await tabExists(tab.id))) {
      ulog('challenge tab was closed by the user; final probe…');
      const solved = (await probeSite(target.baseUrl)).cleared;
      if (solved) {
        await backToDashboard();
        return 'cleared';
      }
      return 'closed';
    }
  }
  ulog(`timed out after ${TIMEOUT_MS / 1000}s — leaving the tab open. If the site looks NORMAL in that tab while every probe above says blocked, the site is discriminating the extension's requests (or cf_clearance is partitioned); copy this log into an issue.`);
  return 'timeout';
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function currentTabId(): Promise<number | undefined> {
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab?.id;
  } catch {
    return undefined;
  }
}

async function removeTab(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch { /* user already closed it */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
