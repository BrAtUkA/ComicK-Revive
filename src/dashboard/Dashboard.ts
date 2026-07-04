/**
 * Dashboard shell — collapsible sidebar navigation + tab host.
 *
 * Nav is split into a main group (Search, Library, Stats, Sources) and a
 * bottom group pinned above the footer (Settings). The sidebar collapses
 * to an icon rail; the state persists per browser.
 */

export interface DashboardTab {
  id: string;
  label: string;
  icon: string;  // inline SVG markup
  /** Pin to the bottom group (e.g. Settings). */
  bottom?: boolean;
  /** Render into host. Called every time the tab becomes active. */
  mount(host: HTMLElement): Promise<void> | void;
  unmount?(): void;
}

const COLLAPSE_KEY = 'crd_sidebar_collapsed';
const COLLAPSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>`;
const EXPAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>`;

export class Dashboard {
  private tabs: DashboardTab[];
  private active: DashboardTab | null = null;
  private main: HTMLElement | null = null;
  private root: HTMLElement | null = null;

  constructor(tabs: DashboardTab[]) {
    this.tabs = tabs;
  }

  render(root: HTMLElement): void {
    this.root = root;
    const manifest = chrome.runtime.getManifest();
    const version = (manifest as { version_name?: string }).version_name ?? manifest.version;
    const collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';

    root.classList.toggle('collapsed', collapsed);
    root.innerHTML = `
      <aside class="crd-side">
        <div class="crd-brand">
          <div class="crd-brand-mark">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/>
              <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>
            </svg>
          </div>
          <div class="crd-brand-text">ComicK Revive<span>Dashboard</span></div>
        </div>
        <nav class="crd-nav" id="crd-nav-main"></nav>
        <div class="crd-side-bottom">
          <nav class="crd-nav" id="crd-nav-bottom"></nav>
          <div class="crd-side-foot">
            <span class="crd-side-version">v${version}</span>
            <button class="crd-icon-btn crd-side-collapse" id="crd-collapse" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
              ${collapsed ? EXPAND_SVG : COLLAPSE_SVG}
            </button>
          </div>
        </div>
      </aside>
      <main class="crd-main" id="crd-main"></main>
    `;

    const mainNav = root.querySelector('#crd-nav-main')!;
    const bottomNav = root.querySelector('#crd-nav-bottom')!;
    for (const tab of this.tabs) {
      const btn = document.createElement('button');
      btn.className = 'crd-nav-btn';
      btn.dataset.tab = tab.id;
      btn.title = tab.label;
      btn.innerHTML = `${tab.icon}<span class="crd-nav-label">${tab.label}</span><span class="crd-nav-count" data-count="${tab.id}" hidden></span>`;
      btn.addEventListener('click', () => { window.location.hash = tab.id; });
      (tab.bottom ? bottomNav : mainNav).appendChild(btn);
    }

    root.querySelector('#crd-collapse')?.addEventListener('click', () => this.toggleCollapse());

    this.main = root.querySelector('#crd-main');
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  private toggleCollapse(): void {
    if (!this.root) return;
    const collapsed = this.root.classList.toggle('collapsed');
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    const btn = this.root.querySelector<HTMLButtonElement>('#crd-collapse');
    if (btn) {
      btn.innerHTML = collapsed ? EXPAND_SVG : COLLAPSE_SVG;
      btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
  }

  /** Set the small counter badge on a nav item (e.g. library size) */
  setNavCount(tabId: string, count: number): void {
    const el = document.querySelector<HTMLElement>(`[data-count="${tabId}"]`);
    if (el) {
      el.textContent = String(count);
      el.hidden = count <= 0;
    }
  }

  private route(): void {
    const id = window.location.hash.replace('#', '') || this.tabs[0].id;
    const tab = this.tabs.find((t) => t.id === id) ?? this.tabs[0];
    if (tab === this.active) return;

    this.active?.unmount?.();
    this.active = tab;

    document.querySelectorAll('.crd-nav-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab.id);
    });

    if (this.main) {
      this.main.innerHTML = '';
      void tab.mount(this.main);
    }
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Bottom-right transient confirmation toast */
export function showDashToast(message: string): void {
  document.querySelector('.crd-toast')?.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const el = document.createElement('div');
  el.className = 'crd-toast';
  el.textContent = message;
  document.body.appendChild(el);

  toastTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 2200);
}
