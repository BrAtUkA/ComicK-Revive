import { SearchResult } from '@/types';
import { sourceRegistry } from '@/sources';
import { findBestMatchesMultiRef } from '@/utils/fuzzy-match';

export interface GridViewHost {
  readonly container: HTMLElement | null;
  readonly currentSourceId: string;
  readonly chapterCountCache: Map<string, number>;
  getSearchResults(): SearchResult[];
  getSearchSessionId(): number;
  isSearchAllRunning(): boolean;
  getCurrentProgress(): { phase: number; titleIndex: number; totalTitles: number; currentTitle: string };
  escapeHtml(text: string): string;
  getThumbnailSrc(url: string): string;
  getSourceNameById(id: string): string;
  renderResults(): void;
  renderResultsWithProgress(container: HTMLElement, phase: number, titleIndex: number, totalTitles: number, currentTitle: string): void;
  renderSourceBadges(): string;
  onStopSearch(): void;
  onSkipToManual(): void;
  proxyThumbnails(container: HTMLElement): void;
  proxyThumbnailsForElement(card: HTMLElement): void;
  loadChapterCounts(container: HTMLElement): void;
  loadChapterCountForCard(card: HTMLElement): void;
  attachContextMenuHandlers(container: HTMLElement): void;
  showDetailsPanel(result: SearchResult): Promise<void>;
  getReferenceTitles(): string[];
}

/**
 * GridView - Fullscreen grid display of search results grouped by source.
 * Supports incremental updates during progressive search, source filtering,
 * and chapter count badges.
 */
export class GridView {
  public isFullscreen: boolean = false;
  public activeSourceFilter: string | null = null;
  public lastRenderedGridCount: number = 0;

  // Progress state for grid-mode search tracking
  private progressPhase: number = 0;
  private progressTitleIndex: number = 0;
  private progressTotalTitles: number = 0;
  private progressCurrentTitle: string = '';

  constructor(private host: GridViewHost) {}

  /**
   * Reset grid state to defaults.
   */
  reset(): void {
    this.isFullscreen = false;
    this.activeSourceFilter = null;
    this.lastRenderedGridCount = 0;
    this.progressPhase = 0;
    this.progressTitleIndex = 0;
    this.progressTotalTitles = 0;
    this.progressCurrentTitle = '';
    this.barHoverWired = false;
    this.cancelHide();
    this.removeHeaderBackButton();
    this.hideHeaderProgress();
  }

  /**
   * Update progress state and refresh the grid progress bar DOM in-place.
   * Called by SearchOrchestrator after each title batch while in grid mode.
   */
  updateProgress(phase: number, titleIndex: number, totalTitles: number, currentTitle: string): void {
    this.progressPhase = phase;
    this.progressTitleIndex = titleIndex;
    this.progressTotalTitles = totalTitles;
    this.progressCurrentTitle = currentTitle;
    this.updateProgressDOM();
  }

  /**
   * Compute progress percentage from current progress state.
   */
  private getProgressPercent(): number {
    const basePercent = this.progressPhase === 1 ? 0 : 50;
    const phaseWeight = 50;
    const phasePercent = this.progressTotalTitles > 0
      ? ((this.progressTitleIndex + 1) / this.progressTotalTitles) * phaseWeight
      : phaseWeight;
    return basePercent + phasePercent;
  }

  /**
   * Show the thin header progress bar and set up hover tooltip.
   */
  private showHeaderProgress(): void {
    const bar = document.getElementById('cr-grid-header-bar');
    const fill = document.getElementById('cr-grid-header-bar-fill');
    if (!bar || !fill) return;

    bar.classList.remove('hidden');
    fill.style.width = `${this.getProgressPercent()}%`;
    this.updateHeaderTooltip();
    this.wireBarHoverHandlers(bar);
  }

  /**
   * Hide the thin header progress bar and tooltip.
   */
  private hideHeaderProgress(): void {
    const bar = document.getElementById('cr-grid-header-bar');
    if (bar) bar.classList.add('hidden');
    const tooltip = document.getElementById('cr-grid-header-tooltip');
    if (tooltip) this.dismissTooltip(tooltip);
  }

  // Tooltip hover state
  private barHoverWired = false;
  private showTimeout: ReturnType<typeof setTimeout> | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;
  private proximityHandler: ((e: MouseEvent) => void) | null = null;

  private static readonly SHOW_DELAY = 350;
  private static readonly HIDE_DELAY = 1500;
  private static readonly BUFFER_PX = 20;

  /**
   * Wire hover handlers on the progress bar for tooltip behavior.
   * - Shows instantly on mouseenter, follows cursor along the bar
   * - On mouseleave, stays visible for 1.5s (relaxed hide)
   * - Stays open while cursor is on the tooltip or within 20px buffer of tooltip/bar
   * - Buttons inside the tooltip are fully interactive
   */
  private wireBarHoverHandlers(bar: HTMLElement): void {
    if (this.barHoverWired) return;
    this.barHoverWired = true;

    const tooltip = document.getElementById('cr-grid-header-tooltip');
    if (!tooltip) return;

    bar.addEventListener('mouseenter', (e: MouseEvent) => {
      this.cancelHide();
      this.positionTooltip(tooltip, e);
      this.showTimeout = setTimeout(() => {
        tooltip.classList.add('visible');
        this.showTimeout = null;
      }, GridView.SHOW_DELAY);
    });

    bar.addEventListener('mousemove', (e: MouseEvent) => {
      // Don't reposition while cursor is over the tooltip (DOM child of bar)
      if (!tooltip.contains(e.target as Node)) {
        this.positionTooltip(tooltip, e);
      }
    });

    bar.addEventListener('mouseleave', () => {
      if (this.showTimeout) { clearTimeout(this.showTimeout); this.showTimeout = null; }
      if (tooltip.classList.contains('visible')) {
        this.scheduleHide(tooltip, bar);
      }
    });

    tooltip.addEventListener('mouseenter', () => {
      this.cancelHide();
    });

    tooltip.addEventListener('mouseleave', () => {
      this.scheduleHide(tooltip, bar);
    });
  }

  /**
   * Schedule tooltip dismissal with proximity tracking.
   * The tooltip hides after HIDE_DELAY unless the cursor stays within
   * BUFFER_PX of the tooltip or bar, in which case the timer resets.
   */
  private scheduleHide(tooltip: HTMLElement, bar: HTMLElement): void {
    this.cancelHide();

    this.proximityHandler = (e: MouseEvent) => {
      if (this.isNear(e, tooltip) || this.isNear(e, bar)) {
        // Cursor still in proximity — keep resetting the timer
        if (this.hideTimeout) { clearTimeout(this.hideTimeout); }
        this.hideTimeout = setTimeout(() => this.dismissTooltip(tooltip), GridView.HIDE_DELAY);
      }
    };
    document.addEventListener('mousemove', this.proximityHandler);

    this.hideTimeout = setTimeout(() => this.dismissTooltip(tooltip), GridView.HIDE_DELAY);
  }

  private isNear(e: MouseEvent, el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const b = GridView.BUFFER_PX;
    return e.clientX >= r.left - b && e.clientX <= r.right + b &&
           e.clientY >= r.top - b && e.clientY <= r.bottom + b;
  }

  private dismissTooltip(tooltip: HTMLElement): void {
    tooltip.classList.remove('visible');
    this.cancelHide();
  }

  private cancelHide(): void {
    if (this.showTimeout) { clearTimeout(this.showTimeout); this.showTimeout = null; }
    if (this.hideTimeout) { clearTimeout(this.hideTimeout); this.hideTimeout = null; }
    if (this.proximityHandler) {
      document.removeEventListener('mousemove', this.proximityHandler);
      this.proximityHandler = null;
    }
  }

  /**
   * Position tooltip below the bar, following cursor horizontally only.
   * Y is anchored to the bar's bottom edge so the tooltip never runs away vertically.
   */
  private positionTooltip(tooltip: HTMLElement, e: MouseEvent): void {
    const bar = document.getElementById('cr-grid-header-bar');
    const anchorY = bar ? bar.getBoundingClientRect().bottom + 6 : e.clientY + 12;
    tooltip.style.left = `${e.clientX}px`;
    tooltip.style.top = `${anchorY}px`;
    tooltip.style.transform = 'translateX(-50%)';
  }

  /**
   * Update the tooltip content for the header progress bar.
   */
  private updateHeaderTooltip(): void {
    const tooltip = document.getElementById('cr-grid-header-tooltip');
    if (!tooltip) return;

    const sourceBadgesHtml = this.host.renderSourceBadges();
    const titleText = this.progressTotalTitles > 0
      ? `${this.progressTitleIndex + 1}/${this.progressTotalTitles}: "${this.host.escapeHtml(this.progressCurrentTitle)}"`
      : 'Preparing...';

    tooltip.innerHTML = `
      <div class="cr-grid-tooltip-row">
        <div class="cr-progress-icon"></div>
        <span class="cr-source-badges-group">${sourceBadgesHtml}</span>
      </div>
      <div class="cr-grid-tooltip-title">${titleText}</div>
      <div class="cr-grid-tooltip-actions">
        <button class="cr-stop-inline-btn" id="cr-grid-stop-search">Stop</button>
      </div>
    `;

    this.wireProgressHandlers();
  }

  /**
   * Wire stop/skip button handlers on the grid progress element.
   */
  private wireProgressHandlers(): void {
    document.getElementById('cr-grid-stop-search')?.addEventListener('click', () => {
      this.host.onStopSearch();
    });
  }

  /**
   * Update the header progress bar DOM in-place without rebuilding the grid.
   */
  private updateProgressDOM(): void {
    const fill = document.getElementById('cr-grid-header-bar-fill');
    if (fill) fill.style.width = `${this.getProgressPercent()}%`;
    this.updateHeaderTooltip();
  }

  /**
   * Group search results by sourceId, optionally filtering to the active source.
   */
  getResultsGroupedBySource(): Map<string, SearchResult[]> {
    const groups = new Map<string, SearchResult[]>();
    const filtered = this.activeSourceFilter
      ? this.host.getSearchResults().filter(r => (r.sourceId || this.host.currentSourceId) === this.activeSourceFilter)
      : this.host.getSearchResults();

    for (const result of filtered) {
      const sourceId = result.sourceId || this.host.currentSourceId;
      if (!groups.has(sourceId)) {
        groups.set(sourceId, []);
      }
      groups.get(sourceId)!.push(result);
    }
    return groups;
  }

  /**
   * Toggle between fullscreen grid view and normal list view.
   */
  toggleFullscreen(enter: boolean): void {
    const modal = this.host.container?.querySelector('.cr-modal');
    if (!modal) return;

    this.isFullscreen = enter;
    this.activeSourceFilter = null;
    this.lastRenderedGridCount = 0;

    // Remove the expand button (it lives outside the results container)
    document.getElementById('cr-expand-fullscreen')?.remove();

    if (enter) {
      modal.classList.add('cr-fullscreen');
      // Hide the progress island (it's for list view only)
      const island = document.getElementById('cr-progress-island');
      if (island) {
        island.classList.add('hidden');
        island.innerHTML = '';
      }
      // Seed grid progress from the orchestrator's current state so the bar
      // shows the correct position immediately (no jump to 0 then catch-up)
      if (this.host.isSearchAllRunning()) {
        const p = this.host.getCurrentProgress();
        this.progressPhase = p.phase;
        this.progressTitleIndex = p.titleIndex;
        this.progressTotalTitles = p.totalTitles;
        this.progressCurrentTitle = p.currentTitle;
      }
      this.renderGridResults();
    } else {
      modal.classList.remove('cr-fullscreen');
      this.removeHeaderBackButton();
      this.hideHeaderProgress();
      this.barHoverWired = false;

      // If search is still running, restore the progress view instead of the
      // "final" view (which would flash the failures warning prematurely).
      if (this.host.isSearchAllRunning()) {
        const resultsContainer = document.getElementById('cr-match-results');
        if (resultsContainer) {
          const p = this.host.getCurrentProgress();
          this.host.renderResultsWithProgress(resultsContainer, p.phase, p.titleIndex, p.totalTitles, p.currentTitle);
        }
      } else {
        this.host.renderResults();
      }
    }
  }

  /**
   * Add a back-arrow button to the left of the modal header title.
   */
  private addHeaderBackButton(): void {
    // Don't add duplicates
    if (document.getElementById('cr-grid-back-btn')) return;

    const header = this.host.container?.querySelector('.cr-modal-header');
    const h3 = header?.querySelector('h3');
    if (!header || !h3) return;

    const btn = document.createElement('button');
    btn.className = 'cr-grid-back-btn';
    btn.id = 'cr-grid-back-btn';
    btn.title = 'Back to List';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
      </svg>
    `;
    btn.addEventListener('click', () => {
      this.toggleFullscreen(false);
    });

    header.insertBefore(btn, h3);
  }

  /**
   * Remove the back-arrow button from the modal header.
   */
  private removeHeaderBackButton(): void {
    document.getElementById('cr-grid-back-btn')?.remove();
  }

  /**
   * Create a single grid card DOM element for a search result.
   */
  createGridCardElement(result: SearchResult, globalIndex: number): HTMLElement {
    const sourceId = result.sourceId || this.host.currentSourceId;
    const cacheKey = `${sourceId}:${result.slug}`;
    const cachedCount = this.host.chapterCountCache.get(cacheKey);

    const card = document.createElement('div');
    card.className = 'cr-grid-card' + (cachedCount === 0 ? ' cr-no-chapters' : '');
    card.dataset.index = String(globalIndex);
    card.dataset.slug = result.slug;
    card.dataset.sourceId = sourceId;

    const countHtml = cachedCount !== undefined
      ? `<span class="cr-chapter-count">${cachedCount} ch.</span>`
      : '<span class="cr-chapter-count-loading"><span class="cr-count-spinner"></span></span>';

    card.innerHTML = `
      <div class="cr-grid-card-thumb-container">
        <img
          src="${this.host.getThumbnailSrc(result.thumbnailUrl)}"
          data-original-url="${result.thumbnailUrl}"
          alt="${this.host.escapeHtml(result.title)}"
          class="cr-grid-card-thumb"
          onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
        >
      </div>
      <div class="cr-grid-card-body">
        <span class="cr-grid-card-title">${this.host.escapeHtml(result.title)}</span>
        <span class="cr-grid-card-meta">
          ${countHtml}
        </span>
      </div>
    `;

    card.addEventListener('click', () => {
      this.host.showDetailsPanel(result);
    });

    return card;
  }

  /**
   * Get the single most-relevant result from each source, sorted by score descending.
   */
  private getMostRelevantResults(): { result: SearchResult; sourceId: string; score: number }[] {
    const refs = this.host.getReferenceTitles();
    if (refs.length === 0) return [];

    const results = this.host.getSearchResults();
    if (results.length === 0) return [];

    const scored = findBestMatchesMultiRef(
      refs, results, (r) => r.title, results.length, 0
    );

    const bestBySource = new Map<string, { result: SearchResult; score: number }>();
    for (const { item, score } of scored) {
      const sourceId = item.sourceId || this.host.currentSourceId;
      const existing = bestBySource.get(sourceId);
      if (!existing || score > existing.score) {
        bestBySource.set(sourceId, { result: item, score });
      }
    }

    return [...bestBySource.entries()]
      .map(([sourceId, { result, score }]) => ({ result, sourceId, score }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Build inner HTML for the "Most Relevant" tab.
   * One card per source, bigger cards, source badge on each card.
   */
  private renderRelevantCardsHtml(): string {
    const entries = this.getMostRelevantResults();
    if (entries.length === 0) {
      return '<div class="cr-grid-relevant-empty">No results yet...</div>';
    }

    const cardsHtml = entries.map(({ result, sourceId }) => {
      const globalIndex = this.host.getSearchResults().indexOf(result);
      const cacheKey = `${sourceId}:${result.slug}`;
      const cachedCount = this.host.chapterCountCache.get(cacheKey);
      const countHtml = cachedCount !== undefined
        ? `<span class="cr-chapter-count">${cachedCount} ch.</span>`
        : '<span class="cr-chapter-count-loading"><span class="cr-count-spinner"></span></span>';
      const sourceName = this.host.getSourceNameById(sourceId);

      return `
        <div class="cr-grid-card cr-grid-card-relevant${cachedCount === 0 ? ' cr-no-chapters' : ''}"
             data-index="${globalIndex}" data-slug="${result.slug}" data-source-id="${sourceId}">
          <div class="cr-grid-card-thumb-container">
            <img
              src="${this.host.getThumbnailSrc(result.thumbnailUrl)}"
              data-original-url="${result.thumbnailUrl}"
              alt="${this.host.escapeHtml(result.title)}"
              class="cr-grid-card-thumb"
              onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
            >
          </div>
          <div class="cr-grid-card-body">
            <span class="cr-grid-card-title">${this.host.escapeHtml(result.title)}</span>
            <span class="cr-grid-card-meta">
              <span class="cr-source-badge">${sourceName}</span>
              ${countHtml}
            </span>
          </div>
        </div>
      `;
    }).join('');

    return `<div class="cr-grid-cards cr-grid-cards-relevant">${cardsHtml}</div>`;
  }

  /**
   * Render the fullscreen grid view with results grouped by source.
   * Uses incremental DOM updates during progressive search to avoid scroll jumping.
   */
  renderGridResults(): void {
    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    // If grid skeleton already exists and was rendered, always use incremental path.
    // The incremental method safely no-ops when no new results exist, avoiding
    // full innerHTML rebuilds that destroy scroll position and loaded thumbnails.
    // Full rebuild only happens on first paint (lastRenderedGridCount === 0).
    const gridView = resultsContainer.querySelector('.cr-grid-view');
    if (gridView && this.lastRenderedGridCount > 0) {
      this.updateGridResultsIncremental(resultsContainer);
      return;
    }

    // Full rebuild
    const isRelevant = this.activeSourceFilter === 'relevant';
    const groups: Map<string, SearchResult[]> = isRelevant ? new Map() : this.getResultsGroupedBySource();
    const allSources = sourceRegistry.getAll();

    // Count results per source (unfiltered) for filter bar
    const sourceCounts = new Map<string, number>();
    for (const result of this.host.getSearchResults()) {
      const sid = result.sourceId || this.host.currentSourceId;
      sourceCounts.set(sid, (sourceCounts.get(sid) || 0) + 1);
    }

    // Filter bar — only show if multiple sources have results
    const sourcesWithResults = allSources.filter(s => sourceCounts.has(s.id));
    const showFilterBar = sourcesWithResults.length > 1;

    const filterBarHtml = showFilterBar ? `
      <div class="cr-grid-filter-bar">
        <button class="cr-grid-filter-btn${isRelevant ? ' active' : ''}" data-source="relevant">
          Most Relevant
        </button>
        <button class="cr-grid-filter-btn${!this.activeSourceFilter ? ' active' : ''}" data-source="all">
          All (${this.host.getSearchResults().length})
        </button>
        ${sourcesWithResults.map(s => `
          <button class="cr-grid-filter-btn ${this.activeSourceFilter === s.id ? 'active' : ''}" data-source="${s.id}">
            ${s.name} (${sourceCounts.get(s.id) || 0})
          </button>
        `).join('')}
      </div>
    ` : '';

    // Grid groups (only built when not in "relevant" mode)
    let groupsHtml = '';
    if (!isRelevant) {
      for (const [sourceId, results] of groups) {
        const sourceName = this.host.getSourceNameById(sourceId);
        groupsHtml += `
          <div class="cr-grid-group" data-source="${sourceId}">
            <h4 class="cr-grid-group-header">
              <span class="cr-grid-group-name">${sourceName}</span>
              <span class="cr-grid-group-count">${results.length} result${results.length !== 1 ? 's' : ''}</span>
            </h4>
            <div class="cr-grid-cards">
              ${results.map(result => {
                const globalIndex = this.host.getSearchResults().indexOf(result);
                const cacheKey = `${sourceId}:${result.slug}`;
                const cachedCount = this.host.chapterCountCache.get(cacheKey);
                const countHtml = cachedCount !== undefined
                  ? `<span class="cr-chapter-count">${cachedCount} ch.</span>`
                  : '<span class="cr-chapter-count-loading"><span class="cr-count-spinner"></span></span>';
                return `
                  <div class="cr-grid-card${cachedCount === 0 ? ' cr-no-chapters' : ''}" data-index="${globalIndex}" data-slug="${result.slug}" data-source-id="${sourceId}">
                    <div class="cr-grid-card-thumb-container">
                      <img
                        src="${this.host.getThumbnailSrc(result.thumbnailUrl)}"
                        data-original-url="${result.thumbnailUrl}"
                        alt="${this.host.escapeHtml(result.title)}"
                        class="cr-grid-card-thumb"
                        onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
                      >
                    </div>
                    <div class="cr-grid-card-body">
                      <span class="cr-grid-card-title">${this.host.escapeHtml(result.title)}</span>
                      <span class="cr-grid-card-meta">
                        ${countHtml}
                      </span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }
    }

    // Content area depends on active filter
    const contentHtml = isRelevant
      ? this.renderRelevantCardsHtml()
      : `<div class="cr-grid-groups">${groupsHtml}</div>`;

    resultsContainer.innerHTML = `
      <div class="cr-grid-view">
        ${filterBarHtml}
        ${contentHtml}
      </div>
    `;

    // Show header progress bar if search is running
    if (this.host.isSearchAllRunning()) {
      this.showHeaderProgress();
    }

    // Add back-arrow button to the modal header
    this.addHeaderBackButton();

    // Wire filter bar
    resultsContainer.querySelectorAll('.cr-grid-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const source = (btn as HTMLElement).dataset.source;
        this.setSourceFilter(source === 'all' ? null : source || null);
      });
    });

    // Wire grid card clicks → open details (use slug+sourceId for stable lookup)
    resultsContainer.querySelectorAll('.cr-grid-card').forEach(card => {
      card.addEventListener('click', () => {
        const el = card as HTMLElement;
        const slug = el.dataset.slug;
        const sid = el.dataset.sourceId;
        const result = this.host.getSearchResults().find(
          r => r.slug === slug && (r.sourceId || this.host.currentSourceId) === sid
        );
        if (result) this.host.showDetailsPanel(result);
      });
    });

    // Proxy thumbnails and load chapter counts (reuses existing methods)
    this.host.proxyThumbnails(resultsContainer);
    this.host.loadChapterCounts(resultsContainer);
    this.host.attachContextMenuHandlers(resultsContainer);
    this.lastRenderedGridCount = this.host.getSearchResults().length;
  }

  /**
   * Incrementally update the grid with only new results.
   * Appends new cards to existing groups or creates new group sections.
   * Does not touch existing cards — preserves scroll position and loaded thumbnails.
   */
  updateGridResultsIncremental(resultsContainer: HTMLElement): void {
    // Branch: relevant tab uses a simpler update path
    if (this.activeSourceFilter === 'relevant') {
      this.updateRelevantTabIncremental(resultsContainer);
      return;
    }

    const groupsContainer = resultsContainer.querySelector('.cr-grid-groups');
    if (!groupsContainer) return;

    // Build set of already-rendered card keys from the DOM
    const renderedKeys = new Set<string>();
    resultsContainer.querySelectorAll<HTMLElement>('.cr-grid-card').forEach(card => {
      const slug = card.dataset.slug;
      const sid = card.dataset.sourceId;
      if (slug && sid) renderedKeys.add(`${sid}:${slug}`);
    });

    // Find results that are not yet rendered
    const filtered = this.activeSourceFilter
      ? this.host.getSearchResults().filter(r => (r.sourceId || this.host.currentSourceId) === this.activeSourceFilter)
      : this.host.getSearchResults();

    const newBySource = new Map<string, SearchResult[]>();
    for (const result of filtered) {
      const sourceId = result.sourceId || this.host.currentSourceId;
      const key = `${sourceId}:${result.slug}`;
      if (renderedKeys.has(key)) continue;
      if (!newBySource.has(sourceId)) newBySource.set(sourceId, []);
      newBySource.get(sourceId)!.push(result);
    }

    if (newBySource.size === 0) {
      this.lastRenderedGridCount = this.host.getSearchResults().length;
      return;
    }

    const newCardElements: HTMLElement[] = [];
    let newCardIndex = 0;

    for (const [sourceId, results] of newBySource) {
      let groupEl = groupsContainer.querySelector<HTMLElement>(`.cr-grid-group[data-source="${sourceId}"]`);

      if (groupEl) {
        // Existing group — append new cards to its grid
        const cardsContainer = groupEl.querySelector('.cr-grid-cards');
        if (!cardsContainer) continue;

        for (const result of results) {
          const globalIndex = this.host.getSearchResults().indexOf(result);
          const card = this.createGridCardElement(result, globalIndex);
          card.style.animation = `cr-card-enter 0.25s ease-out ${newCardIndex * 50}ms both`;
          cardsContainer.appendChild(card);
          newCardElements.push(card);
          newCardIndex++;
        }

        // Update group count in header
        const totalInGroup = cardsContainer.querySelectorAll('.cr-grid-card').length;
        const countEl = groupEl.querySelector('.cr-grid-group-count');
        if (countEl) countEl.textContent = `${totalInGroup} result${totalInGroup !== 1 ? 's' : ''}`;
      } else {
        // New group — create the whole section
        const sourceName = this.host.getSourceNameById(sourceId);
        groupEl = document.createElement('div');
        groupEl.className = 'cr-grid-group';
        groupEl.dataset.source = sourceId;
        groupEl.innerHTML = `
          <h4 class="cr-grid-group-header">
            <span class="cr-grid-group-name">${sourceName}</span>
            <span class="cr-grid-group-count">${results.length} result${results.length !== 1 ? 's' : ''}</span>
          </h4>
          <div class="cr-grid-cards"></div>
        `;

        const cardsContainer = groupEl.querySelector('.cr-grid-cards')!;
        for (const result of results) {
          const globalIndex = this.host.getSearchResults().indexOf(result);
          const card = this.createGridCardElement(result, globalIndex);
          card.style.animation = `cr-card-enter 0.25s ease-out ${newCardIndex * 50}ms both`;
          cardsContainer.appendChild(card);
          newCardElements.push(card);
          newCardIndex++;
        }

        // Insert new group at the end of the groups container
        groupsContainer.appendChild(groupEl);
      }
    }

    // Update filter bar counts
    this.updateGridFilterCounts();

    // Update header progress bar
    if (this.host.isSearchAllRunning()) {
      this.showHeaderProgress();
    } else {
      this.hideHeaderProgress();
    }

    // Only proxy/load chapter counts for the NEW cards
    for (const card of newCardElements) {
      this.host.proxyThumbnailsForElement(card);
      this.host.loadChapterCountForCard(card);
    }

    // Re-attach context menu handlers (event delegation, so this is cheap)
    this.host.attachContextMenuHandlers(resultsContainer);

    this.lastRenderedGridCount = this.host.getSearchResults().length;
  }

  /**
   * Incrementally update the "Most Relevant" tab.
   * Since it shows only 1 card per source, rebuild the cards container
   * when new sources appear. This is cheap (few cards).
   */
  private updateRelevantTabIncremental(resultsContainer: HTMLElement): void {
    const cardsContainer = resultsContainer.querySelector('.cr-grid-cards-relevant');

    // Check if any new source appeared that isn't already rendered
    const existingSources = new Set<string>();
    if (cardsContainer) {
      cardsContainer.querySelectorAll<HTMLElement>('.cr-grid-card').forEach(card => {
        if (card.dataset.sourceId) existingSources.add(card.dataset.sourceId);
      });
    }

    const entries = this.getMostRelevantResults();
    let hasNewSource = false;
    for (const { sourceId } of entries) {
      if (!existingSources.has(sourceId)) {
        hasNewSource = true;
        break;
      }
    }

    // Update tab bar count
    this.updateGridFilterCounts();

    // Update progress bar
    if (this.host.isSearchAllRunning()) {
      this.showHeaderProgress();
    } else {
      this.hideHeaderProgress();
    }

    if (!hasNewSource && cardsContainer) {
      this.lastRenderedGridCount = this.host.getSearchResults().length;
      return;
    }

    // New source appeared (or no cards yet) — rebuild relevant cards
    const newHtml = this.renderRelevantCardsHtml();
    const gridView = resultsContainer.querySelector('.cr-grid-view');
    if (!gridView) return;

    // Replace old cards container or empty state with new one
    const oldContent = cardsContainer
      || resultsContainer.querySelector('.cr-grid-relevant-empty');
    const temp = document.createElement('div');
    temp.innerHTML = newHtml;
    const newContainer = temp.firstElementChild as HTMLElement;
    if (newContainer) {
      if (oldContent) {
        oldContent.replaceWith(newContainer);
      } else {
        gridView.appendChild(newContainer);
      }

      // Wire click handlers and load thumbnails for new cards
      newContainer.querySelectorAll<HTMLElement>('.cr-grid-card').forEach(card => {
        this.host.proxyThumbnailsForElement(card);
        this.host.loadChapterCountForCard(card);
        card.addEventListener('click', () => {
          const slug = card.dataset.slug;
          const sid = card.dataset.sourceId;
          const result = this.host.getSearchResults().find(
            r => r.slug === slug && (r.sourceId || this.host.currentSourceId) === sid
          );
          if (result) this.host.showDetailsPanel(result);
        });
      });
      this.host.attachContextMenuHandlers(resultsContainer);
    }

    this.lastRenderedGridCount = this.host.getSearchResults().length;
  }

  /**
   * Update the filter bar button counts without rebuilding the bar.
   */
  updateGridFilterCounts(): void {
    const filterBar = document.querySelector('.cr-grid-filter-bar');
    if (!filterBar) return;

    const sourceCounts = new Map<string, number>();
    for (const result of this.host.getSearchResults()) {
      const sid = result.sourceId || this.host.currentSourceId;
      sourceCounts.set(sid, (sourceCounts.get(sid) || 0) + 1);
    }

    // Update "All" button
    const allBtn = filterBar.querySelector<HTMLElement>('.cr-grid-filter-btn[data-source="all"]');
    if (allBtn) allBtn.textContent = `All (${this.host.getSearchResults().length})`;

    // Update per-source buttons
    for (const [sourceId, count] of sourceCounts) {
      const btn = filterBar.querySelector<HTMLElement>(`.cr-grid-filter-btn[data-source="${sourceId}"]`);
      if (btn) {
        const sourceName = this.host.getSourceNameById(sourceId);
        btn.textContent = `${sourceName} (${count})`;
      }
    }

    // Add buttons for any new sources that appeared
    const allSources = sourceRegistry.getAll();
    const sourcesWithResults = allSources.filter(s => sourceCounts.has(s.id));
    if (sourcesWithResults.length > 1 && !allBtn) {
      // Filter bar didn't exist before (was single source) — need full rebuild for it
      const groupsEl = document.querySelector('.cr-grid-groups');
      const scrollTop = groupsEl?.scrollTop ?? 0;
      this.lastRenderedGridCount = 0;
      this.renderGridResults();
      const newGroupsEl = document.querySelector('.cr-grid-groups');
      if (newGroupsEl) newGroupsEl.scrollTop = scrollTop;
      return;
    }

    for (const source of sourcesWithResults) {
      if (!filterBar.querySelector(`.cr-grid-filter-btn[data-source="${source.id}"]`)) {
        const btn = document.createElement('button');
        btn.className = 'cr-grid-filter-btn';
        btn.dataset.source = source.id;
        btn.textContent = `${source.name} (${sourceCounts.get(source.id) || 0})`;
        btn.addEventListener('click', () => {
          this.setSourceFilter(source.id);
        });
        filterBar.appendChild(btn);
      }
    }
  }

  /**
   * Set source filter and re-render grid without re-entering fullscreen.
   * Preserves scroll position within the grid.
   */
  setSourceFilter(sourceId: string | null): void {
    this.activeSourceFilter = sourceId;

    // Preserve scroll position across the full rebuild
    const groupsEl = document.querySelector('.cr-grid-groups');
    const scrollTop = groupsEl?.scrollTop ?? 0;

    this.lastRenderedGridCount = 0;
    this.renderGridResults();

    // Restore scroll position
    const newGroupsEl = document.querySelector('.cr-grid-groups');
    if (newGroupsEl) newGroupsEl.scrollTop = scrollTop;
  }

  /**
   * Finalize search completion: remove progress indicator without a full rebuild.
   * Called by SearchOrchestrator at the end of searchAll() instead of resetting
   * lastRenderedGridCount to 0 and doing a full innerHTML replacement.
   */
  finalizeSearch(): void {
    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    // Hide the header progress bar
    this.hideHeaderProgress();

    // Update filter bar counts
    this.updateGridFilterCounts();
  }

  /**
   * Show or hide the "View as Grid" button below the results container.
   * Placed as a sibling of #cr-match-results inside .cr-modal-body
   * so it stays visible outside the scrollable results area.
   */
  updateExpandButton(): void {
    // Remove any existing button
    const existing = document.getElementById('cr-expand-fullscreen');
    if (existing) existing.remove();

    // Don't show if already fullscreen, or too few results
    if (this.isFullscreen || this.host.getSearchResults().length <= 4) return;

    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer?.parentElement) return;

    const btn = document.createElement('button');
    btn.className = 'cr-expand-btn';
    btn.id = 'cr-expand-fullscreen';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
      </svg>
      View as Grid
    `;
    btn.addEventListener('click', () => {
      this.toggleFullscreen(true);
    });

    // Insert after the results container
    resultsContainer.parentElement.insertBefore(btn, resultsContainer.nextSibling);
  }
}
