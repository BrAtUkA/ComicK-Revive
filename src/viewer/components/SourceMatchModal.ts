import { SearchResult, ComickPageData } from '@/types';
import { sourceRegistry, asuraScans, mangaKatana } from '@/sources';
import type { AsuraScans } from '@/sources';
import type { MangaKatana } from '@/sources';
import { sourceMappingManager } from '@/core';
import { hasSpecialChars } from '@/utils';
import { isSourceUrl } from '@/utils/sourceDomains';
import { bridgeFetchImage } from '@/utils/bridge';
import { ContextMenu, ContextMenuHost } from './ContextMenu';
import { DetailsPanel, DetailsPanelHost } from './DetailsPanel';
import { GridView, GridViewHost } from './GridView';
import { TitleCombobox, TitleComboboxHost } from './TitleCombobox';
import { SearchOrchestrator, SearchOrchestratorHost } from './SearchOrchestrator';

/**
 * SourceMatchModal - Modal for linking ComicK manga to a source
 * 
 * Shows search results from sources and allows user to select the correct match.
 * Features a hybrid dropdown/input for title selection with alternate titles.
 */
export class SourceMatchModal {
  private container: HTMLElement | null = null;
  private pageData: ComickPageData | null = null;
  private currentSourceId: string = 'asura';

  private onSelect?: (sourceId: string, result: SearchResult) => void;
  private onCancel?: () => void;
  private isManualMode: boolean = false;
  private forcedSourceId: string | null = null;

  // Store bound handlers for proper cleanup
  private boundDocumentClickHandler: ((e: MouseEvent) => void) | null = null;

  // Cache proxied thumbnail data URLs to avoid re-fetching on re-render
  private thumbnailCache: Map<string, string> = new Map();

  // Cache chapter counts to avoid re-fetching on re-render
  private chapterCountCache: Map<string, number> = new Map();
  private resortTimerId: ReturnType<typeof setTimeout> | null = null;

  // Sub-components
  private contextMenuComponent!: ContextMenu;
  private detailsPanelComponent!: DetailsPanel;
  private gridView!: GridView;
  private titleCombobox!: TitleCombobox;
  private searchOrchestrator!: SearchOrchestrator;

  /**
   * Get the concrete source instance by ID for abort/progress/searchExact operations.
   * These methods are not on the MangaSource interface but both AsuraScans and MangaKatana have them.
   */
  private getSourceInstanceById(id: string): AsuraScans | MangaKatana | null {
    if (id === 'asura') return asuraScans;
    if (id === 'mangakatana') return mangaKatana;
    return null;
  }

  /**
   * Get the concrete source instance for the current source.
   */
  private getSourceInstance(): AsuraScans | MangaKatana | null {
    return this.getSourceInstanceById(this.currentSourceId);
  }

  /**
   * Abort searches on all registered sources.
   */
  private abortAllSources(): void {
    for (const source of sourceRegistry.getAll({ includeDisabled: true })) {
      this.getSourceInstanceById(source.id)?.abortSearch();
    }
  }

  /**
   * Get source name by ID.
   */
  private getSourceNameById(id: string): string {
    const source = sourceRegistry.get(id);
    return source?.name || id;
  }

  /**
   * Build source badges HTML for all sources being searched.
   * Shows first 3 badges + "+N more" if >3.
   */
  private renderSourceBadges(): string {
    const allSources = this.forcedSourceId
      ? sourceRegistry.getAll({ includeDisabled: true }).filter(s => s.id === this.forcedSourceId)
      : sourceRegistry.getAll();
    const maxBadges = 3;
    const badges = allSources.slice(0, maxBadges).map(s =>
      `<span class="cr-source-badge">${s.name}</span>`
    ).join(' ');
    const remaining = allSources.length - maxBadges;
    const moreText = remaining > 0 ? ` <span class="cr-source-badge-more">+${remaining} more</span>` : '';
    return badges + moreText;
  }

  /**
   * Show the modal
   */
  show(
    pageData: ComickPageData,
    onSelect: (sourceId: string, result: SearchResult) => void,
    onCancel?: () => void,
    options?: { forcedSourceId?: string }
  ): void {
    // Clean up any existing modal first (in case hide() wasn't called)
    if (this.container) {
      this.hide();
    }
    
    // Reset all state for fresh modal
    this.pageData = pageData;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.isManualMode = false;
    this.thumbnailCache = new Map();

    // Set forced source for migration mode
    this.forcedSourceId = options?.forcedSourceId || null;
    if (this.forcedSourceId) {
      this.currentSourceId = this.forcedSourceId;
    }

    // Create sub-components
    this.contextMenuComponent = new ContextMenu(this.createContextMenuHost());
    this.detailsPanelComponent = new DetailsPanel(this.createDetailsPanelHost());
    this.titleCombobox = new TitleCombobox(this.createTitleComboboxHost());
    this.titleCombobox.reset(pageData.alternateTitles || []);
    this.gridView = new GridView(this.createGridViewHost());
    this.searchOrchestrator = new SearchOrchestrator(this.createSearchOrchestratorHost());

    this.createModal();

    // Wire combobox event handlers after DOM is created
    this.titleCombobox.setupEventListeners();

    // Update source hint for initial state
    this.titleCombobox.updateSourceHint();

    // Invalidate any in-flight searches from a previous session
    this.searchOrchestrator.searchSessionId++;

    // Auto-search all titles
    this.searchOrchestrator.searchAll();
  }

  /**
   * Hide the modal
   */
  hide(): void {
    // Clear any pending timeouts
    if (this.titleCombobox?.blurTimeoutId !== null) {
      clearTimeout(this.titleCombobox.blurTimeoutId!);
      this.titleCombobox.blurTimeoutId = null;
    }

    // Remove document-level event listeners
    document.removeEventListener('keydown', this.handleEscape);
    if (this.boundDocumentClickHandler) {
      document.removeEventListener('click', this.boundDocumentClickHandler);
      this.boundDocumentClickHandler = null;
    }

    // Abort any running search and reset search state
    this.abortAllSources();
    this.searchOrchestrator?.abort();
    this.searchOrchestrator?.reset();

    // Reset modal-owned state
    this.thumbnailCache = new Map();
    this.chapterCountCache = new Map();
    this.forcedSourceId = null;
    if (this.resortTimerId !== null) {
      clearTimeout(this.resortTimerId);
      this.resortTimerId = null;
    }
    this.gridView?.reset();

    // Clean up sub-components
    this.contextMenuComponent?.cleanup();
    this.detailsPanelComponent?.hideDetailsPanel();
    
    // Remove DOM
    this.container?.remove();
    this.container = null;
  }

  /**
   * Create modal DOM
   */
  private createModal(): void {
    // Remove existing
    document.getElementById('cr-source-match-modal')?.remove();

    const initialTitle = this.titleCombobox.getBestInitialTitle();

    this.container = document.createElement('div');
    this.container.id = 'cr-source-match-modal';
    this.container.className = 'cr-modal-overlay';
    this.container.innerHTML = `
      <div class="cr-modal-wrapper">
        <div class="cr-modal">
          <div class="cr-modal-header">
            <h3>${this.forcedSourceId
              ? `Migrate to ${this.getSourceNameById(this.forcedSourceId)}`
              : 'Link to Source'}</h3>
            <button class="cr-modal-close" id="cr-modal-close">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
          <div class="cr-grid-header-bar hidden" id="cr-grid-header-bar">
            <div class="cr-grid-header-bar-fill" id="cr-grid-header-bar-fill"></div>
            <div class="cr-grid-header-tooltip" id="cr-grid-header-tooltip"></div>
          </div>

          <div class="cr-modal-body">
            <p class="cr-modal-subtitle" id="cr-modal-subtitle">
              ${this.forcedSourceId
                ? `Search for "<strong>${this.pageData?.title || 'Unknown'}</strong>" on ${this.getSourceNameById(this.forcedSourceId)}`
                : `Search for "<strong>${this.pageData?.title || 'Unknown'}</strong>" on a source`}
            </p>

            <div class="cr-source-hint" id="cr-source-hint">
              <svg class="cr-hint-icon" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              <span class="cr-hint-text" id="cr-hint-text"></span>
            </div>

            <div class="cr-manual-header hidden" id="cr-manual-header">
              <button class="cr-back-btn" id="cr-back-to-auto">
                <span class="cr-icon cr-icon-arrow-left"></span>
                Search All
              </button>
            </div>

            <div class="cr-search-row hidden" id="cr-search-controls">
              <div class="cr-title-combobox" id="cr-title-combobox">
                <input
                  type="text"
                  class="cr-search-input"
                  id="cr-match-search"
                  value="${this.escapeHtml(initialTitle)}"
                  placeholder="Search manga..."
                >
                <button class="cr-title-dropdown-btn" id="cr-title-dropdown-btn" title="Show alternate titles">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M7 10l5 5 5-5z"/>
                  </svg>
                </button>
                <div class="cr-title-dropdown-menu" id="cr-title-dropdown-menu">
                  ${this.titleCombobox.renderTitleDropdownItems()}
                </div>
              </div>
              <select class="cr-source-dropdown" id="cr-match-source">
                ${this.renderSourceOptions()}
              </select>
              <button class="cr-search-btn" id="cr-match-search-btn">Search</button>
            </div>

            <div class="cr-search-results" id="cr-match-results">
              <!-- Results will appear here -->
            </div>
          </div>
        </div>
        <div class="cr-progress-island hidden" id="cr-progress-island"></div>
      </div>
    `;

    document.body.appendChild(this.container);

    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Escape HTML for safe insertion
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Render source dropdown options
   */
  private renderSourceOptions(): string {
    const sources = this.forcedSourceId
      ? sourceRegistry.getAll({ includeDisabled: true }).filter(s => s.id === this.forcedSourceId)
      : sourceRegistry.getAll();
    // Keep the currently linked source selectable even when disabled
    if (this.currentSourceId && !sources.some(s => s.id === this.currentSourceId)) {
      const current = sourceRegistry.get(this.currentSourceId);
      if (current) sources.push(current);
    }
    return sources.map(source => `
      <option value="${source.id}" ${source.id === this.currentSourceId ? 'selected' : ''}>
        ${source.name}
      </option>
    `).join('');
  }

  /**
   * Setup event listeners (modal-level only; combobox events handled by TitleCombobox)
   */
  private setupEventListeners(): void {
    // Close button
    document.getElementById('cr-modal-close')?.addEventListener('click', () => {
      this.hide();
      this.onCancel?.();
    });

    // Close dropdown when clicking outside combobox
    const combobox = document.getElementById('cr-title-combobox');
    this.boundDocumentClickHandler = (e: MouseEvent) => {
      if (this.titleCombobox.isTitleDropdownOpen && combobox && !combobox.contains(e.target as Node)) {
        this.titleCombobox.closeTitleDropdown();
      }
    };
    document.addEventListener('click', this.boundDocumentClickHandler);

    // Source dropdown
    document.getElementById('cr-match-source')?.addEventListener('change', (e) => {
      this.currentSourceId = (e.target as HTMLSelectElement).value;
      this.titleCombobox.updateSourceHint();
      const input = document.getElementById('cr-match-search') as HTMLInputElement;
      if (input.value) {
        this.searchOrchestrator.search(input.value);
      }
    });

    // Search button (for manual mode single search)
    document.getElementById('cr-match-search-btn')?.addEventListener('click', () => {
      const input = document.getElementById('cr-match-search') as HTMLInputElement;
      if (input?.value) {
        this.searchOrchestrator.search(input.value);
      }
    });

    // Back to Search All button (in manual mode header)
    document.getElementById('cr-back-to-auto')?.addEventListener('click', () => {
      this.exitManualModeAndSearchAll();
    });

    // Escape to close modal
    document.addEventListener('keydown', this.handleEscape);
  }

  private handleEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.detailsPanelComponent?.isVisible()) {
        this.detailsPanelComponent.hideDetailsPanel();
      } else if (this.gridView.isFullscreen) {
        this.gridView.toggleFullscreen(false);
      } else {
        this.hide();
        this.onCancel?.();
      }
    }
  };

  /**
   * Render results with progress indicator in the island below the modal
   */
  private renderResultsWithProgress(
    container: HTMLElement,
    phase: number,
    titleIndex: number,
    totalTitles: number,
    currentTitle: string
  ): void {
    // Hide subtitle and source hint
    const subtitle = document.getElementById('cr-modal-subtitle');
    if (subtitle) subtitle.style.display = 'none';
    const sourceHint = document.getElementById('cr-source-hint');
    if (sourceHint) sourceHint.classList.remove('visible');

    const basePercent = phase === 1 ? 0 : 50;
    const phasePercent = ((titleIndex + 1) / totalTitles) * 50;
    const percent = basePercent + phasePercent;
    const sourceBadgesHtml = this.renderSourceBadges();

    // Check if the skeleton already exists — if so, do keyed reconciliation
    const existingSection = container.querySelector('.cr-results-section');
    if (existingSection) {
      // Build set of already-rendered keys from DOM
      const existingKeys = new Set<string>();
      existingSection.querySelectorAll<HTMLElement>('.cr-result-item').forEach(el => {
        const slug = el.dataset.slug;
        const sid = el.dataset.sourceId;
        if (slug && sid) existingKeys.add(`${sid}:${slug}`);
      });

      const results = this.searchOrchestrator.searchResults;
      let hasNewItems = false;

      for (const result of results) {
        const sourceId = result.sourceId || this.currentSourceId;
        const key = `${sourceId}:${result.slug}`;
        if (existingKeys.has(key)) continue;

        hasNewItems = true;
        // Capture stable identity for closures (immune to array reordering)
        const slug = result.slug;
        const sid = sourceId;

        const item = document.createElement('div');
        item.className = 'cr-result-item';
        item.dataset.slug = slug;
        item.dataset.sourceId = sid;
        item.innerHTML = `
          <img
            src="${this.getThumbnailSrc(result.thumbnailUrl)}"
            data-original-url="${result.thumbnailUrl}"
            alt="${this.escapeHtml(result.title)}"
            class="cr-result-thumb"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
          >
          <div class="cr-result-info">
            <span class="cr-result-title">${result.title}</span>
            <span class="cr-result-source"><span class="cr-source-badge">${this.getSourceNameById(sid)}</span></span>
          </div>
          <button class="cr-result-info-btn" title="View details">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="#555" class="cr-info-icon-fill" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
          </button>
          <button class="cr-result-select">Select</button>
        `;

        // Wire handlers using slug/sourceId identity (immune to reordering)
        item.addEventListener('click', () => {
          const r = this.findResultByIdentity(slug, sid);
          if (r) this.detailsPanelComponent.showDetailsPanel(r);
        });
        item.querySelector('.cr-result-info-btn')!.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = this.findResultByIdentity(slug, sid);
          if (r) this.detailsPanelComponent.showDetailsPanel(r);
        });
        item.querySelector('.cr-result-select')!.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = this.findResultIndexByIdentity(slug, sid);
          if (idx >= 0) this.selectResult(idx);
        });

        existingSection.appendChild(item);
        this.proxyThumbnailsForElement(item);
      }

      if (hasNewItems) {
        this.updateListItemIndices(existingSection);
        // loadChapterCounts on the section — cached items return instantly
        this.loadChapterCounts(existingSection as HTMLElement);
        this.contextMenuComponent.attachContextMenuHandlers(container);
      }
    } else {
      // First render — full build
      container.innerHTML = `
        <div class="cr-results-with-progress">
          <div class="cr-skip-link-container"><span class="cr-skip-link" id="cr-skip-to-manual-inline">Skip to manual search</span></div>
          <div class="cr-results-section">
            ${this.searchOrchestrator.searchResults.map((result) => {
              const sourceId = result.sourceId || this.currentSourceId;
              return `
              <div class="cr-result-item" data-slug="${result.slug}" data-source-id="${sourceId}">
                <img
                  src="${this.getThumbnailSrc(result.thumbnailUrl)}"
                  data-original-url="${result.thumbnailUrl}"
                  alt="${this.escapeHtml(result.title)}"
                  class="cr-result-thumb"
                  onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
                >
                <div class="cr-result-info">
                  <span class="cr-result-title">${result.title}</span>
                  <span class="cr-result-source"><span class="cr-source-badge">${this.getSourceNameById(sourceId)}</span></span>
                </div>
                <button class="cr-result-info-btn" title="View details">
                  <svg viewBox="0 0 24 24" width="18" height="18">
                    <path fill="#555" class="cr-info-icon-fill" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                  </svg>
                </button>
                <button class="cr-result-select">Select</button>
              </div>`;
            }).join('')}
          </div>
        </div>
      `;

      this.wireListViewHandlers(container);
      this.updateListItemIndices(container.querySelector('.cr-results-section')!);
      this.proxyThumbnails(container);
      this.loadChapterCounts(container);
      this.contextMenuComponent.attachContextMenuHandlers(container);

      // Skip to manual link
      document.getElementById('cr-skip-to-manual-inline')?.addEventListener('click', () => {
        this.searchOrchestrator.stopSearchAll();
        this.showManualMode();
      });
    }

    // Update progress island (always rebuilt — it's outside the results container)
    const island = document.getElementById('cr-progress-island');
    if (island) {
      island.classList.remove('hidden');
      island.innerHTML = `
        <div class="cr-inline-progress-header">
          <div class="cr-progress-icon"></div>
          <span>Searching for more on:</span>
          <span class="cr-source-badges-group">${sourceBadgesHtml}</span>
          <button class="cr-stop-inline-btn" id="cr-stop-inline">Stop</button>
        </div>
        <div class="cr-progress-bar-container">
          <div class="cr-progress-bar" style="width: ${percent}%"></div>
        </div>
        <div class="cr-inline-progress-current">
          "${this.escapeHtml(currentTitle)}"
        </div>
      `;
    }

    // Stop button (in the island — rewire each time since island is rebuilt)
    document.getElementById('cr-stop-inline')?.addEventListener('click', () => {
      this.searchOrchestrator.stopSearchAll();
      this.renderResults();
    });

    this.gridView.updateExpandButton();
  }

  /**
   * Generate HTML for failed searches warning banner
   * Returns empty string if no failures
   */
  private renderFailuresWarning(): string {
    if (this.searchOrchestrator.failedTitles.size === 0) return '';

    const failedList = Array.from(this.searchOrchestrator.failedTitles.keys());
    const tooltipText = failedList.map(t => `• ${t}`).join('\n');

    return `
      <div class="cr-failures-warning" title="${this.escapeHtml(tooltipText)}">
        <span class="cr-icon cr-icon-alert"></span>
        <span class="cr-failures-text">${this.searchOrchestrator.failedTitles.size} search${this.searchOrchestrator.failedTitles.size !== 1 ? 'es' : ''} failed</span>
        <button class="cr-failures-retry" id="cr-retry-failed">Retry</button>
      </div>
    `;
  }

  /**
   * Setup click handler for failures retry button
   */
  private setupFailuresRetryHandler(container: HTMLElement): void {
    container.querySelector('#cr-retry-failed')?.addEventListener('click', () => {
      this.searchOrchestrator.searchAll();
    });
  }

  /**
   * Update the live failure counter in progress UI (called during search)
   */
  private updateLiveFailureCounter(container: HTMLElement): void {
    const liveFailuresEl = container.querySelector('#cr-live-failures');
    if (!liveFailuresEl) return;
    
    if (this.searchOrchestrator.failedTitles.size === 0) {
      liveFailuresEl.innerHTML = '';
      return;
    }

    const failedList = Array.from(this.searchOrchestrator.failedTitles.keys());
    const tooltipText = failedList.map(t => `• ${t}`).join('\n');

    liveFailuresEl.innerHTML = `
      <span class="cr-icon cr-icon-alert"></span>
      <span>${this.searchOrchestrator.failedTitles.size} failed</span>
    `;
    liveFailuresEl.setAttribute('title', tooltipText);
    liveFailuresEl.classList.add('visible');
  }

  /**
   * Show error state with Lucide icons
   */
  private showError(container: HTMLElement, type: 'warning' | 'search' | 'stopped' | 'rate-limited', message: string, showManualOption: boolean = false): void {
    // Hide progress island
    const island = document.getElementById('cr-progress-island');
    if (island) {
      island.classList.add('hidden');
      island.innerHTML = '';
    }

    const iconMap = {
      'warning': 'cr-icon-alert',
      'search': 'cr-icon-search-x',
      'stopped': 'cr-icon-circle-pause',
      'rate-limited': 'cr-icon-hourglass'
    };
    
    const iconClass = iconMap[type] || 'cr-icon-alert';
    const iconTypeClass = type === 'warning' || type === 'rate-limited' ? 'warning' : type === 'stopped' ? 'stopped' : '';
    
    // Show failures warning if any searches failed (for search, stopped, and rate-limited types)
    const showFailures = type === 'search' || type === 'stopped' || type === 'rate-limited';
    const failuresWarning = showFailures ? this.renderFailuresWarning() : '';
    
    // Show subtitle for context during error states, but hide source hint
    const subtitle = document.getElementById('cr-modal-subtitle');
    if (subtitle) subtitle.style.display = '';
    const sourceHint = document.getElementById('cr-source-hint');
    if (sourceHint) sourceHint.classList.remove('visible');
    
    container.innerHTML = `
      <div class="cr-search-error">
        <div class="cr-error-icon ${iconTypeClass}">
          <span class="cr-icon ${iconClass}"></span>
        </div>
        <div class="cr-error-message">${message}</div>
        ${failuresWarning}
        <div class="cr-error-actions">
          <button class="cr-retry-btn" id="cr-resume-search">Try Again</button>
          ${showManualOption ? '<button class="cr-secondary-btn" id="cr-manual-search">Manual Search</button>' : ''}
        </div>
      </div>
    `;
    this.setupErrorHandlers(container);
    this.setupFailuresRetryHandler(container);
  }

  /**
   * Show manual search mode
   */
  private showManualMode(): void {
    this.isManualMode = true;

    // Cancel any ongoing search (idempotent if already stopped)
    if (this.searchOrchestrator.isSearching || this.searchOrchestrator.isSearchAllRunning) {
      this.searchOrchestrator.stopSearchAll();
    }

    // Hide progress island
    const island = document.getElementById('cr-progress-island');
    if (island) {
      island.classList.add('hidden');
      island.innerHTML = '';
    }

    // Show search controls
    const searchRow = document.getElementById('cr-search-controls');
    if (searchRow) {
      searchRow.classList.remove('hidden');
    }

    // Show manual mode header (persistent)
    const manualHeader = document.getElementById('cr-manual-header');
    if (manualHeader) {
      manualHeader.classList.remove('hidden');
    }

    // Clear previous search results
    this.searchOrchestrator.searchResults = [];
    
    // Show manual mode UI in results
    const resultsContainer = document.getElementById('cr-match-results');
    if (resultsContainer) {
      resultsContainer.innerHTML = `
        <div class="cr-no-results">
          <p>Enter a search term above and click Search.</p>
        </div>
      `;
    }
    
    // Update source hint for manual mode (checks current input)
    this.titleCombobox.updateSourceHint();
  }

  /**
   * Exit manual mode and start Search All
   */
  private exitManualModeAndSearchAll(): void {
    // Cancel any ongoing manual search
    if (this.searchOrchestrator.isSearching) {
      this.searchOrchestrator.stopManualSearch();
    }

    this.isManualMode = false;

    // Hide search controls
    const searchRow = document.getElementById('cr-search-controls');
    if (searchRow) {
      searchRow.classList.add('hidden');
    }

    // Hide manual header
    const manualHeader = document.getElementById('cr-manual-header');
    if (manualHeader) {
      manualHeader.classList.add('hidden');
    }

    // Clear previous search results
    this.searchOrchestrator.searchResults = [];

    // Update source hint for Search All mode (checks all titles)
    this.titleCombobox.updateSourceHint();

    this.searchOrchestrator.searchAll();
  }

  /**
   * Setup error action button handlers
   */
  private setupErrorHandlers(container: HTMLElement): void {
    container.querySelector('#cr-resume-search')?.addEventListener('click', () => {
      this.searchOrchestrator.searchAll();
    });
    container.querySelector('#cr-manual-search')?.addEventListener('click', () => {
      this.showManualMode();
    });
  }

  /**
   * Render search results
   */
  private renderResults(): void {
    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    // Hide the progress island when search is done
    const island = document.getElementById('cr-progress-island');
    if (island) {
      island.classList.add('hidden');
      island.innerHTML = '';
    }

    // Hide subtitle when showing results
    const subtitle = document.getElementById('cr-modal-subtitle');
    if (subtitle) subtitle.style.display = 'none';
    
    // In manual mode, keep source hint visible if input has special chars
    // In auto mode, always hide the hint when showing results
    if (this.isManualMode) {
      const searchInput = document.getElementById('cr-match-search') as HTMLInputElement;
      const query = searchInput?.value || '';
      if (!hasSpecialChars(query)) {
        const sourceHint = document.getElementById('cr-source-hint');
        if (sourceHint) sourceHint.classList.remove('visible');
      }
    } else {
      const sourceHint = document.getElementById('cr-source-hint');
      if (sourceHint) sourceHint.classList.remove('visible');
    }

    if (this.searchOrchestrator.searchResults.length === 0) {
      // Match the non-empty case below: never show the failures warning in manual mode.
      // The warning's Retry button calls searchAll(), which would render auto-search
      // progress underneath the still-visible manual-search bar and "Search All" header,
      // leaving the user in a mixed/broken UI state. The "Search All" button in the
      // manual header already provides the path back to auto mode.
      const failuresWarning = this.isManualMode ? '' : this.renderFailuresWarning();
      resultsContainer.innerHTML = `
        <div class="cr-no-results">
          <p>No results found. Try a different search term.</p>
          ${failuresWarning}
        </div>
      `;
      this.setupFailuresRetryHandler(resultsContainer);
      return;
    }

    // Show failures warning at the top if some searches failed but we got results
    const failuresWarning = this.isManualMode ? '' : this.renderFailuresWarning();

    // Sort by title similarity only (strip chapter-count tiebreaker) to create
    // the "before" state for FLIP animation. When chapter counts load,
    // scheduleResort() will re-sort WITH the tiebreaker and animate the transition.
    this.searchOrchestrator.sortTitleOnly();

    resultsContainer.innerHTML = failuresWarning + (this.isManualMode ? '' : `<div class="cr-skip-link-container"><span class="cr-skip-link" id="cr-manual-search-link">Manual search</span></div>`) + `<div class="cr-results-section">` + this.searchOrchestrator.searchResults.map((result) => {
      const sourceId = result.sourceId || this.currentSourceId;
      return `
      <div class="cr-result-item" data-slug="${result.slug}" data-source-id="${sourceId}">
        <img
          src="${this.getThumbnailSrc(result.thumbnailUrl)}"
          data-original-url="${result.thumbnailUrl}"
          alt="${this.escapeHtml(result.title)}"
          class="cr-result-thumb"
          onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 150%22><rect fill=%22%23333%22 width=%22100%22 height=%22150%22/></svg>'"
        >
        <div class="cr-result-info">
          <span class="cr-result-title">${result.title}</span>
          <span class="cr-result-source"><span class="cr-source-badge">${this.getSourceNameById(sourceId)}</span></span>
        </div>
        <button class="cr-result-info-btn" title="View details">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#555" class="cr-info-icon-fill" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
        </button>
        <button class="cr-result-select">Select</button>
      </div>`;
    }).join('') + `</div>`;

    // Setup failures retry handler if warning is shown
    this.setupFailuresRetryHandler(resultsContainer);

    // Wire all click handlers using slug/sourceId identity
    this.wireListViewHandlers(resultsContainer);
    this.updateListItemIndices(resultsContainer.querySelector('.cr-results-section')!);

    // Manual search link
    document.getElementById('cr-manual-search-link')?.addEventListener('click', () => {
      this.showManualMode();
    });

    // Proxy thumbnails that need CORS headers
    this.proxyThumbnails(resultsContainer);
    this.loadChapterCounts(resultsContainer);
    this.contextMenuComponent.attachContextMenuHandlers(resultsContainer);

    this.gridView.updateExpandButton();
  }

  /**
   * Find a result by stable slug+sourceId identity (immune to array reordering).
   */
  private findResultByIdentity(slug: string, sourceId: string): SearchResult | undefined {
    return this.searchOrchestrator.searchResults.find(
      r => r.slug === slug && (r.sourceId || this.currentSourceId) === sourceId
    );
  }

  /**
   * Find a result's current index by slug+sourceId identity.
   */
  private findResultIndexByIdentity(slug: string, sourceId: string): number {
    return this.searchOrchestrator.searchResults.findIndex(
      r => r.slug === slug && (r.sourceId || this.currentSourceId) === sourceId
    );
  }

  /**
   * Wire click handlers on all .cr-result-item elements using slug/sourceId identity.
   * Used by both first-render and renderResults paths.
   */
  private wireListViewHandlers(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>('.cr-result-item').forEach((item) => {
      const slug = item.dataset.slug!;
      const sid = item.dataset.sourceId!;
      item.addEventListener('click', () => {
        const result = this.findResultByIdentity(slug, sid);
        if (result) this.detailsPanelComponent.showDetailsPanel(result);
      });
    });

    container.querySelectorAll<HTMLElement>('.cr-result-info-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const parentItem = btn.closest('.cr-result-item') as HTMLElement;
        const result = this.findResultByIdentity(parentItem.dataset.slug!, parentItem.dataset.sourceId!);
        if (result) this.detailsPanelComponent.showDetailsPanel(result);
      });
    });

    container.querySelectorAll<HTMLElement>('.cr-result-select').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const parentItem = btn.closest('.cr-result-item') as HTMLElement;
        const idx = this.findResultIndexByIdentity(parentItem.dataset.slug!, parentItem.dataset.sourceId!);
        if (idx >= 0) this.selectResult(idx);
      });
    });
  }

  /**
   * Sync data-index attributes on all list items to match their current position
   * in the searchResults array. Called after keyed reconciliation or reorder.
   */
  private updateListItemIndices(section: Element): void {
    const results = this.searchOrchestrator.searchResults;
    section.querySelectorAll<HTMLElement>('.cr-result-item').forEach(item => {
      const slug = item.dataset.slug;
      const sid = item.dataset.sourceId;
      if (!slug || !sid) return;
      const idx = results.findIndex(
        r => r.slug === slug && (r.sourceId || this.currentSourceId) === sid
      );
      if (idx >= 0) {
        item.dataset.index = String(idx);
      }
    });
  }

  /**
   * Get display URL for a thumbnail, using cached proxy data URL if available.
   */
  private getThumbnailSrc(url: string): string {
    return this.thumbnailCache.get(url) || url;
  }

  /**
   * Proxy thumbnail images that need CORS headers (e.g., MangaDex hotlink protection).
   * Scans rendered <img> elements and replaces src with data URLs from background proxy.
   */
  private proxyThumbnails(container: HTMLElement): void {
    const imgs = container.querySelectorAll<HTMLImageElement>('img.cr-result-thumb, img.cr-grid-card-thumb');
    imgs.forEach(img => {
      const originalUrl = img.dataset.originalUrl;
      if (!originalUrl || !isSourceUrl(originalUrl)) return;
      if (this.thumbnailCache.has(originalUrl)) return; // Already proxied via getThumbnailSrc

      bridgeFetchImage(originalUrl).then(dataUrl => {
        this.thumbnailCache.set(originalUrl, dataUrl);
        // Only update if this img is still in the DOM
        if (img.isConnected) {
          img.src = dataUrl;
        }
      }).catch(() => {
        // Leave onerror fallback to handle it
      });
    });
  }

  /**
   * Proxy thumbnails for a single card element (for incremental updates).
   */
  private proxyThumbnailsForElement(card: HTMLElement): void {
    const img = card.querySelector<HTMLImageElement>('img.cr-result-thumb, img.cr-grid-card-thumb');
    if (!img) return;
    const originalUrl = img.dataset.originalUrl;
    if (!originalUrl || !isSourceUrl(originalUrl)) return;
    if (this.thumbnailCache.has(originalUrl)) return;

    bridgeFetchImage(originalUrl).then(dataUrl => {
      this.thumbnailCache.set(originalUrl, dataUrl);
      if (img.isConnected) img.src = dataUrl;
    }).catch(() => {});
  }

  /**
   * Load chapter count for a single grid card (for incremental updates).
   */
  private loadChapterCountForCard(card: HTMLElement): void {
    const sessionId = this.searchOrchestrator.searchSessionId;
    const slug = card.dataset.slug;
    const sourceId = card.dataset.sourceId || this.currentSourceId;
    if (!slug) return;

    const cacheKey = `${sourceId}:${slug}`;
    const metaSpan = card.querySelector('.cr-grid-card-meta');
    if (!metaSpan) return;

    if (this.chapterCountCache.has(cacheKey)) {
      this.renderChapterCountBadge(metaSpan as HTMLElement, this.chapterCountCache.get(cacheKey)!);
      return;
    }

    const source = sourceRegistry.get(sourceId);
    if (!source) return;

    source.getChapterList(slug).then((chapters) => {
      if (this.searchOrchestrator.searchSessionId !== sessionId) return;      this.chapterCountCache.set(cacheKey, chapters.length);
      if (card.isConnected) {
        const loading = metaSpan.querySelector('.cr-chapter-count-loading');
        if (loading) loading.remove();
        this.renderChapterCountBadge(metaSpan as HTMLElement, chapters.length);
      }
      this.scheduleResort();
    }).catch(() => {
      const loading = metaSpan.querySelector('.cr-chapter-count-loading');
      if (loading && loading.isConnected) loading.remove();
    });
  }

  /**
   * Lazily fetch chapter counts for each result item and update the DOM.
   * Uses CachedMangaSource so repeat calls are cheap (IndexedDB cache).
   */
  private loadChapterCounts(container: HTMLElement): void {
    const sessionId = this.searchOrchestrator.searchSessionId;
    const items = container.querySelectorAll<HTMLElement>('.cr-result-item, .cr-grid-card');
    items.forEach((item) => {
      // Unified lookup: both list items and grid cards use data-slug + data-source-id
      const slug = item.dataset.slug || '';
      const sourceId = item.dataset.sourceId || this.currentSourceId;
      if (!slug) return;

      const cacheKey = `${sourceId}:${slug}`;

      const sourceSpan = item.querySelector('.cr-result-source, .cr-grid-card-meta');
      if (!sourceSpan) return;

      // If already cached, render immediately and trigger resort
      if (this.chapterCountCache.has(cacheKey)) {
        this.renderChapterCountBadge(sourceSpan as HTMLElement, this.chapterCountCache.get(cacheKey)!);
        this.scheduleResort();
        return;
      }

      // Add loading spinner
      const loadingSpan = document.createElement('span');
      loadingSpan.className = 'cr-chapter-count-loading';
      loadingSpan.innerHTML = '<span class="cr-count-spinner"></span>';
      sourceSpan.appendChild(loadingSpan);

      // Fetch asynchronously
      const source = sourceRegistry.get(sourceId);
      if (!source) return;

      source.getChapterList(slug).then((chapters) => {
        // Bail if session changed (user re-opened modal)
        if (this.searchOrchestrator.searchSessionId !== sessionId) return;        this.chapterCountCache.set(cacheKey, chapters.length);
        if (item.isConnected) {
          loadingSpan.remove();
          this.renderChapterCountBadge(sourceSpan as HTMLElement, chapters.length);
        }
        this.scheduleResort();
      }).catch(() => {
        if (loadingSpan.isConnected) {
          loadingSpan.remove();
        }
      });
    });
  }

  private renderChapterCountBadge(sourceSpan: HTMLElement, count: number): void {
    if (sourceSpan.querySelector('.cr-chapter-count')) return;
    const badge = document.createElement('span');
    badge.className = 'cr-chapter-count';
    badge.textContent = `${count} ch.`;
    sourceSpan.appendChild(badge);

    // If count is 0, grey out the card/result
    const card = sourceSpan.closest('.cr-result-item, .cr-grid-card');
    if (card && count === 0) {
      card.classList.add('cr-no-chapters');
      const selectBtn = card.querySelector('.cr-result-select') as HTMLButtonElement | null;
      if (selectBtn) selectBtn.disabled = true;
    }
  }

  /**
   * Schedule a debounced re-sort of results after chapter counts load.
   * Skips re-sort during searchAll (next accumulation handles it).
   */
  private scheduleResort(): void {
    if (this.searchOrchestrator.isSearchAllRunning) return;
    if (this.resortTimerId !== null) clearTimeout(this.resortTimerId);
    this.resortTimerId = setTimeout(() => {
      this.resortTimerId = null;
      this.searchOrchestrator.resortResults();
      this.reorderResultItems();
    }, 300);
  }

  /**
   * Reorder .cr-result-item DOM nodes to match the current searchResults order
   * with a smooth FLIP animation (First-Last-Invert-Play).
   */
  private reorderResultItems(): void {
    const resultsContainer = document.getElementById('cr-match-results');
    if (!resultsContainer) return;

    const section = resultsContainer.querySelector('.cr-results-section') || resultsContainer;
    const items = Array.from(section.querySelectorAll<HTMLElement>('.cr-result-item'));
    if (items.length <= 1) return;

    const results = this.searchOrchestrator.searchResults;

    // Map DOM items by stable slug:sourceId key
    const itemByKey = new Map<string, HTMLElement>();
    for (const item of items) {
      const key = `${item.dataset.sourceId || ''}:${item.dataset.slug || ''}`;
      itemByKey.set(key, item);
    }

    // Detect if order actually changed
    let orderChanged = false;
    const expectedOrder: HTMLElement[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const sourceId = r.sourceId || this.currentSourceId;
      const key = `${sourceId}:${r.slug}`;
      const item = itemByKey.get(key);
      if (!item) continue;
      expectedOrder.push(item);
      if (items[i] !== item) orderChanged = true;
    }

    // Sync data-index on all items
    this.updateListItemIndices(section);

    if (!orderChanged) return;

    // === FLIP: First — record current positions ===
    const firstRects = new Map<HTMLElement, DOMRect>();
    for (const item of items) {
      firstRects.set(item, item.getBoundingClientRect());
    }

    // === Move DOM nodes to new order ===
    for (const item of expectedOrder) {
      section.appendChild(item);
    }

    // === FLIP: Last + Invert + Play ===
    const movedItems: { el: HTMLElement; deltaY: number }[] = [];
    for (const item of items) {
      const first = firstRects.get(item);
      if (!first) continue;

      const last = item.getBoundingClientRect();
      const deltaY = first.top - last.top;

      if (Math.abs(deltaY) < 1) continue;

      // Invert: snap item to its old visual position (no transition)
      item.style.transition = 'none';
      item.style.transform = `translateY(${deltaY}px)`;
      movedItems.push({ el: item, deltaY });
    }

    if (movedItems.length === 0) return;

    // Force reflow so the browser commits the inverted positions
    void (section as HTMLElement).offsetHeight;

    // Play: animate each item from inverted position to natural position
    for (const { el } of movedItems) {
      el.style.transition = 'transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1)';
      el.style.transform = '';
    }

    // Clean up inline styles after the longest animation finishes
    const cleanup = () => {
      for (const { el } of movedItems) {
        el.style.transition = '';
        el.style.transform = '';
      }
    };
    movedItems[movedItems.length - 1].el.addEventListener('transitionend', cleanup, { once: true });
    // Fallback in case transitionend doesn't fire (e.g. element removed)
    setTimeout(cleanup, 350);
  }

  /**
   * Select a result
   */
  private async selectResult(index: number): Promise<void> {
    const result = this.searchOrchestrator.searchResults[index];    if (!result || !this.pageData) return;

    const sourceId = result.sourceId || this.currentSourceId;

    // Save the mapping
    await sourceMappingManager.setSource(
      this.pageData.slug,
      this.pageData.title,
      sourceId,
      {
        slug: result.slug,
        baseSlug: result.slug.replace(/-\d+$/, ''),
        title: result.title,
        available: true,
        lastChecked: Date.now(),
      },
      true // Set as selected source
    );

    // Set the source result title as customTitle so the viewer displays what the user selected
    await sourceMappingManager.setCustomTitle(this.pageData.slug, result.title);

    // Persist alternate titles from ComicK for search
    if (this.pageData.alternateTitles?.length) {
      await sourceMappingManager.setAlternateTitles(
        this.pageData.slug,
        this.pageData.alternateTitles
      );
    }

    // Call callback
    this.onSelect?.(sourceId, result);

    // Hide modal
    this.hide();
  }

  /**
   * Get current source name
   */
  private getSourceName(): string {
    const source = sourceRegistry.get(this.currentSourceId);
    return source?.name || this.currentSourceId;
  }

  // --- Host adapter factories ---

  private createContextMenuHost(): ContextMenuHost {
    const self = this;
    return {
      get currentSourceId() { return self.currentSourceId; },
      getSearchResults: () => self.searchOrchestrator.searchResults,
      showDetailsPanel: (result: SearchResult) => self.detailsPanelComponent.showDetailsPanel(result),
    };
  }

  private createDetailsPanelHost(): DetailsPanelHost {
    const self = this;
    return {
      get container() { return self.container; },
      get currentSourceId() { return self.currentSourceId; },
      get thumbnailCache() { return self.thumbnailCache; },
      get chapterCountCache() { return self.chapterCountCache; },
      getSearchResults: () => self.searchOrchestrator.searchResults,
      getAlternateTitles: () => self.pageData?.alternateTitles || [],
      escapeHtml: (text: string) => self.escapeHtml(text),
      getThumbnailSrc: (url: string) => self.getThumbnailSrc(url),
      getSourceNameById: (id: string) => self.getSourceNameById(id),
      selectResult: (result: SearchResult) => {
        const idx = self.searchOrchestrator.searchResults.indexOf(result);
        return idx >= 0 ? self.selectResult(idx) : Promise.resolve();
      },
    };
  }

  private createTitleComboboxHost(): TitleComboboxHost {
    const self = this;
    return {
      get pageData() { return self.pageData; },
      get isManualMode() { return self.isManualMode; },
      get currentSourceId() { return self.currentSourceId; },
      escapeHtml: (text: string) => self.escapeHtml(text),
      search: (query: string) => self.searchOrchestrator.search(query),
    };
  }

  private createGridViewHost(): GridViewHost {
    const self = this;
    return {
      get container() { return self.container; },
      get currentSourceId() { return self.currentSourceId; },
      get chapterCountCache() { return self.chapterCountCache; },
      getSearchResults: () => self.searchOrchestrator.searchResults,
      getSearchSessionId: () => self.searchOrchestrator.searchSessionId,
      isSearchAllRunning: () => self.searchOrchestrator.isSearchAllRunning,
      getCurrentProgress: () => self.searchOrchestrator.currentProgress,
      escapeHtml: (text: string) => self.escapeHtml(text),
      getThumbnailSrc: (url: string) => self.getThumbnailSrc(url),
      getSourceNameById: (id: string) => self.getSourceNameById(id),
      renderResults: () => self.renderResults(),
      renderResultsWithProgress: (container: HTMLElement, phase: number, titleIndex: number, totalTitles: number, currentTitle: string) =>
        self.renderResultsWithProgress(container, phase, titleIndex, totalTitles, currentTitle),
      renderSourceBadges: () => self.renderSourceBadges(),
      onStopSearch: () => {
        self.searchOrchestrator.stopSearchAll();
        self.gridView.finalizeSearch();
      },
      onSkipToManual: () => {
        self.searchOrchestrator.stopSearchAll();
        self.showManualMode();
      },
      proxyThumbnails: (container: HTMLElement) => self.proxyThumbnails(container),
      proxyThumbnailsForElement: (card: HTMLElement) => self.proxyThumbnailsForElement(card),
      loadChapterCounts: (container: HTMLElement) => self.loadChapterCounts(container),
      loadChapterCountForCard: (card: HTMLElement) => self.loadChapterCountForCard(card),
      attachContextMenuHandlers: (container: HTMLElement) => self.contextMenuComponent.attachContextMenuHandlers(container),
      showDetailsPanel: (result: SearchResult) => self.detailsPanelComponent.showDetailsPanel(result),
      getReferenceTitles: () => {
        const titles = new Set<string>();
        if (self.pageData?.title) titles.add(self.pageData.title);
        for (const t of self.titleCombobox.alternateTitles) {
          if (t) titles.add(t);
        }
        return [...titles];
      },
    };
  }

  private createSearchOrchestratorHost(): SearchOrchestratorHost {
    const self = this;
    return {
      get currentSourceId() { return self.currentSourceId; },
      get forcedSourceId() { return self.forcedSourceId; },
      get pageData() { return self.pageData; },
      getAlternateTitles: () => self.titleCombobox.alternateTitles,
      getBestTitleIndex: () => self.titleCombobox.bestTitleIndex,
      isFullscreen: () => self.gridView.isFullscreen,
      getGridView: () => self.gridView,
      getSourceInstance: () => self.getSourceInstance(),
      getSourceInstanceById: (id: string) => self.getSourceInstanceById(id),
      abortAllSources: () => self.abortAllSources(),
      getSourceName: () => self.getSourceName(),
      getSourceNameById: (id: string) => self.getSourceNameById(id),
      getOrderedTitles: () => self.titleCombobox.getOrderedTitles(),
      escapeHtml: (text: string) => self.escapeHtml(text),
      getThumbnailSrc: (url: string) => self.getThumbnailSrc(url),
      renderSourceBadges: () => self.renderSourceBadges(),
      clearThumbnailCache: () => { self.thumbnailCache = new Map(); },
      renderResults: () => self.renderResults(),
      renderResultsWithProgress: (c, p, t, tt, ct) => self.renderResultsWithProgress(c, p, t, tt, ct),
      showError: (c, type, msg, manual) => self.showError(c, type as any, msg, manual),
      showManualMode: () => self.showManualMode(),
      updateExpandButton: () => self.gridView.updateExpandButton(),
      updateLiveFailureCounter: (c) => self.updateLiveFailureCounter(c),
      proxyThumbnails: (c) => self.proxyThumbnails(c),
      loadChapterCounts: (c) => self.loadChapterCounts(c),
      attachContextMenuHandlers: (c) => self.contextMenuComponent.attachContextMenuHandlers(c),
      selectResult: (result: SearchResult) => {
        const idx = self.searchOrchestrator.searchResults.indexOf(result);
        return idx >= 0 ? self.selectResult(idx) : Promise.resolve();
      },
      getChapterCount: (sourceId: string, slug: string) => self.chapterCountCache.get(`${sourceId}:${slug}`),
    };
  }
}

// Export singleton
export const sourceMatchModal = new SourceMatchModal();
