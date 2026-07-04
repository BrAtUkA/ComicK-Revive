/**
 * Update checker: compares the running version against the latest GitHub
 * Release. api.github.com sends permissive CORS, so this needs no host
 * permission. Checks at most once a day on dashboard open (unless forced),
 * and shows a dismissible banner that won't nag again for the same version.
 */

import { showDashToast } from './Dashboard';

const REPO = 'BrAtUkA/ComicK-Revive';
const LAST_CHECK_KEY = 'crd_update_last_check';
const DISMISSED_KEY = 'crd_update_dismissed';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateResult {
  current: string;
  latest: string;
  htmlUrl: string;
  hasUpdate: boolean;
}

function currentVersion(): string {
  return chrome.runtime.getManifest().version;
}

/** Compare dotted numeric versions. Returns >0 if a newer than b. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatest(): Promise<{ tag: string; htmlUrl: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null; // 404 = no releases published yet
  const json = await res.json() as { tag_name?: string; html_url?: string };
  if (!json.tag_name) return null;
  return { tag: json.tag_name, htmlUrl: json.html_url || `https://github.com/${REPO}/releases` };
}

export async function checkForUpdate(force = false): Promise<UpdateResult | null> {
  if (!force) {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
    if (Date.now() - last < CHECK_INTERVAL_MS) return null;
  }
  let latest: { tag: string; htmlUrl: string } | null;
  try {
    latest = await fetchLatest();
  } catch {
    return null; // offline or rate limited; try again next open
  }
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  if (!latest) return null;

  const current = currentVersion();
  return {
    current,
    latest: latest.tag.replace(/^v/, ''),
    htmlUrl: latest.htmlUrl,
    hasUpdate: compareVersions(latest.tag, current) > 0,
  };
}

/** Auto-check on dashboard open; banner only for a not-yet-dismissed version. */
export async function initUpdateChecker(): Promise<void> {
  const result = await checkForUpdate(false);
  if (!result?.hasUpdate) return;
  if (localStorage.getItem(DISMISSED_KEY) === result.latest) return;
  renderBanner(result);
}

/** Manual "Check now": always fetches, always reports the outcome. */
export async function manualCheck(): Promise<void> {
  showDashToast('Checking for updates…');
  const result = await checkForUpdate(true);
  if (!result) {
    showDashToast('Could not reach GitHub. Try again later.');
    return;
  }
  if (result.hasUpdate) {
    localStorage.removeItem(DISMISSED_KEY);
    renderBanner(result);
  } else {
    showDashToast(`You're up to date (v${result.current}).`);
  }
}

function renderBanner(result: UpdateResult): void {
  document.querySelector('.crd-update-banner')?.remove();
  const banner = document.createElement('div');
  banner.className = 'crd-update-banner';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
    <div class="crd-update-text">
      <b>Update available: v${result.latest}</b>
      <span>You're on v${result.current}. Back up your data first (Settings &gt; Data), then replace your folder and Reload. Never Remove and re-add.</span>
    </div>
    <a class="crd-btn crd-btn-primary crd-btn-small" href="${result.htmlUrl}" target="_blank" rel="noopener">Get it</a>
    <button class="crd-icon-btn crd-update-x" title="Dismiss">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  banner.querySelector('.crd-update-x')?.addEventListener('click', () => {
    localStorage.setItem(DISMISSED_KEY, result.latest);
    banner.remove();
  });
  document.body.appendChild(banner);
}
