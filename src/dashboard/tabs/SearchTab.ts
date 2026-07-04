import { sourceRegistry } from '@/sources';
import type { MangaSource } from '@/sources';
import type { SearchResult, MangaDetails } from '@/types';
import { sourceMappingManager } from '@/core';
import { findBestMatchesMultiRef } from '@/utils/fuzzy-match';
import type { DashboardTab } from '../Dashboard';
import { buildModal } from '../modal';
import { openSearchResult } from '../reader';
import { standaloneSlug } from '@/shared/standalone';
import { escapeHtml } from '@/shared/fmt';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 450;

type SourceStatus = 'loading' | 'done' | 'error';
type Filter = 'best' | 'all' | string;

/**
 * Search — sources render as separate sections, with a pill bar on top:
 * "Best match" (default) shows the single highest-scoring result per source
 * ranked by similarity to the query (same behavior as the comick grid
 * view's Most Relevant tab), "All sources" stacks every section, and each
 * source pill focuses one section. Cards open a details modal.
 */
export class SearchTab implements DashboardTab {
  id = 'search';
  label = 'Search';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>`;

  private session = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private knownSlugs: Set<string> = new Set();

  private query = '';
  private sources: MangaSource[] = [];
  private results: Map<string, SearchResult[]> = new Map();
  private statuses: Map<string, SourceStatus> = new Map();
  private filter: Filter = 'best';
  private pillsEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;

  async mount(host: HTMLElement): Promise<void> {
    await sourceRegistry.refreshConfig();
    await sourceRegistry.loadUserSources();

    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Search</h1>
        <p class="crd-tab-sub">Search your sources directly and read right here.</p>
        <div class="crd-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>
          <input type="text" id="crd-search-input" placeholder="Search manga across your sources" autocomplete="off" spellcheck="false">
        </div>
        <div class="crd-search-pills" id="crd-search-pills" hidden></div>
        <div id="crd-search-results"></div>
      </div>
    `;

    const mappings = await sourceMappingManager.getAll();
    this.knownSlugs = new Set(mappings.map((m) => m.comickSlug));
    this.pillsEl = host.querySelector('#crd-search-pills');
    this.resultsEl = host.querySelector('#crd-search-results');

    const input = host.querySelector<HTMLInputElement>('#crd-search-input')!;
    input.focus();
    input.addEventListener('input', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.runSearch(input.value), DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        void this.runSearch(input.value);
      }
    });
  }

  unmount(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.session++;
    this.pillsEl = null;
    this.resultsEl = null;
  }

  private async runSearch(rawQuery: string): Promise<void> {
    const query = rawQuery.trim();
    const session = ++this.session;

    this.query = query;
    this.results.clear();
    this.statuses.clear();
    this.filter = 'best';

    if (query.length < MIN_QUERY) {
      if (this.pillsEl) this.pillsEl.hidden = true;
      if (this.resultsEl) this.resultsEl.innerHTML = '';
      return;
    }

    this.sources = sourceRegistry.getAll();
    if (this.sources.length === 0) {
      if (this.resultsEl) {
        this.resultsEl.innerHTML = `<div class="crd-empty"><h3>No sources enabled</h3><p>Enable or add sources in the Sources tab.</p></div>`;
      }
      return;
    }

    for (const source of this.sources) this.statuses.set(source.id, 'loading');
    if (this.pillsEl) this.pillsEl.hidden = false;
    this.renderPills();
    this.renderResults();

    await Promise.all(this.sources.map(async (source) => {
      try {
        const items = await source.search(query);
        if (session !== this.session) return;
        this.results.set(source.id, items);
        this.statuses.set(source.id, 'done');
      } catch {
        if (session !== this.session) return;
        this.statuses.set(source.id, 'error');
      }
      this.renderPills();
      this.renderResults();
    }));
  }

  private anyLoading(): boolean {
    return [...this.statuses.values()].some((s) => s === 'loading');
  }

  // ── Pills ─────────────────────────────────────────────────────────────────

  private renderPills(): void {
    if (!this.pillsEl) return;
    const total = [...this.results.values()].reduce((n, r) => n + r.length, 0);
    const loading = this.anyLoading();

    const pill = (id: string, label: string, count: string, extraClass = '') => `
      <button class="crd-pill${this.filter === id ? ' active' : ''}${extraClass}" data-filter="${escapeHtml(id)}">
        ${escapeHtml(label)}<span class="crd-pill-count">${count}</span>
      </button>
    `;

    let html = pill('best', 'Best match', loading ? '…' : String(this.bestMatches().length));
    html += pill('all', 'All sources', loading ? `${total}…` : String(total));
    for (const source of this.sources) {
      const status = this.statuses.get(source.id);
      const count = status === 'loading' ? '…' : status === 'error' ? '!' : String(this.results.get(source.id)?.length ?? 0);
      html += pill(source.id, source.name, count, status === 'error' ? ' error' : '');
    }
    this.pillsEl.innerHTML = html;

    this.pillsEl.querySelectorAll<HTMLButtonElement>('.crd-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filter = btn.dataset.filter!;
        this.renderPills();
        this.renderResults();
      });
    });
  }

  // ── Results ───────────────────────────────────────────────────────────────

  /**
   * The single highest-scoring result per source, ranked by similarity to
   * the query (mirrors GridView's "Most Relevant" tab on comick).
   */
  private bestMatches(): Array<{ result: SearchResult; source: MangaSource; score: number }> {
    const all: Array<SearchResult & { __sourceId: string }> = [];
    for (const source of this.sources) {
      for (const item of this.results.get(source.id) ?? []) {
        all.push({ ...item, __sourceId: source.id });
      }
    }
    if (all.length === 0) return [];

    const scored = findBestMatchesMultiRef([this.query], all, (r) => r.title, all.length, 0);

    const bestBySource = new Map<string, { result: SearchResult; score: number }>();
    for (const { item, score } of scored) {
      const existing = bestBySource.get(item.__sourceId);
      if (!existing || score > existing.score) {
        bestBySource.set(item.__sourceId, { result: item, score });
      }
    }

    return [...bestBySource.entries()]
      .map(([sourceId, { result, score }]) => ({
        result,
        source: this.sources.find((s) => s.id === sourceId)!,
        score,
      }))
      .sort((a, b) => b.score - a.score);
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = '';

    if (this.filter === 'best') {
      this.renderBestSection(this.resultsEl);
      return;
    }
    const shown = this.sources.filter((s) => this.filter === 'all' || s.id === this.filter);
    for (const source of shown) {
      this.renderSourceSection(this.resultsEl, source);
    }
  }

  private renderBestSection(container: HTMLElement): void {
    const section = document.createElement('section');
    section.className = 'crd-search-section';
    const entries = this.bestMatches();
    const loading = this.anyLoading();

    section.innerHTML = `
      <div class="crd-search-section-head">
        <span class="crd-search-section-name">Best matches</span>
        <span class="crd-search-section-status">${loading ? 'searching…' : 'top result from each source'}</span>
      </div>
      <div class="crd-search-grid best"></div>
    `;
    const grid = section.querySelector<HTMLElement>('.crd-search-grid')!;

    for (const { result, source, score } of entries) {
      grid.appendChild(this.renderCard(result, source, { badge: true, score }));
    }
    if (loading) {
      grid.insertAdjacentHTML('beforeend', this.skeletons(Math.max(1, this.sources.length - entries.length)));
    } else if (entries.length === 0) {
      section.innerHTML = `<div class="crd-empty"><h3>No results</h3><p>Try a different title or spelling.</p></div>`;
    }
    container.appendChild(section);
  }

  private renderSourceSection(container: HTMLElement, source: MangaSource): void {
    const section = document.createElement('section');
    section.className = 'crd-search-section';
    const status = this.statuses.get(source.id);
    const items = this.results.get(source.id) ?? [];

    const statusText = status === 'loading' ? 'searching…'
      : status === 'error' ? 'failed, source may be down or rate limiting'
      : `${items.length} result${items.length === 1 ? '' : 's'}`;

    section.innerHTML = `
      <div class="crd-search-section-head">
        <span class="crd-search-section-name">${escapeHtml(source.name)}</span>
        <span class="crd-search-section-status${status === 'error' ? ' fail' : ''}">${statusText}</span>
      </div>
      <div class="crd-search-grid"></div>
    `;
    const grid = section.querySelector<HTMLElement>('.crd-search-grid')!;

    if (status === 'loading') {
      grid.innerHTML = this.skeletons(6);
    } else {
      for (const item of items) grid.appendChild(this.renderCard(item, source));
      if (status === 'done' && items.length === 0) section.classList.add('empty');
    }
    container.appendChild(section);
  }

  private skeletons(count: number): string {
    return Array.from({ length: count }, () => `
      <div class="crd-search-card skeleton">
        <div class="crd-search-cover"></div>
        <div class="crd-search-title-sk"></div>
      </div>
    `).join('');
  }

  private renderCard(item: SearchResult, source: MangaSource, opts: { badge?: boolean; score?: number } = {}): HTMLElement {
    const inLibrary = this.knownSlugs.has(standaloneSlug(source.id, item.slug));
    const card = document.createElement('button');
    card.className = 'crd-search-card';
    card.title = opts.score !== undefined ? `${item.title} (${Math.round(opts.score * 100)}% match)` : item.title;
    card.innerHTML = `
      <div class="crd-search-cover">
        <span class="crd-search-letter">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span>
        ${item.thumbnailUrl ? `<img loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(item.thumbnailUrl)}" alt="">` : ''}
        ${opts.badge ? `<span class="crd-search-src">${escapeHtml(source.name)}</span>` : ''}
        ${inLibrary ? `<span class="crd-search-owned" title="In your library"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>` : ''}
      </div>
      <div class="crd-search-title">${escapeHtml(item.title)}</div>
    `;
    const img = card.querySelector<HTMLImageElement>('img');
    img?.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img?.addEventListener('error', () => img.remove(), { once: true });
    card.addEventListener('click', () => this.openDetails(item, source));
    return card;
  }

  // ── Details modal ─────────────────────────────────────────────────────────

  private openDetails(item: SearchResult, source: MangaSource): void {
    const { overlay, close } = buildModal(escapeHtml(item.title), `
      <div class="crd-details">
        <div class="crd-details-cover">
          <span class="crd-search-letter">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span>
          ${item.thumbnailUrl ? `<img referrerpolicy="no-referrer" src="${escapeHtml(item.thumbnailUrl)}" alt="">` : ''}
        </div>
        <div class="crd-details-body">
          <div class="crd-details-meta" id="crd-det-meta">
            <span class="crd-chip builtin">${escapeHtml(source.name)}</span>
            <span class="crd-details-loading">loading details…</span>
          </div>
          <div class="crd-details-desc" id="crd-det-desc"></div>
          <div class="crd-btn-row crd-details-actions">
            <button class="crd-btn crd-btn-primary" id="crd-det-read">Start reading</button>
            <a class="crd-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open on ${escapeHtml(source.name)}</a>
          </div>
        </div>
      </div>
    `, { large: true });

    const img = overlay.querySelector<HTMLImageElement>('.crd-details-cover img');
    img?.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img?.addEventListener('error', () => img.remove(), { once: true });

    overlay.querySelector<HTMLButtonElement>('#crd-det-read')?.addEventListener('click', async () => {
      close();
      await openSearchResult(item, source.id);
      this.knownSlugs.add(standaloneSlug(source.id, item.slug));
    });

    void this.fillDetails(overlay, item, source);
  }

  private async fillDetails(overlay: HTMLElement, item: SearchResult, source: MangaSource): Promise<void> {
    const meta = overlay.querySelector<HTMLElement>('#crd-det-meta');
    const desc = overlay.querySelector<HTMLElement>('#crd-det-desc');
    try {
      const details: MangaDetails = await source.getMangaDetails(item.slug);
      if (!meta || !desc || !overlay.isConnected) return;

      const rows: string[] = [`<span class="crd-chip builtin">${escapeHtml(source.name)}</span>`];
      if (details.status) rows.push(`<span class="crd-chip">${escapeHtml(details.status)}</span>`);
      if (details.author) rows.push(`<span class="crd-details-author">${escapeHtml(details.author)}</span>`);
      meta.innerHTML = rows.join('');

      const genres = details.genres?.filter(Boolean) ?? [];
      desc.innerHTML = `
        ${genres.length ? `<div class="crd-details-genres">${genres.map((g) => `<span>${escapeHtml(g)}</span>`).join('')}</div>` : ''}
        <p>${escapeHtml(details.description || 'No description available.')}</p>
      `;

      // Better cover from details when the search thumbnail was missing
      if (details.thumbnailUrl && !overlay.querySelector('.crd-details-cover img')) {
        const coverEl = overlay.querySelector('.crd-details-cover');
        const img = document.createElement('img');
        img.referrerPolicy = 'no-referrer';
        img.src = details.thumbnailUrl;
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        coverEl?.appendChild(img);
      }
    } catch (error) {
      if (meta) meta.innerHTML = `<span class="crd-chip builtin">${escapeHtml(source.name)}</span><span class="crd-details-loading">details unavailable: ${escapeHtml((error as Error).message.slice(0, 60))}</span>`;
    }
  }
}
