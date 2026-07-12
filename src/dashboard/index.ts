/**
 * ComicK Revive — Dashboard entry (extension page context)
 *
 * Has full chrome.* APIs and full DOM. bridge.ts detects this context and
 * talks to the background directly, so core managers, sources, and even the
 * full reader work here exactly as they do on comick.dev.
 */

import './dashboard.css';
import { Dashboard } from './Dashboard';
import { LibraryTab } from './tabs/LibraryTab';
import { SearchTab } from './tabs/SearchTab';
import { HistoryTab } from './tabs/HistoryTab';
import { StatsTab } from './tabs/StatsTab';
import { SettingsTab } from './tabs/SettingsTab';
import { SourcesTab } from './tabs/SourcesTab';
import { openReader } from './reader';
import { initUpdateChecker } from './updateChecker';
import { sourceMappingManager } from '@/core';
import { titleFromSlug } from '@/shared/fmt';

const root = document.getElementById('crd-app');
if (root) {
  const dashboard = new Dashboard([
    new LibraryTab((count) => dashboard.setNavCount('library', count)),
    new SearchTab(),
    new HistoryTab(),
    new StatsTab(),
    new SourcesTab(),
    new SettingsTab(),
  ]);
  dashboard.render(root);

  // Daily update check (throttled internally); shows a banner if behind
  void initUpdateChecker();

  // The browser context menu looks foreign next to our custom ones; keep it
  // only where it's genuinely useful: text fields (paste), selected text
  // (copy), and the reader overlay (save image)
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"], #comick-revive-viewer')) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });

  // Deep link from the popup: dashboard.html#read=<slug> opens the reader
  // over the dashboard at the saved position
  void (async () => {
    const match = window.location.hash.match(/^#read=(.+)$/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]);
    history.replaceState(null, '', window.location.pathname + '#library');
    const mapping = await sourceMappingManager.get(slug);
    openReader({
      slug,
      title: mapping?.customTitle || mapping?.comickTitle || titleFromSlug(slug),
      pageType: 'manga',
      forceResume: true,
    });
  })();
}
