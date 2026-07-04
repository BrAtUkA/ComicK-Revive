import { readingStateManager, sourceMappingManager } from '@/core';
import type { MangaReadingState, MangaSourceMapping } from '@/types';
import { bridgeGetCachedChapters } from '@/utils/bridge';
import { getCoverDataUrl } from '@/shared/covers';
import { isStandaloneSlug } from '@/shared/standalone';
import type { DashboardTab } from '../Dashboard';
import { openReader } from '../reader';
import { timeAgo, titleFromSlug, escapeHtml } from '@/shared/fmt';

const COMICK_ORIGIN = 'https://comick.dev';

interface LibraryEntry {
  slug: string;
  state: MangaReadingState;
  mapping: MangaSourceMapping | null;
}

/**
 * Library — every manga with reading progress, most recent first.
 * Clicking a card deep-links to comick.dev with ?crv_resume=1, which the
 * content script picks up to auto-open the reader at the saved position.
 */
export class LibraryTab implements DashboardTab {
  id = 'library';
  label = 'Library';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`;

  private onCount?: (n: number) => void;

  constructor(onCount?: (n: number) => void) {
    this.onCount = onCount;
  }

  async mount(host: HTMLElement): Promise<void> {
    host.innerHTML = `
      <h1 class="crd-tab-head">Library</h1>
      <p class="crd-tab-sub">Everything you've been reading. Click a title to jump back in on ComicK.</p>
      <div id="crd-lib-body"></div>
    `;
    const body = host.querySelector<HTMLElement>('#crd-lib-body')!;

    const [withProgress, mappings] = await Promise.all([
      readingStateManager.getAllWithProgress(),
      sourceMappingManager.getAll(),
    ]);
    const mappingBySlug = new Map(mappings.map((m) => [m.comickSlug, m]));

    const entries: LibraryEntry[] = withProgress
      .map(({ slug, state }) => ({ slug, state, mapping: mappingBySlug.get(slug) ?? null }))
      .sort((a, b) => (b.state.lastRead || 0) - (a.state.lastRead || 0));

    this.onCount?.(entries.length);

    if (entries.length === 0) {
      body.innerHTML = `
        <div class="crd-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>
          <h3>Nothing here yet</h3>
          <p>Your library builds itself as you read.<br>Search a title above, or open a manga on <a href="${COMICK_ORIGIN}" target="_blank" rel="noopener">comick.dev</a> and hit Start Reading.</p>
          <p class="crd-empty-restore">Restoring after an update or reinstall? <a href="#settings">Import a backup</a> in Settings &gt; Data.</p>
        </div>
      `;
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'crd-lib-grid';
    body.appendChild(grid);

    for (const entry of entries) {
      grid.appendChild(this.renderCard(entry));
    }
  }

  private renderCard(entry: LibraryEntry): HTMLElement {
    const { slug, state, mapping } = entry;
    const title = mapping?.customTitle || mapping?.comickTitle || titleFromSlug(slug);
    const readCount = state.readChapters?.length ?? 0;

    const card = document.createElement('a');
    card.className = 'crd-card';
    card.title = `Continue reading from chapter ${state.currentChapter}`;

    if (isStandaloneSlug(slug)) {
      // Standalone manga (added via dashboard search) read right here
      card.href = '#library';
      card.addEventListener('click', (e) => {
        e.preventDefault();
        openReader({ slug, title, pageType: 'manga', forceResume: true });
      });
    } else {
      card.href = `${COMICK_ORIGIN}/comic/${slug}?crv_resume=1`;
      card.target = '_blank';
      card.rel = 'noopener';
    }
    card.innerHTML = `
      <div class="crd-card-cover">
        <div class="crd-card-letter">${escapeHtml(title.slice(0, 1).toUpperCase())}</div>
        <img alt="" loading="lazy">
        <div class="crd-card-scrim">
          <div class="crd-card-title">${escapeHtml(title)}</div>
        </div>
      </div>
      <div class="crd-card-progress" hidden><span style="width:0%"></span></div>
      <div class="crd-card-meta">
        <span class="crd-chip">Ch. ${state.currentChapter}</span>
        <span>${state.lastRead ? timeAgo(state.lastRead) : ''}</span>
      </div>
    `;

    void this.hydrateCard(card, entry, readCount);
    return card;
  }

  /** Fill cover image + progress bar from cached source data (never blocks render) */
  private async hydrateCard(card: HTMLElement, entry: LibraryEntry, readCount: number): Promise<void> {
    const mapping = entry.mapping;
    const sourceId = mapping?.selectedSource;
    const sourceSlug = sourceId ? mapping?.sources[sourceId]?.slug : undefined;
    if (!sourceId || !sourceSlug) return;

    // Progress: only when the real chapter total is already cached
    try {
      const chapters = await bridgeGetCachedChapters(sourceId, sourceSlug);
      if (chapters && chapters.length > 0) {
        const pct = Math.min(100, Math.round((readCount / chapters.length) * 100));
        const bar = card.querySelector<HTMLElement>('.crd-card-progress');
        if (bar) {
          bar.hidden = false;
          bar.querySelector('span')!.style.width = `${pct}%`;
        }
      }
    } catch { /* no cached chapter list — skip the bar */ }

    const dataUrl = await getCoverDataUrl(sourceId, sourceSlug);
    if (!dataUrl) return;
    const img = card.querySelector<HTMLImageElement>('img');
    if (img) {
      img.src = dataUrl;
      img.addEventListener('load', () => {
        img.classList.add('loaded');
        // The letter placeholder is absolutely positioned so it paints
        // above the in-flow img; drop it once the cover is showing
        card.querySelector('.crd-card-letter')?.remove();
      }, { once: true });
    }
  }
}
