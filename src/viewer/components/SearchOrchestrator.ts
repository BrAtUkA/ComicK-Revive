import { SearchResult, ComickPageData } from '@/types';
import { sourceRegistry } from '@/sources';
import type { AsuraScans } from '@/sources';
import type { MangaKatana } from '@/sources';
import { findBestMatchesMultiRef, hasSpecialChars } from '@/utils';

export interface SearchOrchestratorHost {
  readonly currentSourceId: string;
  readonly forcedSourceId: string | null;
  readonly pageData: ComickPageData | null;
  getAlternateTitles(): string[];
  getBestTitleIndex(): number;
  isFullscreen(): boolean;
  getGridView(): { isFullscreen: boolean; lastRenderedGridCount: number; renderGridResults(): void; finalizeSearch(): void; updateProgress(phase: number, titleIndex: number, totalTitles: number, currentTitle: string): void };
  getSourceInstance(): AsuraScans | MangaKatana | null;
  getSourceInstanceById(id: string): AsuraScans | MangaKatana | null;
  abortAllSources(): void;
  getSourceName(): string;
  getSourceNameById(id: string): string;
  getOrderedTitles(): Array<{ title: string; index: number; isBest: boolean }>;
  escapeHtml(text: string): string;
  getThumbnailSrc(url: string): string;
  renderSourceBadges(): string;
  clearThumbnailCache(): void;
  renderResults(): void;
  renderResultsWithProgress(container: HTMLElement, phase: number, titleIndex: number, totalTitles: number, currentTitle: string): void;
  showError(container: HTMLElement, type: string, message: string, showManualOption?: boolean): void;
  showManualMode(): void;
  updateExpandButton(): void;
  updateLiveFailureCounter(container: HTMLElement): void;
  proxyThumbnails(container: HTMLElement): void;
  loadChapterCounts(container: HTMLElement): void;
  attachContextMenuHandlers(container: HTMLElement): void;
  selectResult(result: SearchResult): Promise<void>;
  getChapterCount(sourceId: string, slug: string): number | undefined;
}

/**
 * SearchOrchestrator — owns all search state and orchestration logic.
 *
 * Extracted from SourceMatchModal to isolate search concerns.
 * Communicates back to the modal via the SearchOrchestratorHost interface.
 */
export class SearchOrchestrator {
  // Public state owned by the orchestrator
  public isSearching: boolean = false;
  public isSearchAllRunning: boolean = false;
  public searchAllAborted: boolean = false;
  public manualSearchAborted: boolean = false;
  public searchResults: SearchResult[] = [];
  public failedTitles: Map<string, { error: string; attempts: number }> = new Map();
  public searchSessionId: number = 0;

  // Current progress state — persists across list/grid view switches
  public currentProgress = { phase: 0, titleIndex: 0, totalTitles: 0, currentTitle: '' };

  private readonly RETRY_DELAYS = [500, 1000, 2000]; // Exponential backoff: 500ms, 1s, 2s

  constructor(private readonly host: SearchOrchestratorHost) {}

  /**
   * Reset all search state to initial values.
   */
  reset(): void {
    this.isSearching = false;
    this.isSearchAllRunning = false;
    this.searchResults = [];
    this.failedTitles = new Map();
    this.manualSearchAborted = false;
    this.currentProgress = { phase: 0, titleIndex: 0, totalTitles: 0, currentTitle: '' };
  }

  /**
   * Abort any running search.
   */
  abort(): void {
    this.searchAllAborted = true;
  }

  /**
   * Re-sort searchResults using current chapter count cache data.
   * Called after chapter counts load to fix ordering.
   */
  resortResults(): void {
    const refs = this.getAllReferenceTitles();
    if (refs.length === 0 || this.searchResults.length <= 1) return;

    const matches = findBestMatchesMultiRef(
      refs,
      this.searchResults,
      (r) => r.title,
      50,
      0
    );
    this.searchResults = this.sortWithChapterTiebreak(matches);
  }

  /**
   * Sort searchResults by title similarity only (no chapter count tiebreaker).
   * Used by renderResults() to establish the "before" state for FLIP animation.
   * After chapter counts load, resortResults() applies the tiebreaker and
   * reorderResultItems() animates the transition.
   */
  sortTitleOnly(): void {
    const refs = this.getAllReferenceTitles();
    if (refs.length === 0 || this.searchResults.length <= 1) return;

    const matches = findBestMatchesMultiRef(
      refs,
      this.searchResults,
      (r) => r.title,
      50,
      0
    );
    this.searchResults = matches.map(m => m.item);
  }

  /**
   * Centralized stop for searchAll() — sets all flags, aborts sources,
   * increments sessionId to invalidate any in-flight continuations.
   */
  stopSearchAll(): void {
    this.searchAllAborted = true;
    this.searchSessionId++;
    this.host.abortAllSources();
    this.isSearchAllRunning = false;
    this.isSearching = false;
    // Clear failure tracking — abort-induced errors should not show as failures,
    // and pre-existing failures from partial search are irrelevant once stopped.
    this.failedTitles = new Map();
  }

  /**
   * Centralized stop for single manual search().
   */
  stopManualSearch(): void {
    this.manualSearchAborted = true;
    this.host.getSourceInstance()?.abortSearch();
    this.isSearching = false;
  }

  /**
   * Search for manga (single-title, single-source)
   */
  async search(query: string): Promise<void> {
    if (!query.trim() || this.isSearching) return;

    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    this.isSearching = true;
    this.manualSearchAborted = false;

    // Clear previous results immediately so they don't flash during the new search
    this.searchResults = [];
    this.host.clearThumbnailCache();

    // Show loading with optional stop button for sources that support it
    const showStopButton = this.host.getSourceInstance() !== null;

    const updateLoadingMessage = (message: string) => {
      const loadingP = resultsContainer.querySelector('.cr-loading-text');
      if (loadingP) {
        loadingP.textContent = message;
      }
    };

    resultsContainer.innerHTML = `
      <div class="cr-loading">
        <div class="cr-spinner"></div>
        <p class="cr-loading-text">Searching ${this.host.getSourceName()}...</p>
        ${showStopButton ? '<button class="cr-stop-btn" id="cr-stop-search">Stop</button>' : ''}
      </div>
    `;

    // Set up stop button handler
    if (showStopButton) {
      document.getElementById('cr-stop-search')?.addEventListener('click', () => {
        this.stopManualSearch();
        resultsContainer.innerHTML = `
          <div class="cr-no-results">
            <p>Search cancelled.</p>
          </div>
        `;
      });
    }

    // Set up search progress callback
    this.host.getSourceInstance()?.setSearchProgressCallback((current: number, total: number, variant: string) => {
      if (total > 1) {
        updateLoadingMessage(`Trying variant ${current}/${total}: "${variant}"...`);
      }
    });

    try {
      const source = sourceRegistry.get(this.host.currentSourceId);
      if (!source) {
        throw new Error('Source not found');
      }

      // Retry up to 3 times with backoff (handles MangaKatana empty-body rate limits)
      let lastError: any = null;
      for (let attempt = 0; attempt <= this.RETRY_DELAYS.length; attempt++) {
        if (this.manualSearchAborted) return;
        try {
          this.searchResults = await source.search(query);
          if (this.manualSearchAborted) return;
          lastError = null;
          break;
        } catch (error: any) {
          lastError = error;
          if (this.manualSearchAborted) return;
          if (error?.code === 'RATE_LIMITED' || error?.code === 'CANCELLED') {
            throw error;
          }
          if (attempt < this.RETRY_DELAYS.length) {
            updateLoadingMessage(`Retrying search (attempt ${attempt + 2})...`);
            await this.delay(this.RETRY_DELAYS[attempt]);
            if (this.manualSearchAborted) return;
          }
        }
      }
      if (lastError) throw lastError;

      // Sort by best similarity across all alternate titles
      const refs = this.getAllReferenceTitles();
      if (refs.length > 0 && this.searchResults.length > 1) {
        const matches = findBestMatchesMultiRef(
          refs,
          this.searchResults,
          (r) => r.title,
          50,
          0  // No threshold filtering - keep all results, just sort
        );
        this.searchResults = matches.map(m => m.item);
      }

      if (this.manualSearchAborted) return;
      this.host.renderResults();
    } catch (error) {
      if (this.manualSearchAborted) return;
      resultsContainer.innerHTML = `
        <div class="cr-error">
          <p>Search failed: ${(error as Error).message}</p>
          <button class="cr-retry-btn" onclick="document.getElementById('cr-match-search-btn').click()">
            Retry
          </button>
        </div>
      `;
    } finally {
      this.isSearching = false;
      // Clear the callback
      this.host.getSourceInstance()?.clearSearchProgressCallback();
    }
  }

  /**
   * Helper to create a delay promise
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Search a single title with retry logic
   * Returns results or empty array, tracks failures in failedTitles
   */
  private async searchWithRetry(
    title: string,
    source: { search(query: string): Promise<SearchResult[]> },
    sourceId: string,
    useExact: boolean = false
  ): Promise<SearchResult[]> {
    let lastError: any = null;

    for (let attempt = 0; attempt <= this.RETRY_DELAYS.length; attempt++) {
      // Check if aborted before each attempt
      if (this.searchAllAborted) {
        return [];
      }

      try {
        // Use searchExact for sources that support it in phase 1, otherwise regular search
        const instance = this.host.getSourceInstanceById(sourceId);
        const results = (useExact && instance)
          ? await instance.searchExact(title)
          : await source.search(title);

        // Success - remove from failed tracking if previously failed
        this.failedTitles.delete(title);
        return results;

      } catch (error: any) {
        lastError = error;

        // Rate limited or cancelled - don't retry, propagate immediately
        if (error?.code === 'RATE_LIMITED' || error?.code === 'CANCELLED') {
          throw error;
        }

        // Track the failure attempt
        this.failedTitles.set(title, {
          error: error?.message || 'Unknown error',
          attempts: attempt + 1
        });

        // If we have more retries, wait and try again
        if (attempt < this.RETRY_DELAYS.length) {
          console.log(`Search failed for "${title}", retrying in ${this.RETRY_DELAYS[attempt]}ms (attempt ${attempt + 1}/${this.RETRY_DELAYS.length + 1})`);
          await this.delay(this.RETRY_DELAYS[attempt]);
        }
      }
    }

    // All retries exhausted - log and return empty (title remains in failedTitles)
    console.warn(`All ${this.RETRY_DELAYS.length + 1} attempts failed for "${title}":`, lastError);
    return [];
  }

  /**
   * Search all alternate titles across ALL sources in parallel
   * Two-phase approach: Phase 1 = exact titles, Phase 2 = character variants
   * Within each phase, each title searches all sources simultaneously via Promise.all
   */
  async searchAll(): Promise<void> {
    if (this.isSearching || this.isSearchAllRunning) return;

    // Purge any stale results and thumbnails from a previous manga
    this.searchResults = [];
    this.host.clearThumbnailCache();

    // Capture session ID — if it changes mid-search, a new show() was called
    const sessionId = this.searchSessionId;

    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    const orderedTitles = this.host.getOrderedTitles();
    if (orderedTitles.length === 0) {
      this.host.showError(resultsContainer, 'warning', 'No titles available to search');
      return;
    }

    this.isSearchAllRunning = true;
    this.searchAllAborted = false;
    this.isSearching = true;
    this.failedTitles = new Map();

    const allSources = this.host.forcedSourceId
      ? sourceRegistry.getAll().filter(s => s.id === this.host.forcedSourceId)
      : sourceRegistry.getAll();
    const sourceBadgesHtml = this.host.renderSourceBadges();

    // Update progress UI
    const updateProgress = (phase: number, titleIndex: number, totalInPhase: number, currentTitle: string, variantInfo?: string) => {
      // Persist progress so it survives list↔grid view switches
      this.currentProgress = { phase, titleIndex, totalTitles: totalInPhase, currentTitle };

      // Update grid progress if in fullscreen grid mode
      if (this.host.getGridView().isFullscreen) {
        this.host.getGridView().updateProgress(phase, titleIndex, totalInPhase, currentTitle);
        return;
      }

      const basePercent = phase === 1 ? 0 : 50;
      const phaseWeight = phase === 1 ? 50 : 50;
      const phasePercent = totalInPhase > 0 ? ((titleIndex + 1) / totalInPhase) * phaseWeight : phaseWeight;
      const percent = basePercent + phasePercent;

      const progressBar = resultsContainer.querySelector('.cr-progress-bar') as HTMLElement;
      const headerEl = resultsContainer.querySelector('.cr-progress-header span:not(.cr-source-badge):not(.cr-source-badge-more)');
      const currentEl = resultsContainer.querySelector('.cr-progress-current');
      const variantEl = resultsContainer.querySelector('.cr-progress-variant');

      if (progressBar) progressBar.style.width = `${percent}%`;
      if (headerEl) headerEl.textContent = phase === 1 ? 'Searching exact titles on:' : 'Trying character variants on:';
      if (currentEl) {
        currentEl.innerHTML = `Title ${titleIndex + 1} of ${totalInPhase}: <span class="cr-progress-current-title">"${this.host.escapeHtml(currentTitle)}"</span>`;
      }
      if (variantEl) variantEl.textContent = variantInfo || '';

      // Update inline progress UI (rendered in the progress island, outside the results container)
      const progressIsland = document.getElementById('cr-progress-island');
      if (progressIsland) {
        const inlineCurrentEl = progressIsland.querySelector('.cr-inline-progress-current');
        const inlineProgressBar = progressIsland.querySelector('.cr-progress-bar') as HTMLElement;
        if (inlineCurrentEl) inlineCurrentEl.textContent = `"${currentTitle}"`;
        if (inlineProgressBar) inlineProgressBar.style.width = `${percent}%`;
      }

      this.host.updateLiveFailureCounter(resultsContainer);
    };

    // Render progress UI with multi-source badges
    resultsContainer.innerHTML = `
      <div class="cr-search-progress">
        <div class="cr-skip-link-container"><span class="cr-skip-link" id="cr-skip-to-manual">Skip to manual search</span></div>
        <div class="cr-progress-header">
          <div class="cr-progress-icon"></div>
          <span>Searching exact titles on:</span>
          <span class="cr-source-badges-group">${sourceBadgesHtml}</span>
        </div>
        <div class="cr-progress-bar-container">
          <div class="cr-progress-bar" style="width: 0%"></div>
        </div>
        <div class="cr-progress-details">
          <div class="cr-progress-current">Preparing search...</div>
          <div class="cr-progress-variant"></div>
        </div>
        <div class="cr-live-failures" id="cr-live-failures"></div>
        <button class="cr-stop-btn" id="cr-stop-search-all">Stop Search</button>
      </div>
    `;

    // Hide subtitle during search
    const subtitle = document.getElementById('cr-modal-subtitle');
    if (subtitle) subtitle.style.display = 'none';

    // Set up stop button — abort all sources
    document.getElementById('cr-stop-search-all')?.addEventListener('click', () => {
      this.stopSearchAll();
      this.host.showError(resultsContainer, 'stopped', 'Search stopped', true);
    });

    // Set up skip to manual link
    document.getElementById('cr-skip-to-manual')?.addEventListener('click', () => {
      this.stopSearchAll();
      this.host.showManualMode();
    });

    try {
      // ========== PHASE 1: Exact title searches (all sources in parallel) ==========
      for (let i = 0; i < orderedTitles.length; i++) {
        if (this.searchAllAborted || sessionId !== this.searchSessionId) return;

        const { title } = orderedTitles[i];
        updateProgress(1, i, orderedTitles.length, title);

        try {
          // Search ALL sources in parallel for this title
          const sourceResults = await Promise.all(
            allSources.map(source =>
              this.searchWithRetry(title, source, source.id, true)
                .catch(() => [] as SearchResult[])
            )
          );

          // Bail if aborted or a new search session started while we were awaiting
          if (this.searchAllAborted || sessionId !== this.searchSessionId) return;

          // Tag results with sourceId and accumulate
          for (let s = 0; s < allSources.length; s++) {
            const tagged = sourceResults[s].map(r => ({ ...r, sourceId: allSources[s].id }));
            if (tagged.length > 0) {
              this.accumulateResults(tagged);
            }
          }

          if (this.searchResults.length > 0) {
            if (this.host.getGridView().isFullscreen) {
              this.host.getGridView().updateProgress(1, i, orderedTitles.length, title);
              this.host.getGridView().renderGridResults();
            } else {
              this.host.renderResultsWithProgress(resultsContainer, 1, i, orderedTitles.length, title);
            }
          }

          this.host.updateLiveFailureCounter(resultsContainer);

          if (i < orderedTitles.length - 1) {
            await this.delay(150);
            if (this.searchAllAborted || sessionId !== this.searchSessionId) return;
          }
        } catch (error) {
          if (this.handleSearchError(error, resultsContainer)) return;
        }
      }

      // Guard between phases
      if (this.searchAllAborted || sessionId !== this.searchSessionId) return;

      // ========== PHASE 2: Character variant searches (all sources in parallel) ==========
      const titlesWithVariants = orderedTitles.filter(({ title }) => hasSpecialChars(title));

      if (titlesWithVariants.length === 0) {
        if (this.searchResults.length > 0) {
          if (this.host.getGridView().isFullscreen) {
            this.host.getGridView().finalizeSearch();
          } else {
            this.host.renderResults();
          }
        } else {
          this.host.showError(resultsContainer, 'search',
            `No results found after trying ${orderedTitles.length} title${orderedTitles.length !== 1 ? 's' : ''} across ${allSources.length} source${allSources.length !== 1 ? 's' : ''}`,
            true
          );
        }
        return;
      }

      for (let i = 0; i < titlesWithVariants.length; i++) {
        if (this.searchAllAborted || sessionId !== this.searchSessionId) return;

        const { title } = titlesWithVariants[i];
        updateProgress(2, i, titlesWithVariants.length, title, 'Trying variants...');

        try {
          // Search ALL sources in parallel for variant title
          const sourceResults = await Promise.all(
            allSources.map(source =>
              this.searchWithRetry(title, source, source.id, false)
                .catch(() => [] as SearchResult[])
            )
          );

          // Bail if aborted or a new search session started while we were awaiting
          if (this.searchAllAborted || sessionId !== this.searchSessionId) return;
          for (let s = 0; s < allSources.length; s++) {
            const tagged = sourceResults[s].map(r => ({ ...r, sourceId: allSources[s].id }));
            if (tagged.length > 0) {
              this.accumulateResults(tagged);
            }
          }

          if (this.searchResults.length > 0) {
            if (this.host.getGridView().isFullscreen) {
              this.host.getGridView().updateProgress(2, i, titlesWithVariants.length, title);
              this.host.getGridView().renderGridResults();
            } else {
              this.host.renderResultsWithProgress(resultsContainer, 2, i, titlesWithVariants.length, title);
            }
          }

          this.host.updateLiveFailureCounter(resultsContainer);

          if (i < titlesWithVariants.length - 1) {
            await this.delay(200);
            if (this.searchAllAborted || sessionId !== this.searchSessionId) return;
          }
        } catch (error) {
          if (this.handleSearchError(error, resultsContainer)) return;
        }
      }

      // Search complete
      if (this.searchResults.length > 0) {
        if (this.host.getGridView().isFullscreen) {
          this.host.getGridView().finalizeSearch();
        } else {
          this.host.renderResults();
        }
      } else {
        this.host.showError(resultsContainer, 'search',
          `No results found after trying ${orderedTitles.length} title${orderedTitles.length !== 1 ? 's' : ''} across ${allSources.length} source${allSources.length !== 1 ? 's' : ''}`,
          true
        );
      }

    } catch (error) {
      this.host.showError(resultsContainer, 'warning', `Search failed: ${(error as Error).message}`);
    } finally {
      this.isSearchAllRunning = false;
      this.isSearching = false;
      // Clear callbacks on all sources
      for (const source of allSources) {
        this.host.getSourceInstanceById(source.id)?.clearSearchProgressCallback();
      }
    }
  }

  /**
   * Accumulate search results, avoiding duplicates (max 30 for multi-source)
   * Dedup key is sourceId:slug to allow same manga from different sources
   */
  private accumulateResults(results: SearchResult[]): void {
    const existingKeys = new Set(this.searchResults.map(r => `${r.sourceId || ''}:${r.slug}`));
    for (const result of results) {
      const key = `${result.sourceId || ''}:${result.slug}`;
      if (!existingKeys.has(key) && this.searchResults.length < 30) {
        this.searchResults.push(result);
        existingKeys.add(key);
      }
    }

    // Sort by best similarity across ALL alternate titles + main title
    const refs = this.getAllReferenceTitles();
    if (refs.length > 0 && this.searchResults.length > 1) {
      const matches = findBestMatchesMultiRef(
        refs,
        this.searchResults,
        (r) => r.title,
        50,
        0  // No threshold filtering - keep all results, just sort
      );
      this.searchResults = this.sortWithChapterTiebreak(matches);
    }
  }

  /**
   * Sort scored results using chapter count as tiebreaker.
   * Among results with similar title scores (within 0.05), prefer those with more chapters.
   * Only applies to results that actually match a reference title (score >= 0.5);
   * irrelevant results with many chapters won't be boosted above relevant matches.
   */
  private sortWithChapterTiebreak(matches: { item: SearchResult; score: number }[]): SearchResult[] {
    const SCORE_BAND = 0.05;
    const RELEVANCE_FLOOR = 0.5;

    return matches
      .sort((a, b) => {
        // If scores differ by more than the band, strict score order wins
        if (Math.abs(a.score - b.score) > SCORE_BAND) return b.score - a.score;

        // Both must be relevant enough for chapter count to matter
        if (a.score < RELEVANCE_FLOOR && b.score < RELEVANCE_FLOOR) return b.score - a.score;

        // Within the band: use chapter count as tiebreaker
        const chA = this.host.getChapterCount(a.item.sourceId || '', a.item.slug) ?? -1;
        const chB = this.host.getChapterCount(b.item.sourceId || '', b.item.slug) ?? -1;

        // If one has chapter data and the other doesn't, prefer the one with data
        if (chA >= 0 && chB < 0) return -1;
        if (chB >= 0 && chA < 0) return 1;

        // Both have data: prefer more chapters (0 chapters is a real signal — penalize)
        if (chA !== chB) return chB - chA;

        // Fall back to score
        return b.score - a.score;
      })
      .map(m => m.item);
  }

  /**
   * Get the best reference title for sorting results
   * Prefers the "best match" title that was used for searching
   */
  private getBestReferenceTitle(): string {
    // Use the best matching alternate title (index determined by getBestInitialTitle)
    if (this.host.getAlternateTitles().length > 0 && this.host.getBestTitleIndex() < this.host.getAlternateTitles().length) {
      return this.host.getAlternateTitles()[this.host.getBestTitleIndex()];
    }
    // Fallback to pageData title
    return this.host.pageData?.title || '';
  }

  /**
   * Get all reference titles for multi-title relevance sorting.
   * Includes all alternate titles plus the main pageData title, deduplicated.
   */
  private getAllReferenceTitles(): string[] {
    const titles = new Set<string>();
    if (this.host.pageData?.title) titles.add(this.host.pageData.title);
    for (const t of this.host.getAlternateTitles()) {
      if (t) titles.add(t);
    }
    return [...titles];
  }

  /**
   * Handle successful search results
   */
  handleSearchResults(results: SearchResult[]): void {
    this.searchResults = results;

    // Sort by best similarity across all alternate titles
    const refs = this.getAllReferenceTitles();
    if (refs.length > 0) {
      const matches = findBestMatchesMultiRef(
        refs,
        this.searchResults,
        (r) => r.title,
        50,
        0.1
      );
      this.searchResults = this.sortWithChapterTiebreak(matches);
    }

    this.host.renderResults();
  }

  /**
   * Handle search error, return true if should stop
   */
  private handleSearchError(error: any, container: HTMLElement): boolean {
    if (error?.code === 'RATE_LIMITED') {
      this.host.showError(container, 'rate-limited', 'Rate limited. Please wait a moment and try again.');
      return true;
    }
    if (error?.code === 'CANCELLED') {
      return false; // Continue to next
    }
    console.warn('Search error:', error);
    return false; // Continue to next
  }
}
