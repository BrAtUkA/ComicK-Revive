import { ComickPageData, ReadingMode, ImageFit, PageInfo, Chapter, SearchResult, GlobalSettings, MangaDetails } from '@/types';
import { ScrollAnchor, settingsManager, readingStateManager, sourceMappingManager, statsManager } from '@/core';
import { statsTracker } from './StatsTracker';
import { KeyboardHandler, debounce, setCacheContext, setEvictionCallback, disableEvictionNotifications, updateCacheSettings, clearImageCache, setCachedUrlResolver, bridgeArePagesInCache, bridgeCacheClearChapter, bridgeSetHttpCacheBypass, bridgeSourceDataClearChapterPages, bridgeSourceDataUpdatePageDimensions } from '@/utils';
import { sourceRegistry } from '@/sources';
import { sourceMatchModal, chapterPicker, modePicker, settingsPanel, showToast, ToolbarTitleCombobox, LoadingOverlay } from './components';
import { BaseReader, VerticalReader, SinglePageReader, DoublePageReader } from './readers';

/**
 * Viewer - Main manga viewer overlay
 * 
 * Manages the full-screen reading experience with:
 * - Multiple reading modes (vertical, single, double)
 * - Scroll position preservation
 * - Keyboard navigation
 * - Toolbar with controls
 */
export class Viewer {
  private container: HTMLElement | null = null;
  private contentArea: HTMLElement | null = null;
  private toolbarElement: HTMLElement | null = null;
  private isOpen: boolean = false;
  private pageData: ComickPageData | null = null;
  
  // Reading state
  private currentMode: ReadingMode = 'vertical';
  private currentFit: ImageFit = 'width';
  private currentZoom: number = 100;
  private currentBgColor: string = '#000000';
  private currentScrollAmount: number = 80;
  private currentScrollSpeed: number = 5;
  private currentChapter: number = 1;
  private pages: PageInfo[] = [];
  private imageElements: HTMLElement[] = [];
  
  // Active reader instance
  private activeReader: BaseReader | null = null;
  
  // Source info
  private currentSourceId: string = 'asura';
  private currentMangaSlug: string = '';  // For dimension cache updates
  private currentChapterSlug: string = '';  // For dimension cache updates
  private chapters: Chapter[] = [];
  
  // Scroll management
  private scrollAnchor: ScrollAnchor;
  private resizeObserver: ResizeObserver | null = null;
  
  // Keyboard
  private keyboard: KeyboardHandler;
  
  // Toolbar state
  private toolbarVisible: boolean = true;
  private toolbarTitleCombobox: ToolbarTitleCombobox | null = null;
  private autoSaveInterval: number | null = null;
  private autoHideEnabled: boolean = false;
  private scrollbarAutoHideEnabled: boolean = false;
  private ignoreTopAreaTrigger: boolean = false;  // Ignore mouse trigger until mouse leaves top area
  private toolbarHideDelay: number = 4000;
  private toolbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  
  // Chapter loading flag - prevents restoring old chapter position
  private isLoadingNewChapter: boolean = false;

  // Skip position restore on initial chapter load (set by "Read This Chapter" button)
  private skipInitialRestore: boolean = false;

  // Force position restore on initial chapter load, overriding the "Remember Reading Position"
  // toggle. Set when the user clicked an explicit "Continue Reading" / "Continue Ch.X" button,
  // OR when "Read This Chapter" was clicked while "Resume on 'Read This Chapter'" is enabled.
  private forceRestoreOnInitialLoad: boolean = false;
  
  // Zoom animation state
  private zoomAnimationId: number | null = null;
  private zoomAnimationStart: number = 0;
  private lastZoomTime: number = 0;
  
  // Position restoration flag - prevents premature progress updates
  private isRestoringPosition: boolean = false;
  
  // Overlay system
  private overlay: LoadingOverlay = new LoadingOverlay();
  private loadTimeout: ReturnType<typeof setTimeout> | null = null;

  // Last chapter counted as "opened" for stats — guards against reloads and
  // retries of the same chapter inflating the count
  private statsCountedChapter: number | null = null;

  // Refetch state - set during reloadChapter, cleared after load completes
  private isRefetching: boolean = false;
  private autoRetryCount: number = 0;
  private static readonly MAX_AUTO_RETRIES = 1;

  // Page lifecycle save handlers
  private boundVisibilityHandler: (() => void) | null = null;
  private boundBeforeUnloadHandler: (() => void) | null = null;

  // Custom overlay scrollbar
  private customScrollbar: HTMLElement | null = null;
  private scrollbarThumb: HTMLElement | null = null;
  private scrollbarTrigger: HTMLElement | null = null;
  private scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollbarDragging: boolean = false;
  private scrollbarDragStartY: number = 0;
  private scrollbarDragStartScrollTop: number = 0;
  private boundScrollbarScrollHandler: (() => void) | null = null;
  private boundScrollbarDragMove: ((e: MouseEvent) => void) | null = null;
  private boundScrollbarDragEnd: ((e: MouseEvent) => void) | null = null;

  // Resize handling - prevents scroll handler from re-capturing anchor mid-resize
  private isHandlingResize: boolean = false;
  private resizeEndTimer: ReturnType<typeof setTimeout> | null = null;

  // Zoom animation - suppresses ResizeObserver during zoom
  private isZooming: boolean = false;

  // Per-manga placeholder dimensions (from mapping, write-once)
  private placeholderWidth: number = 0;
  private placeholderHeight: number = 0;

  // Continuous reading state
  private continuousReadingActive: boolean = false;
  private continuousLoadingChapter: boolean = false;  // Prevents duplicate next chapter loads
  private continuousLoadingPrevChapter: boolean = false;  // Prevents duplicate prev chapter loads

  // Memoized real page-URL fetches that repair cached:// blob misses (see resolveCachedUrl).
  // Keyed by sourceId:mangaSlug:chapterSlug; short TTL keeps ephemeral CDN URLs fresh.
  private cachedUrlFallback: Map<string, { ts: number; pages: Promise<PageInfo[]> }> = new Map();
  private static readonly CACHED_FALLBACK_TTL_MS = 120_000;

  constructor() {
    this.scrollAnchor = new ScrollAnchor();
    this.keyboard = new KeyboardHandler();
    this.setupKeyboardHandlers();
  }

  /**
   * Repair a cached:// blob miss for imageLoader: re-fetch fresh real page URLs from
   * the source (bypassing the cached fast path) and return the URL for the requested
   * page. Memoized per chapter with a short TTL so a burst of misses triggers a single
   * source fetch and ephemeral CDN URLs (e.g. MangaDex MD@Home) stay valid.
   */
  private async resolveCachedUrl(
    sourceId: string,
    mangaSlug: string,
    chapterSlug: string,
    pageIndex: number,
  ): Promise<string | null> {
    const key = `${sourceId}:${mangaSlug}:${chapterSlug}`;
    const now = Date.now();
    let entry = this.cachedUrlFallback.get(key);
    if (!entry || now - entry.ts > Viewer.CACHED_FALLBACK_TTL_MS) {
      const cached = sourceRegistry.getCached(sourceId);
      if (!cached) return null;
      cached.setForceRefreshPages(true); // bypass the cached:// fast path → real URLs
      entry = { ts: now, pages: cached.getChapterPages(mangaSlug, chapterSlug) };
      this.cachedUrlFallback.set(key, entry);
    }
    try {
      const pages = await entry.pages;
      return pages[pageIndex]?.url ?? null;
    } catch (err) {
      this.cachedUrlFallback.delete(key); // allow a retry on the next miss
      console.warn('[Viewer] cached:// fallback fetch failed:', err);
      return null;
    }
  }

  /**
   * Open viewer for a manga
   */
  async open(pageData: ComickPageData): Promise<void> {
    if (this.isOpen) {
      this.close();
    }

    this.pageData = pageData;
    this.isOpen = true;

    // Start reading-time tracking for this session
    this.statsCountedChapter = null;
    statsTracker.start(pageData.slug);

    // Load settings
    const settings = await settingsManager.load();

    // Determine whether to skip position restore:
    // startFromBeginning is set by the "Read This Chapter" button,
    // but the user can override this with the resumePositionOnReadChapter setting
    this.skipInitialRestore = !!pageData.startFromBeginning && !settings.resumePositionOnReadChapter;

    // Force-restore signals from the button intent or from Toggle 2.
    // These override the "Remember Reading Position" master toggle for this single open.
    //  - forceResume: set by explicit "Continue Reading" / "Continue Ch.X" buttons
    //  - startFromBeginning + resumePositionOnReadChapter: user toggled Toggle 2 on,
    //    so "Read This Chapter" should resume too
    this.forceRestoreOnInitialLoad = !!pageData.forceResume ||
      (!!pageData.startFromBeginning && settings.resumePositionOnReadChapter);

    console.log('[Viewer] open() called with startFromBeginning:', pageData.startFromBeginning,
      'forceResume:', pageData.forceResume,
      '→ skipInitialRestore:', this.skipInitialRestore,
      'forceRestoreOnInitialLoad:', this.forceRestoreOnInitialLoad);

    this.currentMode = settings.defaultReadingMode;
    this.currentFit = settings.defaultImageFit;
    this.currentBgColor = settings.backgroundColor;
    this.currentScrollAmount = settings.scrollAmount;
    this.currentScrollSpeed = settings.scrollSpeed;
    this.autoHideEnabled = settings.toolbarAutoHide;
    this.scrollbarAutoHideEnabled = settings.scrollbarAutoHide;
    this.toolbarHideDelay = settings.toolbarHideDelay;
    this.continuousReadingActive = settings.continuousReading;

    // Update cache settings in background
    updateCacheSettings(settings);

    // Register the cached:// repair resolver so blob misses self-heal from the source
    setCachedUrlResolver((sourceId, mangaSlug, chapterSlug, pageIndex) =>
      this.resolveCachedUrl(sourceId, mangaSlug, chapterSlug, pageIndex));

    // Wire up eviction toast notification
    setEvictionCallback((message, details) => {
      showToast(message, {
        details,
        onDismiss: () => {
          disableEvictionNotifications();
          settingsManager.update({ imageCacheEvictionNotifications: false });
        },
      });
    });

    // Invalidate reading state cache to ensure fresh data from storage
    // (important when viewer is opened/closed multiple times)
    readingStateManager.invalidateCache(pageData.slug);

    // Check for saved reading state
    const savedState = await readingStateManager.get(pageData.slug);
    
    // Determine which chapter to open:
    // 1. If overrideChapter is set (from button click), use that
    // 2. Otherwise, if savedState exists, use saved chapter
    // 3. Otherwise, use chapterNumber from page (or default to 1)
    if (pageData.overrideChapter != null) {
      this.currentChapter = pageData.overrideChapter;
      if (savedState) {
        this.currentMode = savedState.readingMode;
        this.currentFit = savedState.imageFit ?? this.currentFit;
        this.currentZoom = this.normalizeZoomLevel(savedState.zoomLevel) ?? this.currentZoom;
      }
    } else if (savedState) {
      this.currentMode = savedState.readingMode;
      this.currentFit = savedState.imageFit ?? this.currentFit;
      this.currentZoom = this.normalizeZoomLevel(savedState.zoomLevel) ?? this.currentZoom;
      this.currentChapter = savedState.currentChapter;
    } else {
      // Note: this.chapters may not be loaded yet, so we store chapterNumber
      // and fall back to null which will be resolved when chapters are loaded
      this.currentChapter = pageData.chapterNumber ?? -1; // -1 means "use first available"
    }

    // Create viewer DOM
    this.createViewerDOM();

    // Update zoom display if not default (loaded from saved state)
    if (this.currentZoom !== 100) {
      this.updateZoomDisplay();
    }

    // Setup resize observer for scroll preservation
    this.setupResizeObserver();

    // Save position when tab becomes hidden or browser closes
    this.boundVisibilityHandler = () => {
      if (document.visibilityState === 'hidden' && this.isOpen) {
        this.savePosition();
      }
    };
    this.boundBeforeUnloadHandler = () => {
      if (this.isOpen) {
        this.savePosition();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
    window.addEventListener('beforeunload', this.boundBeforeUnloadHandler);

    // Attach keyboard handler
    this.keyboard.attach(this.container!);
    this.keyboard.setEnabled(settings.keyboardShortcutsEnabled);

    // Prevent host page scroll — must set on both html and body
    // ComicK sets overflow on <html>, so body alone isn't enough
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    // Show loading overlay immediately (it's already visible from createViewerDOM)
    this.overlay.showLoading('Checking source mapping...');
    
    // Check if we have a source mapping
    const mapping = await sourceMappingManager.get(pageData.slug);

    // Update stored alternate titles if they changed
    if (mapping && pageData.alternateTitles?.length) {
      const stored = mapping.alternateTitles || [];
      if (
        stored.length !== pageData.alternateTitles.length ||
        !pageData.alternateTitles.every(t => stored.includes(t))
      ) {
        await sourceMappingManager.setAlternateTitles(pageData.slug, pageData.alternateTitles);
      }
    }

    // Populate toolbar title combobox with title data
    if (this.toolbarTitleCombobox) {
      const displayTitle = mapping?.customTitle || mapping?.comickTitle || pageData.title;
      this.toolbarTitleCombobox.setTitles({
        displayTitle,
        originalTitle: mapping?.comickTitle || pageData.title,
        alternateTitles: mapping?.alternateTitles || pageData.alternateTitles || [],
      });
    }

    if (!mapping) {
      // No mapping - need to search for manga
      // Note: Content script now enriches pageData with titles before opening viewer
      this.showSourceSearch();
    } else {
      // Have mapping - load chapter
      // Use instance flag (set from pageData.startFromBeginning) for resilience
      await this.loadChapter(this.currentChapter, this.skipInitialRestore);
    }
  }

  /**
   * Close the viewer
   */
  close(): void {
    if (!this.isOpen) return;

    // Save current position before closing
    this.savePosition();

    // Mark chapter as read if the reader reached the end
    if (this.activeReader?.isAtEnd() && this.pages.length > 0) {
      this.markChapterAsRead(this.currentChapter);
    }

    // Stop auto-save
    this.stopAutoSave();

    // Cleanup active reader
    this.activeReader?.destroy();
    this.activeReader = null;

    // Cleanup overlay
    this.overlay.unmount();
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout);
      this.loadTimeout = null;
    }

    // Cleanup toolbar title combobox
    this.toolbarTitleCombobox?.unmount();
    this.toolbarTitleCombobox = null;

    // Cleanup
    if (this.container) {
      this.keyboard.detach(this.container);
    }
    this.resizeObserver?.disconnect();
    if (this.resizeEndTimer !== null) {
      clearTimeout(this.resizeEndTimer);
      this.resizeEndTimer = null;
    }
    this.isHandlingResize = false;
    this.isZooming = false;
    this.placeholderWidth = 0;
    this.placeholderHeight = 0;
    this.cleanupCustomScrollbar();

    // Remove page lifecycle listeners
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundBeforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.boundBeforeUnloadHandler);
      this.boundBeforeUnloadHandler = null;
    }

    // Remove from DOM
    this.container?.remove();
    this.container = null;
    this.contentArea = null;
    this.toolbarElement = null;

    // Restore host page scroll
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    this.isOpen = false;
    this.pageData = null;
    this.pages = [];
    this.imageElements = [];
    this.chapters = [];
    this.currentMangaSlug = '';
    this.currentChapterSlug = '';
    this.continuousReadingActive = false;
    this.continuousLoadingChapter = false;
    this.continuousLoadingPrevChapter = false;

    // Clear cache context and in-memory cache
    setCacheContext(null);
    clearImageCache();
    setCachedUrlResolver(null);
    this.cachedUrlFallback.clear();
    
    // Flush accumulated reading time (tracker keeps its own slug copy)
    void statsTracker.stop();

    // Dispatch close event so content script can re-inject buttons with updated progress
    window.dispatchEvent(new CustomEvent('comick-revive-close'));
  }

  /**
   * Create the viewer DOM structure
   */
  private createViewerDOM(): void {
    // Remove any existing viewer
    document.getElementById('comick-revive-viewer')?.remove();

    this.container = document.createElement('div');
    this.container.id = 'comick-revive-viewer';
    this.container.className = 'cr-viewer';
    this.container.innerHTML = `
      <div class="cr-viewer-toolbar" id="cr-toolbar">
        <div class="cr-toolbar-left">
          <div class="cr-toolbar-title-combobox" id="cr-toolbar-title-combobox"></div>
          <button class="cr-chapter-btn" id="cr-chapter-select">
            <span class="cr-chapter-btn-text">
              <span class="cr-chapter-btn-label">Chapter ${this.currentChapter}</span>
              <span class="cr-chapter-btn-title" id="cr-chapter-btn-title"></span>
            </span>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M7 10l5 5 5-5z"/>
            </svg>
          </button>
        </div>
        <div class="cr-toolbar-right">
          <span class="cr-page-progress" id="cr-progress">1/1</span>
          <div class="cr-zoom-control">
            <button class="cr-zoom-btn" id="cr-zoom-out" title="Zoom Out (-)">−</button>
            <button class="cr-zoom-value" id="cr-zoom-value" title="Reset Zoom (0)">100%</button>
            <button class="cr-zoom-btn" id="cr-zoom-in" title="Zoom In (+)">+</button>
          </div>
          <button class="cr-toolbar-btn" id="cr-mode-btn" title="Reading Mode">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
            </svg>
          </button>
          <div class="cr-toolbar-divider"></div>
          <div class="cr-toolbar-btn-group">
            <button class="cr-toolbar-btn" id="cr-scroll-top-btn" title="Scroll to Top (Home)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                <path d="M12 19V6M7 10l5-5 5 5"/>
              </svg>
            </button>
            <button class="cr-toolbar-btn" id="cr-reload-btn" title="Reload Chapter">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
              </svg>
            </button>
          </div>
          <div class="cr-toolbar-divider"></div>
          <button class="cr-toolbar-btn" id="cr-settings-btn" title="Settings (G)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
          <button class="cr-toolbar-btn cr-close-btn" id="cr-close-btn" title="Close (Esc)">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
          <button class="cr-toolbar-hide-btn" id="cr-toolbar-hide" title="Hide toolbar (T)">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/>
            </svg>
          </button>
        </div>
      </div>
      
      <button class="cr-toolbar-show-btn" id="cr-toolbar-show" title="Show toolbar">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
        </svg>
      </button>
      
      <div class="cr-viewer-content" id="cr-content">
        <!-- Content will be injected here -->
      </div>
    `;

    document.body.appendChild(this.container);

    // Mount overlay into the viewer container
    this.overlay.mount(this.container);

    // Make container focusable and focus it for keyboard events
    this.container.tabIndex = -1;
    this.container.focus();

    // Cache elements
    this.contentArea = document.getElementById('cr-content');
    this.toolbarElement = document.getElementById('cr-toolbar');

    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Click anywhere on container to maintain focus for keyboard events
    this.container?.addEventListener('click', (e) => {
      // Don't steal focus from inputs
      if (!(e.target instanceof HTMLInputElement) && 
          !(e.target instanceof HTMLTextAreaElement)) {
        this.container?.focus();
      }
    });

    // Close button
    document.getElementById('cr-close-btn')?.addEventListener('click', () => this.close());

    // Zoom controls
    document.getElementById('cr-zoom-out')?.addEventListener('click', () => this.zoomOut());
    document.getElementById('cr-zoom-in')?.addEventListener('click', () => this.zoomIn());
    document.getElementById('cr-zoom-value')?.addEventListener('click', () => this.resetZoom());

    // Mode button - opens mode picker
    document.getElementById('cr-mode-btn')?.addEventListener('click', (e) => {
      this.openModePicker(e.currentTarget as HTMLElement);
    });

    // Settings button
    document.getElementById('cr-settings-btn')?.addEventListener('click', () => this.openSettings());

    // Scroll to top button
    document.getElementById('cr-scroll-top-btn')?.addEventListener('click', () => this.scrollToTop());

    // Reload chapter button
    document.getElementById('cr-reload-btn')?.addEventListener('click', () => this.reloadChapter());

    // Chapter select - opens chapter picker
    document.getElementById('cr-chapter-select')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.openChapterPicker();
    });

    // Mount toolbar title combobox
    const titleContainer = document.getElementById('cr-toolbar-title-combobox');
    if (titleContainer) {
      this.toolbarTitleCombobox = new ToolbarTitleCombobox();
      this.toolbarTitleCombobox.setCallbacks({
        onSave: async (customTitle) => {
          if (this.pageData) {
            await sourceMappingManager.setCustomTitle(this.pageData.slug, customTitle);
          }
        },
        onKeyboardDisable: () => this.keyboard.setEnabled(false),
        onKeyboardRestore: async () => {
          const settings = await settingsManager.load();
          this.keyboard.setEnabled(settings.keyboardShortcutsEnabled);
          this.container?.focus();
        },
      });
      this.toolbarTitleCombobox.mount(titleContainer);
      this.toolbarTitleCombobox.updateDisplayTitle(this.pageData?.title || 'Unknown');
    }

    // Toolbar hide/show buttons
    document.getElementById('cr-toolbar-hide')?.addEventListener('click', () => {
      this.hideToolbar();
      // Ignore top area trigger until mouse leaves the area
      this.ignoreTopAreaTrigger = true;
    });
    document.getElementById('cr-toolbar-show')?.addEventListener('click', () => this.showToolbar());

    // Retry button delegation — catches .cr-retry-page clicks from any reader
    this.contentArea?.addEventListener('click', (e) => {
      const retryBtn = (e.target as HTMLElement).closest('.cr-retry-page') as HTMLElement;
      if (retryBtn && this.activeReader) {
        const index = parseInt(retryBtn.dataset.index || '-1');
        if (index >= 0) {
          this.handlePageRetry(index);
        }
      }
    });

    // Scroll tracking for progress and auto-hide
    this.contentArea?.addEventListener('scroll', () => {
      // Suppress all scroll handling during chapter transitions and position restoration
      if (this.isLoadingNewChapter || this.isRestoringPosition) return;

      // Update page counter immediately for real-time feedback
      this.updateProgress();

      // Debounced position capture (avoids excessive storage writes)
      this.debouncedPositionCapture();

      // Keep scroll anchor updated for ResizeObserver restoration
      // Skip during resize to prevent capturing a corrupted mid-reflow position
      if (this.contentArea && this.imageElements.length > 0 && !this.isHandlingResize) {
        this.scrollAnchor.capture(this.contentArea, this.imageElements);
      }

      // Auto-hide: hide toolbar on scroll, but keep it visible at the top
      if (this.autoHideEnabled) {
        if (this.contentArea && this.contentArea.scrollTop <= 5) {
          // At the top — ensure toolbar stays visible (no hide timer)
          if (!this.toolbarVisible) {
            this.showToolbar();
          }
          this.cancelToolbarHide();
        } else if (this.toolbarVisible) {
          this.hideToolbar();
        }
      }
    });
    
    // Mouse enter top strip (60px) to show toolbar when auto-hide enabled
    this.container?.addEventListener('mousemove', (e) => {
      if (this.autoHideEnabled) {
        const rect = this.container!.getBoundingClientRect();
        const mouseY = e.clientY - rect.top;
        const inTopArea = mouseY <= 60;
        
        // If mouse left the top area, reset the ignore flag
        if (!inTopArea && this.ignoreTopAreaTrigger) {
          this.ignoreTopAreaTrigger = false;
        }
        
        // Show toolbar if in top area and not ignoring
        if (inTopArea && !this.toolbarVisible && !this.ignoreTopAreaTrigger) {
          this.showToolbar();
          this.scheduleToolbarHide();
        }
      }
    });

    // Toolbar hover — cancel hide while hovering, schedule hide on leave
    this.toolbarElement?.addEventListener('mouseenter', () => {
      if (this.autoHideEnabled) {
        this.cancelToolbarHide();
      }
    });
    this.toolbarElement?.addEventListener('mouseleave', () => {
      if (this.autoHideEnabled && this.toolbarVisible) {
        this.scheduleToolbarHide();
      }
    });

    // Custom scrollbar setup
    this.setupCustomScrollbar();
  }

  /**
   * Setup keyboard handlers
   */
  private setupKeyboardHandlers(): void {
    this.keyboard.on('close', () => this.close());
    this.keyboard.on('prevPage', () => this.prevPage());
    this.keyboard.on('nextPage', () => this.nextPage());
    this.keyboard.on('prevChapter', () => this.prevChapter());
    this.keyboard.on('nextChapter', () => this.nextChapter());
    this.keyboard.on('scrollDown', () => this.scrollDown());
    this.keyboard.on('scrollUp', () => this.scrollUp());
    this.keyboard.on('fullscreen', () => this.toggleFullscreen());
    this.keyboard.on('settings', () => this.openSettings());
    this.keyboard.on('toggleToolbar', () => this.toggleToolbar());
    this.keyboard.on('scrollToTop', () => this.scrollToTop());
    this.keyboard.on('modeVertical', () => this.setMode('vertical'));
    this.keyboard.on('modeSingle', () => this.setMode('single'));
    this.keyboard.on('modeDouble', () => this.setMode('double'));
    this.keyboard.on('zoomIn', () => this.zoomIn());
    this.keyboard.on('zoomOut', () => this.zoomOut());
    this.keyboard.on('zoomReset', () => this.resetZoom());

    // Hold-to-scroll: continuous scroll while key is held
    this.keyboard.on('holdStart:nextPage' as any, () => this.activeReader?.startContinuousScroll(1));
    this.keyboard.on('holdStart:prevPage' as any, () => this.activeReader?.startContinuousScroll(-1));
    this.keyboard.on('holdStart:scrollDown' as any, () => this.activeReader?.startContinuousScroll(1));
    this.keyboard.on('holdStart:scrollUp' as any, () => this.activeReader?.startContinuousScroll(-1));
    this.keyboard.on('holdEnd:nextPage' as any, () => this.activeReader?.stopContinuousScroll());
    this.keyboard.on('holdEnd:prevPage' as any, () => this.activeReader?.stopContinuousScroll());
    this.keyboard.on('holdEnd:scrollDown' as any, () => this.activeReader?.stopContinuousScroll());
    this.keyboard.on('holdEnd:scrollUp' as any, () => this.activeReader?.stopContinuousScroll());
  }

  /**
   * Setup resize observer for scroll preservation.
   *
   * ResizeObserver fires between layout and paint, so restoring scrollTop
   * synchronously inside the callback corrects the position before the
   * browser ever paints the shifted frame — zero flicker.
   */
  private setupResizeObserver(): void {
    if (!this.contentArea) return;

    this.resizeObserver = new ResizeObserver(() => {
      // Skip during managed layout transitions
      if (this.isRestoringPosition || this.isLoadingNewChapter || this.isZooming) return;
      if (this.imageElements.length === 0 || !this.contentArea) return;

      // The scroll handler continuously updates the anchor on every scroll event.
      // We do NOT re-capture here because ResizeObserver fires AFTER layout has
      // already changed, so capture() would read post-resize geometry and produce
      // a corrupted anchor. For sudden resizes (window snap, maximize, DevTools),
      // the browser adjusts scrollTop before the observer fires, so capturing here
      // would lock in the wrong position.
      //
      // Edge case: if no scroll event has happened yet (user hasn't scrolled),
      // the anchor is null — capture once so restore has something to work with.
      if (!this.scrollAnchor.getAnchor()) {
        this.scrollAnchor.capture(this.contentArea, this.imageElements);
      }

      // Lock out scroll handler from re-capturing during the resize sequence
      this.isHandlingResize = true;

      // Restore synchronously — ResizeObserver fires after layout but before
      // paint, so this corrects scrollTop before the user sees anything.
      this.scrollAnchor.restore(this.contentArea, this.imageElements);

      // Reset the "resize ended" debounce timer.
      // When no observer fires for 150ms, the resize sequence is over.
      if (this.resizeEndTimer !== null) {
        clearTimeout(this.resizeEndTimer);
      }
      this.resizeEndTimer = setTimeout(() => {
        this.resizeEndTimer = null;
        // Unlock scroll handler — it will resume updating the anchor on scroll
        this.isHandlingResize = false;
      }, 150);
    });

    this.resizeObserver.observe(this.contentArea);
  }

  /**
   * Hide toolbar
   */
  private hideToolbar(): void {
    this.toolbarVisible = false;
    this.toolbarElement?.classList.add('hidden');
    // Only show reveal button if auto-hide is disabled (user manually hid it)
    if (!this.autoHideEnabled) {
      document.getElementById('cr-toolbar-show')?.classList.add('visible');
    }
  }

  /**
   * Show toolbar
   */
  private showToolbar(): void {
    this.cancelToolbarHide();
    this.toolbarVisible = true;
    this.toolbarElement?.classList.remove('hidden');
    document.getElementById('cr-toolbar-show')?.classList.remove('visible');
  }

  /**
   * Schedule toolbar hide after delay (for autohide mode)
   */
  private scheduleToolbarHide(): void {
    this.cancelToolbarHide();
    this.toolbarHideTimer = setTimeout(() => {
      this.toolbarHideTimer = null;
      // Never auto-hide while at the top of the page
      if (this.contentArea && this.contentArea.scrollTop <= 5) return;
      if (this.toolbarVisible && this.autoHideEnabled) {
        this.hideToolbar();
      }
    }, this.toolbarHideDelay);
  }

  /**
   * Cancel any pending toolbar hide timer
   */
  private cancelToolbarHide(): void {
    if (this.toolbarHideTimer !== null) {
      clearTimeout(this.toolbarHideTimer);
      this.toolbarHideTimer = null;
    }
  }

  /**
   * Toggle toolbar visibility (for keyboard shortcut)
   */
  private toggleToolbar(): void {
    if (this.toolbarVisible) {
      this.hideToolbar();
    } else {
      this.showToolbar();
    }
  }

  /**
   * Setup custom overlay scrollbar — always created, autohide only controls visibility behavior
   */
  private setupCustomScrollbar(): void {
    // Clean up any existing custom scrollbar
    this.cleanupCustomScrollbar();

    if (!this.contentArea || !this.container) return;

    // Create custom scrollbar DOM
    this.scrollbarTrigger = document.createElement('div');
    this.scrollbarTrigger.className = 'cr-custom-scrollbar-trigger';

    this.customScrollbar = document.createElement('div');
    this.customScrollbar.className = 'cr-custom-scrollbar';
    this.customScrollbar.innerHTML = `
      <div class="cr-custom-scrollbar-track">
        <div class="cr-custom-scrollbar-thumb"></div>
      </div>
    `;

    this.scrollbarThumb = this.customScrollbar.querySelector('.cr-custom-scrollbar-thumb');

    // Insert into container (not contentArea, so it doesn't scroll with content)
    this.container.appendChild(this.scrollbarTrigger);
    this.container.appendChild(this.customScrollbar);

    // Update thumb size/position on scroll
    this.boundScrollbarScrollHandler = () => this.updateScrollbarThumb();
    this.contentArea.addEventListener('scroll', this.boundScrollbarScrollHandler);

    if (this.scrollbarAutoHideEnabled) {
      // Autohide mode: show/hide on hover with fade transitions
      this.scrollbarTrigger.addEventListener('mouseenter', () => {
        this.showScrollbar();
      });

      this.customScrollbar.addEventListener('mouseenter', () => {
        this.showScrollbar();
      });

      this.scrollbarTrigger.addEventListener('mouseleave', (e) => {
        if (e.relatedTarget && this.customScrollbar?.contains(e.relatedTarget as Node)) return;
        this.scheduleScrollbarHide();
      });

      this.customScrollbar.addEventListener('mouseleave', (e) => {
        if (e.relatedTarget && this.scrollbarTrigger?.contains(e.relatedTarget as Node)) return;
        if (this.scrollbarDragging) return;
        this.scheduleScrollbarHide();
      });
    } else {
      // Always-visible mode: no hover/fade behavior, scrollbar is permanently shown
      this.customScrollbar.classList.add('cr-scrollbar-always-visible');
    }

    // Thumb drag (both modes)
    this.scrollbarThumb?.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.contentArea) return;
      this.scrollbarDragging = true;
      this.scrollbarDragStartY = e.clientY;
      this.scrollbarDragStartScrollTop = this.contentArea.scrollTop;
      this.scrollbarThumb?.classList.add('cr-scrollbar-dragging');

      this.boundScrollbarDragMove = (moveEvent: MouseEvent) => {
        if (!this.contentArea || !this.customScrollbar) return;
        const trackHeight = this.customScrollbar.clientHeight;
        const contentScrollable = this.contentArea.scrollHeight - this.contentArea.clientHeight;
        if (contentScrollable <= 0 || trackHeight <= 0) return;
        const deltaY = moveEvent.clientY - this.scrollbarDragStartY;
        const scrollDelta = (deltaY / trackHeight) * contentScrollable;
        this.contentArea.scrollTop = this.scrollbarDragStartScrollTop + scrollDelta;
      };

      this.boundScrollbarDragEnd = () => {
        this.scrollbarDragging = false;
        this.scrollbarThumb?.classList.remove('cr-scrollbar-dragging');
        if (this.boundScrollbarDragMove) {
          document.removeEventListener('mousemove', this.boundScrollbarDragMove);
        }
        if (this.boundScrollbarDragEnd) {
          document.removeEventListener('mouseup', this.boundScrollbarDragEnd);
        }
        this.boundScrollbarDragMove = null;
        this.boundScrollbarDragEnd = null;
        // If autohide and mouse is no longer over the trigger/scrollbar region, hide
        if (this.scrollbarAutoHideEnabled) {
          this.scheduleScrollbarHide();
        }
      };

      document.addEventListener('mousemove', this.boundScrollbarDragMove);
      document.addEventListener('mouseup', this.boundScrollbarDragEnd);
    });

    // Initial thumb positioning
    this.updateScrollbarThumb();
  }

  /**
   * Update custom scrollbar thumb size and position
   */
  private updateScrollbarThumb(): void {
    if (!this.contentArea || !this.scrollbarThumb || !this.customScrollbar) return;

    const { scrollTop, scrollHeight, clientHeight } = this.contentArea;
    if (scrollHeight <= clientHeight) {
      // No overflow — hide scrollbar entirely
      this.customScrollbar.style.display = 'none';
      this.scrollbarTrigger && (this.scrollbarTrigger.style.display = 'none');
      return;
    }

    this.customScrollbar.style.display = '';
    this.scrollbarTrigger && (this.scrollbarTrigger.style.display = '');

    const trackHeight = this.customScrollbar.clientHeight;
    const thumbHeight = Math.max(30, (clientHeight / scrollHeight) * trackHeight);
    const maxThumbTop = trackHeight - thumbHeight;
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    const thumbTop = scrollRatio * maxThumbTop;

    this.scrollbarThumb.style.height = `${thumbHeight}px`;
    this.scrollbarThumb.style.top = `${thumbTop}px`;
  }

  /**
   * Show custom scrollbar (cancel any pending hide)
   */
  private showScrollbar(): void {
    if (this.scrollbarHideTimer !== null) {
      clearTimeout(this.scrollbarHideTimer);
      this.scrollbarHideTimer = null;
    }
    this.customScrollbar?.classList.add('cr-scrollbar-visible');
  }

  /**
   * Schedule custom scrollbar hide after a delay
   */
  private scheduleScrollbarHide(): void {
    if (this.scrollbarHideTimer !== null) return;
    this.scrollbarHideTimer = setTimeout(() => {
      this.scrollbarHideTimer = null;
      if (!this.scrollbarDragging) {
        this.customScrollbar?.classList.remove('cr-scrollbar-visible');
      }
    }, 1500);
  }

  /**
   * Cleanup custom scrollbar
   */
  private cleanupCustomScrollbar(): void {
    // Remove scroll listener
    if (this.boundScrollbarScrollHandler && this.contentArea) {
      this.contentArea.removeEventListener('scroll', this.boundScrollbarScrollHandler);
    }
    this.boundScrollbarScrollHandler = null;

    // Remove drag listeners
    if (this.boundScrollbarDragMove) {
      document.removeEventListener('mousemove', this.boundScrollbarDragMove);
    }
    if (this.boundScrollbarDragEnd) {
      document.removeEventListener('mouseup', this.boundScrollbarDragEnd);
    }
    this.boundScrollbarDragMove = null;
    this.boundScrollbarDragEnd = null;

    // Remove DOM elements
    this.customScrollbar?.remove();
    this.scrollbarTrigger?.remove();
    this.customScrollbar = null;
    this.scrollbarThumb = null;
    this.scrollbarTrigger = null;

    // Clear timer
    if (this.scrollbarHideTimer !== null) {
      clearTimeout(this.scrollbarHideTimer);
      this.scrollbarHideTimer = null;
    }

    this.scrollbarDragging = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Debounced position capture (keeps storage writes throttled)
   */
  private debouncedPositionCapture = debounce(() => {
    this.savePosition();
  }, 500);

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Central completion handler for all chapter load paths.
   * Hides overlay, shows content, and finalizes the load.
   */
  private completeChapterLoad(): void {
    if (!this.isLoadingNewChapter) return; // Already completed (cached path or race)
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout);
      this.loadTimeout = null;
    }
    this.showContentArea();
    // Force the browser to acknowledge the scroll position set while hidden.
    // Re-applying scrollTop after visibility change ensures the scrollbar thumb
    // reflects the actual position.
    if (this.contentArea) {
      const st = this.contentArea.scrollTop;
      // Force reflow between visibility change and scroll position re-apply
      void this.contentArea.offsetHeight;
      this.contentArea.scrollTop = st;
    }
    requestAnimationFrame(() => {
      this.overlay.hide();
      this.updateProgress();
    });
    this.finishChapterLoad();

    // After chapter load completes (including position restore), eagerly load adjacent chapters
    this.loadAdjacentChaptersContinuous();
  }

  /**
   * Hide content area visually (used during chapter load to prevent flicker)
   */
  private hideContentArea(): void {
    if (this.contentArea) {
      this.contentArea.style.visibility = 'hidden';
    }
  }

  /**
   * Show content area (after scroll position is set)
   */
  private showContentArea(): void {
    if (this.contentArea) {
      this.contentArea.style.visibility = 'visible';
    }
  }

  /**
   * Show source search UI - uses the SourceMatchModal
   */
  private showSourceSearch(): void {
    if (!this.contentArea || !this.pageData) return;

    // Show modal for source matching
    sourceMatchModal.show(
      this.pageData,
      async (sourceId: string, result: SearchResult) => {
        // User selected a match
        this.currentSourceId = sourceId;

        // Update toolbar title to the source result title
        this.toolbarTitleCombobox?.updateDisplayTitle(result.title);

        // Show loading while we fetch chapters
        this.overlay.showLoading('Loading chapters...');

        try {
          const source = sourceRegistry.get(sourceId);
          if (!source) {
            throw new Error('Source not found');
          }

          // Load chapters
          this.chapters = await source.getChapterList(result.slug);

          if (this.chapters.length === 0) {
            this.overlay.showError('No chapters found for this manga', () => this.loadChapter(this.currentChapter));
            return;
          }

          // Update chapter dropdown
          this.updateChapterDropdown();

          // Find the matching chapter if user came from a specific chapter page
          // Default to first chapter in the list (sorted ascending), not hardcoded 1
          const sortedChapters = [...this.chapters].sort((a, b) => a.number - b.number);
          let targetChapter = sortedChapters[0]?.number ?? 1;
          if (this.pageData?.chapterNumber != null) {
            // Try to find matching chapter
            const match = this.chapters.find(c => c.number === this.pageData?.chapterNumber);
            if (match) {
              targetChapter = match.number;
            }
          }

          // Load the chapter
          await this.loadChapter(targetChapter);
        } catch (error) {
          this.overlay.showError(`Failed to load: ${(error as Error).message}`, () => this.loadChapter(this.currentChapter));
        }
      },
      () => {
        // User cancelled - close viewer
        this.close();
      }
    );

    // Show waiting state in content area
    this.contentArea.innerHTML = `
      <div class="cr-waiting">
        <p>Select a manga from the search results...</p>
      </div>
    `;
  }

  /**
   * Search source for manga - deprecated, using modal now
   */
  private async _searchSource(_query: string): Promise<void> {
    // Redirected to modal
    this.showSourceSearch();
  }

  /**
   * Update chapter dropdown with chapters list
   */
  private updateChapterDropdown(): void {
    // Chapter button is now a modal trigger, just update its display text
    this.updateChapterButton();
  }

  /**
   * Load chapter content
   * @param chapterNum - Chapter number to load
   * @param skipRestore - If true, start from beginning instead of restoring saved position
   */
  async loadChapter(chapterNum: number, skipRestore: boolean = false): Promise<void> {
    if (!this.pageData) return;

    console.log('[Viewer] loadChapter called:', { chapterNum, skipRestore });

    // Mark that we're loading a new chapter (prevents renderPages from restoring old position)
    this.isLoadingNewChapter = true;
    this.autoRetryCount = 0;

    // Clear stale state from any previous in-flight load. Rapid chapter switches can
    // leave these flags set when the prior reader was destroyed before its callbacks
    // fired (e.g., restoring position when the user picks a different chapter mid-restore).
    // Without this reset:
    //  - isRestoringPosition stuck true → scroll handler suppresses updateProgress() → counter freezes
    //  - continuousLoading* stuck true → next loadAdjacentChaptersContinuous() early-returns → no eager preload
    this.isRestoringPosition = false;
    this.continuousLoadingChapter = false;
    this.continuousLoadingPrevChapter = false;

    this.currentChapter = chapterNum;

    if (this.statsCountedChapter !== chapterNum) {
      this.statsCountedChapter = chapterNum;
      void statsManager.recordChapterOpened(this.pageData.slug);
    }

    // Show subtle dark backdrop for smooth transition between chapters.
    // If uncached, this gets upgraded to full spinner via showLoading() after cache check.
    // If refetching, reloadChapter() already showed the full loading overlay.
    if (!this.isRefetching) {
      this.overlay.showTransition();
      this.hideContentArea();
    }

    try {
      // Get source mapping
      const mapping = await sourceMappingManager.get(this.pageData.slug);
      if (!mapping) {
        this.showSourceSearch();
        return;
      }

      const selectedSource = await sourceMappingManager.getSelectedSource(this.pageData.slug);
      if (!selectedSource) {
        this.showSourceSearch();
        return;
      }

      this.currentSourceId = selectedSource.sourceId;
      const sourceInfo = selectedSource.sourceInfo;

      // Load per-source placeholder dimensions (refreshes on source switch)
      this.placeholderWidth = sourceInfo.placeholderWidth || 0;
      this.placeholderHeight = sourceInfo.placeholderHeight || 0;

      // Get source
      let source = sourceRegistry.get(this.currentSourceId);
      if (!source) {
        // User sources register asynchronously; make sure they're loaded
        // before concluding the source is actually gone
        await sourceRegistry.loadUserSources();
        source = sourceRegistry.get(this.currentSourceId);
      }
      if (!source) {
        // The linked source was removed (e.g. a deleted user source). Stop
        // here instead of proceeding into cached page URLs, which would fire
        // a doomed image fetch per page and spam the extension error log.
        this.overlay.showError(
          `This manga is linked to "${this.currentSourceId}", a source that is no longer installed. Re-add it in the dashboard, or pick a different source.`,
          () => this.showSourceSearch()
        );
        return;
      }

      // Load chapters if we don't have them
      if (this.chapters.length === 0) {
        this.chapters = await source.getChapterList(sourceInfo.slug);
        this.updateChapterDropdown();
      }

      // Resolve sentinel -1 to first chapter in the list
      if (chapterNum === -1) {
        if (this.chapters.length === 0) {
          throw new Error('No chapters available from this source');
        }
        const sortedChapters = [...this.chapters].sort((a, b) => a.number - b.number);
        chapterNum = sortedChapters[0].number;
        this.currentChapter = chapterNum;
        this.updateChapterButton();
      }

      // Find the chapter
      const chapter = this.chapters.find(c => c.number === chapterNum);
      if (!chapter) {
        throw new Error(`Chapter ${chapterNum} not found. Available: ${this.chapters.map(c => c.number).join(', ')}`);
      }

      // Set cache context for this chapter
      setCacheContext({
        sourceId: this.currentSourceId,
        mangaSlug: sourceInfo.slug,
        chapterSlug: chapter.slug,
      });

      // Store slugs for dimension cache updates
      this.currentMangaSlug = sourceInfo.slug;
      this.currentChapterSlug = chapter.slug;

      // Get pages (and start fetching previous chapter in parallel for continuous reading)
      const isContinuous = this.continuousReadingActive && this.currentMode === 'vertical';
      let prevChapterFetch: Promise<Array<{
        chapter: Chapter;
        pages: PageInfo[];
        cacheContext: { sourceId: string; mangaSlug: string; chapterSlug: string };
        isFirst: boolean;
      }>> | null = null;

      if (isContinuous) {
        // Start fetching previous chapter in parallel with main chapter
        prevChapterFetch = this.fetchPrevChapterPages(source, sourceInfo.slug, chapterNum);
      }

      this.pages = await source.getChapterPages(sourceInfo.slug, chapter.slug);

      if (this.pages.length === 0) {
        throw new Error('No pages found for this chapter');
      }

      // Await pre-fetched previous chapter (started in parallel above)
      const preloadedPrevChapters = prevChapterFetch ? await prevChapterFetch : [];

      // Mark chapter as read on open if setting is enabled
      const settings = await settingsManager.load();
      if (settings.markReadMode === 'onOpen') {
        this.markChapterAsRead(chapterNum);
      }

      // Determine if we need position restore
      let chapterPosition = null;
      let needsPositionRestore = false;

      if (!skipRestore) {
        chapterPosition = await readingStateManager.getChapterPosition(
          this.pageData.slug,
          this.currentSourceId,
          this.currentChapter
        );

        const hasNonZeroPosition = chapterPosition &&
          (chapterPosition.anchorImageIndex > 0 || chapterPosition.anchorImageOffset > 0);

        // Restore if: there's something to restore AND either
        //  - the "Remember Reading Position" master toggle is on, OR
        //  - this load was triggered by an explicit-resume button / Toggle 2 override
        //    (consumed once — only applies to the initial open's first loadChapter call)
        needsPositionRestore = !!(hasNonZeroPosition &&
          (settings.rememberPerChapterPosition || this.forceRestoreOnInitialLoad));
      }

      // Consume the force-restore flag after the first loadChapter call so subsequent
      // chapter switches (picker, continuous, etc.) respect the master toggle normally.
      this.forceRestoreOnInitialLoad = false;

      console.log('[Viewer] Position restore check:', {
        needsPositionRestore,
        chapterPosition: chapterPosition ? {
          anchorImageIndex: chapterPosition.anchorImageIndex,
          anchorImageOffset: chapterPosition.anchorImageOffset
        } : null
      });

      // Progress label for overlay (refetch: immediate, normal: after 2s)
      const progressLabel = this.isRefetching
        ? `Refetching Chapter ${chapterNum}`
        : `Loading Chapter ${chapterNum}`;

      if (needsPositionRestore && chapterPosition) {
        // ══ RESTORE PATH ══ Need to load anchor images before showing content

        // Check if anchor pages are cached — if not, upgrade transition to full spinner
        if (!this.isRefetching) {
          const ANCHOR_BUFFER = 3;
          const targetIndex = Math.min(chapterPosition.anchorImageIndex + ANCHOR_BUFFER, this.pages.length - 1);
          const pageIndicesToCheck = Array.from({ length: targetIndex + 1 }, (_, i) => i);
          const pagesAreCached = await bridgeArePagesInCache(
            this.currentSourceId, sourceInfo.slug, chapter.slug, pageIndicesToCheck
          );
          if (!pagesAreCached) {
            this.overlay.showLoading(`Loading Chapter ${chapterNum}...`);
          }
        }

        // Enable progress AFTER showLoading (which clears all timers)
        this.overlay.enableProgress(progressLabel, this.isRefetching ? 0 : 2000);

        this.renderPages({ preloadedPrevChapters });
        this.updateModeButtonIcon();
        this.updateChapterButton();

        // Set progress based on expected restore position (offset by preloaded pages)
        const preloadedPageCount = preloadedPrevChapters.reduce((sum, ch) => sum + ch.pages.length, 0);
        const progressEl = document.getElementById('cr-progress');
        if (progressEl) {
          progressEl.textContent = `${chapterPosition.anchorImageIndex + 1}/${this.pages.length - preloadedPageCount}`;
        }

        // Do the position restore (position is offset by preloaded pages — handled in restoreSavedPosition)
        await this.restoreSavedPosition();

      } else {
        // ══ FAST PATH ══ Starting from beginning with sequential loading
        console.log('[Viewer] Fast path: no position to restore');

        // Check if first pages are cached — if not, upgrade transition to full spinner
        if (!this.isRefetching) {
          const pagesToCheck = Math.min(4, this.pages.length);
          const pageIndicesToCheck = Array.from({ length: pagesToCheck }, (_, i) => i);
          const pagesAreCached = await bridgeArePagesInCache(
            this.currentSourceId, sourceInfo.slug, chapter.slug, pageIndicesToCheck
          );
          if (!pagesAreCached) {
            this.overlay.showLoading(`Loading Chapter ${chapterNum}...`);
          }
        }

        // Enable progress AFTER showLoading (which clears all timers)
        this.overlay.enableProgress(progressLabel, this.isRefetching ? 0 : 2000);

        this.renderPages({ sequentialLoading: true, preloadedPrevChapters });
        this.updateModeButtonIcon();

        // Ensure scroll is at top (content is still hidden via visibility:hidden)
        if (this.contentArea) {
          this.contentArea.scrollTop = 0;
        }

        // Wire up onAnchorImagesReady as the universal "content ready" signal
        if (this.activeReader) {
          this.activeReader.onAnchorImagesReady = () => {
            this.completeChapterLoad();
          };
          this.activeReader.onRestoreProgress = (loaded, total) => {
            this.overlay.updateProgress(loaded, total);
          };
          // Use restorePosition to trigger anchor-based readiness for all readers
          // Offset by preloaded pages so we start at the main chapter, not the preloaded one
          const startIndex = (this.continuousReadingActive && this.activeReader instanceof VerticalReader)
            ? (this.activeReader as VerticalReader).getPreloadedPageCount()
            : 0;
          this.activeReader.restorePosition({
            anchorImageIndex: startIndex,
            anchorImageOffset: 0,
            scrollTop: 0,
            viewportHeight: this.contentArea?.clientHeight || 0,
            timestamp: Date.now(),
          });
        }

        // Set progress (exclude preloaded pages from count)
        const fastPathPreloadCount = preloadedPrevChapters.reduce((sum, ch) => sum + ch.pages.length, 0);
        const progressEl = document.getElementById('cr-progress');
        if (progressEl) {
          progressEl.textContent = `1/${this.pages.length - fastPathPreloadCount}`;
        }

        // Update chapter button display
        this.updateChapterButton();
      }

      // Unified timeout fallback for all load paths
      const timeoutMs = this.isRefetching ? 60000 : 30000;
      this.loadTimeout = setTimeout(() => {
        if (this.isLoadingNewChapter) {
          if (this.shouldAutoRetry()) {
            this.autoRetryCount++;
            this.performAutoRetry();
          } else {
            console.log('[Viewer] Load timeout - showing content');
            this.completeChapterLoad();
          }
        }
      }, timeoutMs);

    } catch (error) {
      console.error('Failed to load chapter:', error);
      this.isLoadingNewChapter = false;
      if (this.isRefetching) {
        bridgeSetHttpCacheBypass(false).catch(() => {});
      }
      this.isRefetching = false;
      this.overlay.showError(
        `Failed to load chapter: ${(error as Error).message}`,
        () => this.loadChapter(this.currentChapter)
      );
    }
  }

  /**
   * Finalize chapter load: clear loading flag, start auto-save, refocus.
   * Called from completeChapterLoad() which is the single convergence point.
   */
  private finishChapterLoad(): void {
    this.isLoadingNewChapter = false;
    // Disable HTTP cache bypass if it was enabled for refetch
    if (this.isRefetching) {
      bridgeSetHttpCacheBypass(false).catch(() => {});
    }
    this.isRefetching = false;
    this.startAutoSave();
    this.container?.focus();
  }

  /**
   * Restore saved reading position.
   * Called only when we definitely have a non-zero position to restore.
   */
  private async restoreSavedPosition(): Promise<void> {
    if (!this.pageData || !this.contentArea || !this.activeReader) return;

    // Get the position (we already know it exists and is non-zero from loadChapter)
    const chapterPosition = await readingStateManager.getChapterPosition(
      this.pageData.slug,
      this.currentSourceId,
      this.currentChapter
    );

    if (!chapterPosition) {
      console.error('[Viewer] restoreSavedPosition called but no position found');
      return;
    }

    console.log('[Viewer] restoreSavedPosition:', {
      currentChapter: this.currentChapter,
      anchorImageIndex: chapterPosition.anchorImageIndex,
      anchorImageOffset: chapterPosition.anchorImageOffset
    });

    // Mark that we're restoring position (suppresses progress updates from scroll events)
    this.isRestoringPosition = true;

    // When restore starts, update overlay message
    this.activeReader.onRestoreStart = () => {
      if (this.isRefetching) {
        this.overlay.setMessage(`Refetching Chapter ${this.currentChapter}...`);
      } else {
        this.overlay.setMessage('Restoring position...');
      }
    };

    // When restore completes, show content and hide overlay
    this.activeReader.onAnchorImagesReady = () => {
      console.log('[Viewer] Anchor images ready, position restored accurately');
      this.isRestoringPosition = false;
      this.completeChapterLoad();
    };

    // Show progress for all loads (not just refetch)
    this.activeReader.onRestoreProgress = (loaded, total) => {
      this.overlay.updateProgress(loaded, total);
    };

    // Offset position by preloaded page count (preloaded chapters shift all indices)
    const position = { ...chapterPosition };
    if (this.continuousReadingActive && this.activeReader instanceof VerticalReader) {
      const preloadedCount = (this.activeReader as VerticalReader).getPreloadedPageCount();
      if (preloadedCount > 0) {
        position.anchorImageIndex += preloadedCount;
        console.log(`[Viewer] Position offset by ${preloadedCount} preloaded pages: ${chapterPosition.anchorImageIndex} → ${position.anchorImageIndex}`);
      }
    }

    // Restore the saved position
    this.activeReader.restorePosition(position);
  }

  /**
   * Render pages based on current mode
   */
  private renderPages(options?: { sequentialLoading?: boolean; preloadedPrevChapters?: Array<{ chapter: Chapter; pages: PageInfo[]; cacheContext: { sourceId: string; mangaSlug: string; chapterSlug: string }; isFirst: boolean }> }): void {
    if (!this.contentArea || this.pages.length === 0) return;

    // Capture position before re-render (for mode switches).
    // Also capture the OLD reader's mode BEFORE destroying it — this.currentMode has
    // already been updated to the target mode by setMode, so we need the old reader's
    // own mode for the position conversion below. Without this, ScrollAnchor.convert
    // receives fromMode === toMode and silently returns the position unchanged.
    let savedPosition = this.activeReader?.getPosition();
    const fromMode: ReadingMode = this.activeReader?.getMode() ?? this.currentMode;

    // Destroy previous reader
    this.activeReader?.destroy();
    this.activeReader = null;

    // Create appropriate reader
    switch (this.currentMode) {
      case 'vertical':
        this.activeReader = new VerticalReader(this.contentArea);
        break;
      case 'single':
        this.activeReader = new SinglePageReader(this.contentArea);
        break;
      case 'double':
        this.activeReader = new DoublePageReader(this.contentArea);
        break;
    }
    
    // Safety check (should never happen as switch covers all cases)
    if (!this.activeReader) return;

    // Set per-manga placeholder ratio if known
    if (this.placeholderWidth && this.placeholderHeight) {
      this.activeReader.defaultAspectRatio = `${this.placeholderWidth}/${this.placeholderHeight}`;
    }

    // Setup callbacks
    this.activeReader.onProgressUpdate = (current, total) => {
      // Skip progress updates during position restoration to prevent flicker
      if (this.isRestoringPosition) return;
      
      const progressEl = document.getElementById('cr-progress');
      if (progressEl) {
        progressEl.textContent = `${current}/${total}`;
      }
    };

    this.activeReader.onChapterEnd = async (direction) => {
      // In continuous reading mode, next chapter is auto-appended by the reader.
      // Only use this callback as a fallback (e.g., last chapter reached).
      if (this.continuousReadingActive && this.currentMode === 'vertical') {
        if (direction === 'next') {
          this.loadNextChapterContinuous();
        } else {
          this.loadPreviousChapterContinuous();
        }
        return;
      }
      if (direction === 'next') {
        await this.nextChapter(true);
      } else {
        await this.prevChapter(true);
      }
    };

    // Callback for persisting image dimensions to cache (for scroll preservation)
    this.activeReader.onPageDimensionsLoaded = (pageIndex, url, width, height) => {
      // In continuous reading mode, use per-page cache context for correct chapter identification
      if (this.continuousReadingActive && this.activeReader instanceof VerticalReader) {
        const cacheCtx = (this.activeReader as VerticalReader).getPageCacheContext(pageIndex);
        if (cacheCtx) {
          bridgeSourceDataUpdatePageDimensions(
            cacheCtx.sourceId,
            cacheCtx.mangaSlug,
            cacheCtx.chapterSlug,
            cacheCtx.localIndex,
            url, width, height
          ).catch(err => console.warn('[Viewer] Failed to update page dimensions:', err));
        }
      } else if (this.currentSourceId && this.currentMangaSlug && this.currentChapterSlug) {
        // Standard single-chapter path
        bridgeSourceDataUpdatePageDimensions(
          this.currentSourceId,
          this.currentMangaSlug,
          this.currentChapterSlug,
          pageIndex,
          url,
          width,
          height
        ).catch(err => console.warn('[Viewer] Failed to update page dimensions:', err));
      }

      // Capture placeholder dimensions from a representative page (avoids cover/art at index 0)
      // Falls back to last page for short chapters; re-captures on refetch
      const placeholderTargetIndex = Math.min(2, this.pages.length - 1);
      if (pageIndex === placeholderTargetIndex && this.pageData && this.currentSourceId && (!this.placeholderWidth || this.isRefetching)) {
        this.placeholderWidth = width;
        this.placeholderHeight = height;
        // Update current reader's fallback immediately for remaining placeholders
        if (this.activeReader) {
          this.activeReader.defaultAspectRatio = `${width}/${height}`;
        }
        sourceMappingManager.setPlaceholderDimensions(this.pageData.slug, this.currentSourceId, width, height, this.isRefetching)
          .catch(err => console.warn('[Viewer] Failed to save placeholder dims:', err));
      }
    };

    // Set chapter bounds for nav button states
    const isFirstChapter = !this.chapters.some(c => c.number < this.currentChapter);
    const isLastChapter = !this.chapters.some(c => c.number > this.currentChapter);

    // Detect chapter number gaps for visual warning
    const nextNum = this.getAdjacentChapter('next');
    const prevNum = this.getAdjacentChapter('prev');
    const hasGapNext = nextNum !== null && Math.abs(nextNum - this.currentChapter) > 1;
    const hasGapPrev = prevNum !== null && Math.abs(this.currentChapter - prevNum) > 1;

    this.activeReader.setChapterBounds(isFirstChapter, isLastChapter, hasGapNext, hasGapPrev);

    // Propagate refetch state so reader can adjust timeouts
    this.activeReader.isRefetching = this.isRefetching;

    // Set pages and render
    this.activeReader.setPages(this.pages);
    
    // Configure image fit mode, zoom, background color, and scroll speed
    this.activeReader.configure({ imageFit: this.currentFit, zoom: this.currentZoom, backgroundColor: this.currentBgColor, scrollAmount: this.currentScrollAmount, scrollSpeed: this.currentScrollSpeed });

    // NOTE: applyFitClass() is deliberately deferred until AFTER activeReader.render().
    // Each reader's render() does `this.container.className = '...'` which wipes any
    // previously-added cr-fit-* class. The vertical reader's "Original Size" mode
    // depends on `.cr-fit-original.cr-mode-vertical { overflow-x: auto }` being live
    // on contentArea for horizontal scrolling — losing the class clips wide images.

    // If we have a saved position and this is a mode switch, set initial page before render
    // to prevent showing page 0 briefly before restoring
    if (savedPosition && !this.isLoadingNewChapter) {
      const convertedPosition = ScrollAnchor.convert(
        savedPosition,
        fromMode,
        this.currentMode,
        this.pages.length
      );
      // For single/double page modes, set the starting page before render
      if (this.currentMode === 'single' || this.currentMode === 'double') {
        (this.activeReader as any).setInitialPage?.(convertedPosition.anchorImageIndex);
      }
    }

    // Enable continuous reading for vertical mode if setting is on
    if (this.currentMode === 'vertical' && this.continuousReadingActive) {
      const currentChapter = this.chapters.find(c => c.number === this.currentChapter);
      if (currentChapter) {
        (this.activeReader as VerticalReader).enableContinuousReading(currentChapter,
          this.currentSourceId && this.currentMangaSlug && this.currentChapterSlug
            ? { sourceId: this.currentSourceId, mangaSlug: this.currentMangaSlug, chapterSlug: this.currentChapterSlug }
            : undefined
        );

        // Set pre-loaded previous chapters if available (included in initial render)
        if (options?.preloadedPrevChapters && options.preloadedPrevChapters.length > 0) {
          (this.activeReader as VerticalReader).setPreloadedPrevChapters(options.preloadedPrevChapters);
        }

        // Wire up continuous reading callbacks
        this.activeReader.onRequestNextChapter = () => {
          this.loadNextChapterContinuous();
        };

        (this.activeReader as VerticalReader).onRequestPrevChapter = () => {
          this.loadPreviousChapterContinuous();
        };

        this.activeReader.onCurrentChapterChange = (chapterNumber, currentPage, totalPages) => {
          this.handleContinuousChapterChange(chapterNumber, currentPage, totalPages);
        };
      }
    }

    // Enable sequential loading BEFORE render if requested
    // Must be set before render() so it uses sequential strategy, not IntersectionObserver
    if (options?.sequentialLoading) {
      this.activeReader.enableSequentialLoading(Math.min(2, this.pages.length));
    }

    this.activeReader.render();

    // Apply fit class AFTER render — render() overwrites contentArea.className, so
    // adding it before would be silently wiped. See the NOTE above for context.
    this.applyFitClass();

    // Get image elements reference for scroll anchor
    this.imageElements = this.activeReader.getImageElements();

    // Restore position if we had one (mode switch only, not chapter switch)
    // For single/double modes, setInitialPage + render already handled it
    if (savedPosition && this.activeReader && !this.isLoadingNewChapter && this.currentMode === 'vertical') {
      // Convert position between modes if needed
      const convertedPosition = ScrollAnchor.convert(
        savedPosition,
        fromMode,
        this.currentMode,
        this.pages.length
      );
      this.activeReader.restorePosition(convertedPosition);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private prevPage(): void {
    if (this.activeReader) {
      this.activeReader.prevPage();
    }
  }

  private nextPage(): void {
    if (this.activeReader) {
      this.activeReader.nextPage();
    }
  }

  private scrollDown(): void {
    if (this.activeReader) {
      this.activeReader.nextPage();
    }
  }

  private scrollUp(): void {
    if (this.activeReader) {
      this.activeReader.prevPage();
    }
  }

  /**
   * Scroll to the top of the content area
   */
  private scrollToTop(): void {
    if (this.activeReader) {
      this.activeReader.goToPage(0);
    }
  }

  /**
   * Reload the current chapter by clearing ALL caches and refetching from source
   * Clears: in-memory image cache, persistent image cache, and source data (page URLs) cache
   * Preserves scroll position after reload
   */
  private async reloadChapter(): Promise<void> {
    if (!this.pageData || this.isRefetching) return;

    this.isRefetching = true;

    // Save current position BEFORE clearing cache (reuses existing save logic)
    await this.savePosition();

    // Show reloading overlay immediately
    this.overlay.showLoading(`Reloading Chapter ${this.currentChapter}...`);
    this.hideContentArea();

    // Enable HTTP cache bypass so background fetch() skips browser disk cache
    await bridgeSetHttpCacheBypass(true);

    // Get chapter info for cache clearing
    const chapter = this.chapters.find(c => c.number === this.currentChapter);
    const mapping = await sourceMappingManager.get(this.pageData.slug);
    
    // Clear in-memory cache first (always do this)
    clearImageCache();
    console.log('[Viewer] Cleared in-memory image cache');
    
    if (chapter && mapping) {
      // Get the source slug from the mapping's sources record
      const sourceInfo = mapping.sources[this.currentSourceId];
      const sourceSlug = sourceInfo?.slug;
      
      if (sourceSlug) {
        // Clear persistent IMAGE cache for this chapter
        try {
          const removed = await bridgeCacheClearChapter(
            this.currentSourceId,
            sourceSlug,
            chapter.slug
          );
          console.log(`[Viewer] Cleared persistent image cache: ${removed} images removed`);
        } catch (error) {
          console.warn('[Viewer] Failed to clear persistent image cache:', error);
        }
        
        // Clear SOURCE DATA cache (page URLs) for this chapter
        // This forces the viewer to re-fetch page URLs from the source
        try {
          await bridgeSourceDataClearChapterPages(
            this.currentSourceId,
            sourceSlug,
            chapter.slug
          );
          console.log('[Viewer] Cleared source data (page URLs) cache for chapter');
        } catch (error) {
          console.warn('[Viewer] Failed to clear source data cache:', error);
        }
      }
    }
    
    // Reload chapter with skipRestore=false to let loadChapter handle restoration
    // (just like clicking on a chapter from the picker)
    await this.loadChapter(this.currentChapter, false);
  }

  /**
   * Check if the current load appears to be a batch failure from a bad CDN node.
   * Only triggers for ephemeral-URL sources (e.g., MangaDex) where re-fetching
   * page URLs can yield a different CDN node.
   */
  private shouldAutoRetry(): boolean {
    const source = sourceRegistry.get(this.currentSourceId);
    if (!source?.skipPageCache) return false;
    if (this.autoRetryCount >= Viewer.MAX_AUTO_RETRIES) return false;
    if (!this.activeReader) return false;

    const imageElements = this.activeReader.getImageElements();
    let failedCount = 0;
    let loadedCount = 0;

    for (const el of imageElements) {
      if (el.classList.contains('cr-page-failed')) {
        failedCount++;
      } else if (el.classList.contains('cr-loaded')) {
        loadedCount++;
      }
    }

    const attemptedCount = failedCount + loadedCount;
    console.log(`[Viewer] Batch failure check: ${failedCount} failed, ${loadedCount} loaded, ${attemptedCount} attempted`);

    // Need at least 3 attempted and ALL must have failed
    return attemptedCount >= 3 && loadedCount === 0;
  }

  /**
   * Automatically retry loading when a bad CDN node is detected.
   * Re-fetches page URLs from the source (getting a potentially different CDN node),
   * then retries all failed pages with the fresh URLs.
   */
  private async performAutoRetry(): Promise<void> {
    console.log(`[Viewer] Batch CDN failure detected, auto-retry #${this.autoRetryCount}`);
    this.overlay.setMessage('Bad CDN server, retrying...');

    const source = sourceRegistry.get(this.currentSourceId);
    if (!source?.skipPageCache || !this.activeReader
        || !this.currentMangaSlug || !this.currentChapterSlug) {
      this.completeChapterLoad();
      return;
    }

    try {
      // Bypass image cache lookup to get real CDN URLs
      sourceRegistry.getCached(this.currentSourceId)?.setForceRefreshPages(true);
      const freshPages = await source.getChapterPages(
        this.currentMangaSlug,
        this.currentChapterSlug
      );

      if (freshPages.length !== this.pages.length) {
        console.warn('[Viewer] Auto-retry page count mismatch, giving up');
        this.completeChapterLoad();
        return;
      }

      this.pages = freshPages;
      this.activeReader.setPages(freshPages);

      const imageElements = this.activeReader.getImageElements();
      const failedIndices: number[] = [];
      for (let i = 0; i < imageElements.length; i++) {
        if (imageElements[i].classList.contains('cr-page-failed')) {
          failedIndices.push(i);
        }
      }

      console.log(`[Viewer] Retrying ${failedIndices.length} failed pages with fresh CDN URLs`);
      for (const index of failedIndices) {
        this.activeReader.retryPage(index);
      }

      // Poll for success: once 2+ images load, show content
      let pollCount = 0;
      const maxPolls = 16; // 16 * 500ms = 8s
      const pollInterval = setInterval(() => {
        pollCount++;

        if (!this.isLoadingNewChapter || pollCount >= maxPolls) {
          clearInterval(pollInterval);
          if (this.isLoadingNewChapter) {
            console.log('[Viewer] Auto-retry poll timeout, showing content');
            this.completeChapterLoad();
          }
          return;
        }

        const elements = this.activeReader?.getImageElements() || [];
        const successCount = elements.filter(
          el => el.classList.contains('cr-loaded')
        ).length;

        if (successCount >= 2) {
          clearInterval(pollInterval);
          console.log(`[Viewer] Auto-retry successful, ${successCount} images loaded`);
          this.completeChapterLoad();
        }
      }, 500);

    } catch (error) {
      console.error('[Viewer] Auto-retry failed:', error);
      this.completeChapterLoad();
    }
  }

  /**
   * Handle per-page retry. Re-fetches page URLs from the source API to get
   * fresh CDN URLs, then retries ALL failed pages. This handles both ephemeral
   * URLs (MangaDex) and cached:// URLs that fail due to blob eviction.
   */
  private async handlePageRetry(clickedIndex: number): Promise<void> {
    const source = sourceRegistry.get(this.currentSourceId);
    if (!source || !this.activeReader) return;

    // Refresh page URLs before retrying — needed for cached:// URLs (any source)
    // and ephemeral CDN URLs (MangaDex)
    if (this.currentMangaSlug && this.currentChapterSlug) {
      try {
        console.log('[Viewer] Refreshing page URLs before retry...');
        // Bypass image cache lookup to get real CDN URLs
        sourceRegistry.getCached(this.currentSourceId)?.setForceRefreshPages(true);
        const freshPages = await source.getChapterPages(this.currentMangaSlug, this.currentChapterSlug);

        if (freshPages.length === this.pages.length) {
          // Update page URLs in both Viewer and Reader
          this.pages = freshPages;
          this.activeReader.setPages(freshPages);

          // Retry ALL failed pages (they all share the same expired token)
          const imageElements = this.activeReader.getImageElements();
          const failedIndices: number[] = [];
          for (let i = 0; i < imageElements.length; i++) {
            if (imageElements[i].classList.contains('cr-page-failed')) {
              failedIndices.push(i);
            }
          }

          console.log(`[Viewer] Retrying ${failedIndices.length} failed pages with fresh URLs`);
          for (const index of failedIndices) {
            this.activeReader.retryPage(index);
          }
          return;
        } else {
          console.warn('[Viewer] Fresh page count mismatch, falling back to single retry');
        }
      } catch (error) {
        console.warn('[Viewer] Failed to refresh page URLs, retrying with existing URL:', error);
      }
    }

    // Fallback: standard single-page retry
    this.activeReader.retryPage(clickedIndex);
  }

  private async prevChapter(skipRestore: boolean = false): Promise<void> {
    const adjacent = this.getAdjacentChapter('prev');
    if (adjacent !== null) {
      await this.goToChapter(adjacent, skipRestore);
    }
  }

  private async nextChapter(skipRestore: boolean = false): Promise<void> {
    const adjacent = this.getAdjacentChapter('next');
    if (adjacent !== null) {
      const chapterToMarkRead = this.currentChapter;
      const success = await this.goToChapter(adjacent, skipRestore);
      if (success) {
        // Mark the chapter we just left as read (always on next chapter navigation,
        // regardless of markReadMode — if you finished a chapter, it's read)
        await this.markChapterAsRead(chapterToMarkRead);
      }
    }
  }

  /**
   * Get the adjacent chapter number in a given direction.
   * Uses sorted chapter list index, not arithmetic, so gaps are handled.
   */
  private getAdjacentChapter(direction: 'next' | 'prev'): number | null {
    if (this.chapters.length === 0) return null;
    const sorted = [...this.chapters].sort((a, b) => a.number - b.number);
    const currentIndex = sorted.findIndex(c => c.number === this.currentChapter);
    if (currentIndex === -1) return null;
    const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (targetIndex < 0 || targetIndex >= sorted.length) return null;
    return sorted[targetIndex].number;
  }

  private async goToChapter(chapter: number, skipRestore: boolean = false): Promise<boolean> {
    // Validate that the target chapter exists
    const targetChapter = this.chapters.find(c => c.number === chapter);
    if (!targetChapter) {
      // Target chapter doesn't exist, do nothing
      return false;
    }
    
    // Save current position first (must await to ensure cache is updated before loading new chapter)
    await this.savePosition();
    
    // Reset scroll anchor for new chapter
    this.scrollAnchor.clear();
    
    await this.loadChapter(chapter, skipRestore);
    
    // Update chapter button text
    this.updateChapterButton();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PICKER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Open chapter picker modal
   */
  private async openChapterPicker(): Promise<void> {
    if (this.chapters.length === 0) return;

    // Get manga slug for cache context
    let cacheContext: { sourceId: string; mangaSlug: string } | undefined;
    if (this.pageData) {
      const selectedSource = await sourceMappingManager.getSelectedSource(this.pageData.slug);
      if (selectedSource) {
        cacheContext = {
          sourceId: selectedSource.sourceId,
          mangaSlug: selectedSource.sourceInfo.slug,
        };
      }
    }

    chapterPicker.show(
      this.chapters,
      this.currentChapter,
      (chapter) => {
        // In continuous mode, scroll to the chapter if it's already loaded
        if (this.continuousReadingActive && this.activeReader instanceof VerticalReader) {
          const reader = this.activeReader as VerticalReader;
          const seg = reader.getChapterSegments().find(s => s.chapterNumber === chapter.number);
          if (seg) {
            // Update currentChapter BEFORE the scroll so toolbar/state reflect target immediately.
            // scrollToSegment suppresses chapter-change detection during the animation so
            // currentChapter doesn't oscillate through intermediate chapters.
            this.currentChapter = chapter.number;
            this.updateChapterButton();
            reader.scrollToSegment(seg);
            return;
          }
        }
        // Show transition overlay immediately so that when picker closes,
        // the dark backdrop persists seamlessly (no light flash between
        // picker overlay removal and loadChapter's transition overlay).
        this.overlay.showTransition();
        this.hideContentArea();
        this.goToChapter(chapter.number);
      },
      () => {
        // onClose - refocus container for keyboard events
        this.container?.focus();
      },
      async () => {
        // Refresh callback - invalidate cache and re-fetch
        await this.refreshChapterList();
      },
      this.pageData?.slug, // comickSlug for read tracking
      (chapter) => {
        // Start from beginning callback
        if (this.continuousReadingActive && this.activeReader instanceof VerticalReader) {
          const reader = this.activeReader as VerticalReader;
          const seg = reader.getChapterSegments().find(s => s.chapterNumber === chapter.number);
          if (seg) {
            // Update currentChapter BEFORE the scroll so toolbar/state reflect target immediately.
            // scrollToSegment suppresses chapter-change detection during the animation so
            // currentChapter doesn't oscillate through intermediate chapters.
            this.currentChapter = chapter.number;
            this.updateChapterButton();
            reader.scrollToSegment(seg);
            return;
          }
        }
        this.overlay.showTransition();
        this.hideContentArea();
        this.goToChapter(chapter.number, true);
      },
      cacheContext,
      this.currentSourceId
    );
  }

  /**
   * Refresh chapter list (invalidate cache and re-fetch)
   */
  private async refreshChapterList(): Promise<void> {
    if (!this.pageData) return;

    const selectedSource = await sourceMappingManager.getSelectedSource(this.pageData.slug);
    if (!selectedSource) return;

    const sourceInfo = selectedSource.sourceInfo;
    
    // Invalidate cache first
    await sourceRegistry.invalidateChapters(this.currentSourceId, sourceInfo.slug);

    // Fetch fresh chapter list
    const source = sourceRegistry.get(this.currentSourceId);
    if (!source) return;

    try {
      this.chapters = await source.getChapterList(sourceInfo.slug);
      
      // Update the picker with new chapters
      chapterPicker.updateChapters(this.chapters);
      
      // Update dropdown as well
      this.updateChapterDropdown();
      
      console.log(`[Viewer] Refreshed chapter list: ${this.chapters.length} chapters`);
    } catch (error) {
      console.error('[Viewer] Failed to refresh chapters:', error);
    }
  }

  /**
   * Open mode picker dropdown
   */
  private openModePicker(anchor: HTMLElement): void {
    modePicker.show(
      anchor,
      this.currentMode,
      this.currentFit,
      (mode) => {
        this.setMode(mode);
      },
      (fit) => {
        this.setImageFit(fit);
      },
      () => {
        // onClose - refocus container for keyboard events
        this.container?.focus();
      }
    );
  }

  /**
   * Set image fit mode
   */
  private async setImageFit(fit: ImageFit): Promise<void> {
    if (fit === this.currentFit) return;
    
    // Capture scroll position before fit change (vertical mode only)
    let savedPosition = null;
    if (this.currentMode === 'vertical' && this.activeReader) {
      savedPosition = this.activeReader.getPosition();
    }
    
    this.currentFit = fit;
    
    // Save preference per-manga
    if (this.pageData) {
      await readingStateManager.updateDisplaySettings(this.pageData.slug, { imageFit: fit });
    }
    
    // Apply fit class to content area
    this.applyFitClass();
    
    // Update reader configuration (this resizes the images)
    if (this.activeReader) {
      this.activeReader.configure({ imageFit: fit });
    }
    
    // Restore scroll position after layout settles (vertical mode only)
    if (savedPosition && this.currentMode === 'vertical' && this.activeReader && this.contentArea) {
      // Wait for CSS to apply and layout to recalculate
      requestAnimationFrame(() => {
        // Force layout reflow
        void this.contentArea!.offsetHeight;
        // Restore position
        this.activeReader?.restorePosition(savedPosition!);
      });
    }
  }
  
  /**
   * Apply current fit class to content area
   */
  private applyFitClass(): void {
    if (!this.contentArea) return;
    
    // Remove all fit classes
    this.contentArea.classList.remove('cr-fit-width', 'cr-fit-height', 'cr-fit-contain', 'cr-fit-original');
    
    // Add current fit class
    this.contentArea.classList.add(`cr-fit-${this.currentFit}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ZOOM METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  // Zoom configuration
  private static readonly ZOOM_MIN = 10;
  private static readonly ZOOM_MAX = 500;
  private static readonly ZOOM_STEP = 10;
  private static readonly ZOOM_ANIMATION_DURATION = 180; // ms
  private static readonly ZOOM_FAST_THRESHOLD = 250; // ms - if zooming again within this time, use faster animation
  private static readonly ZOOM_FAST_DURATION = 80; // ms - faster animation for held keys

  /**
   * Easing function for smooth zoom animation (ease-out cubic)
   */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Normalize zoom level from storage.
   * Handles legacy 0-1 scale values by converting to integer percentage.
   */
  private normalizeZoomLevel(zoomLevel: number | undefined): number | undefined {
    if (zoomLevel == null) return undefined;
    // Legacy 0-1 scale: values <= 5 are unreachable via the UI (ZOOM_MIN is 10)
    if (zoomLevel > 0 && zoomLevel <= 5) {
      return Math.round(zoomLevel * 100);
    }
    return Math.max(Viewer.ZOOM_MIN, Math.min(Viewer.ZOOM_MAX, Math.round(zoomLevel)));
  }

  /**
   * Zoom in by step amount
   */
  private zoomIn(): void {
    this.setZoom(Math.min(Viewer.ZOOM_MAX, this.currentZoom + Viewer.ZOOM_STEP));
  }

  /**
   * Zoom out by step amount
   */
  private zoomOut(): void {
    this.setZoom(Math.max(Viewer.ZOOM_MIN, this.currentZoom - Viewer.ZOOM_STEP));
  }

  /**
   * Reset zoom to 100%
   */
  private resetZoom(): void {
    this.setZoom(100);
  }

  /**
   * Set zoom level with smooth animated scroll preservation
   */
  private setZoom(level: number): void {
    if (level === this.currentZoom || !this.contentArea) return;
    
    // Cancel any in-progress animation
    if (this.zoomAnimationId !== null) {
      cancelAnimationFrame(this.zoomAnimationId);
      this.zoomAnimationId = null;
    }
    
    const now = performance.now();
    const isRapidZoom = (now - this.lastZoomTime) < Viewer.ZOOM_FAST_THRESHOLD;
    this.lastZoomTime = now;
    
    // Use faster animation if user is rapidly zooming (holding key)
    const duration = isRapidZoom ? Viewer.ZOOM_FAST_DURATION : Viewer.ZOOM_ANIMATION_DURATION;
    
    const startZoom = this.currentZoom;
    const targetZoom = level;
    
    // Capture anchor point before animation starts
    // Find which image is at the top of viewport and how far into it
    const anchor = this.captureZoomAnchor();

    // Suppress ResizeObserver during zoom animation
    this.isZooming = true;

    this.zoomAnimationStart = now;
    
    const animate = (timestamp: number) => {
      const elapsed = timestamp - this.zoomAnimationStart;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = this.easeOutCubic(progress);
      
      // Interpolate zoom
      const currentZoom = Math.round(startZoom + (targetZoom - startZoom) * easedProgress);
      
      // Apply zoom without triggering another animation
      this.applyZoomInstant(currentZoom);
      
      // Restore scroll position based on anchor
      this.restoreZoomAnchor(anchor);
      
      if (progress < 1) {
        this.zoomAnimationId = requestAnimationFrame(animate);
      } else {
        this.zoomAnimationId = null;
        this.isZooming = false;
        // Ensure we hit exact target
        this.applyZoomInstant(targetZoom);
        this.restoreZoomAnchor(anchor);
        // Save final zoom to storage
        if (this.pageData) {
          readingStateManager.updateDisplaySettings(this.pageData.slug, { zoomLevel: targetZoom });
        }
      }
    };
    
    this.zoomAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Capture zoom anchor point - which image is at viewport top and offset into it
   */
  private captureZoomAnchor(): { imageIndex: number; offset: number } {
    if (!this.contentArea || this.imageElements.length === 0) {
      return { imageIndex: 0, offset: 0 };
    }
    
    const viewportTop = this.contentArea.scrollTop;
    
    for (let i = 0; i < this.imageElements.length; i++) {
      const img = this.imageElements[i];
      const imgTop = img.offsetTop;
      const imgHeight = img.offsetHeight;
      const imgBottom = imgTop + imgHeight;
      
      if (imgBottom > viewportTop) {
        // This image is at or crossing viewport top
        const offset = imgHeight > 0 ? (viewportTop - imgTop) / imgHeight : 0;
        return { imageIndex: i, offset: Math.max(0, offset) };
      }
    }
    
    // Fallback to last image
    return { imageIndex: this.imageElements.length - 1, offset: 0 };
  }

  /**
   * Restore scroll position based on anchor point
   */
  private restoreZoomAnchor(anchor: { imageIndex: number; offset: number }): void {
    if (!this.contentArea || this.imageElements.length === 0) return;
    
    const img = this.imageElements[anchor.imageIndex];
    if (!img) return;
    
    const targetScroll = img.offsetTop + (img.offsetHeight * anchor.offset);
    this.contentArea.scrollTop = targetScroll;
  }

  /**
   * Apply zoom instantly without animation (used by animation loop)
   */
  private applyZoomInstant(level: number): void {
    this.currentZoom = level;
    this.updateZoomDisplay();
    
    if (this.activeReader) {
      this.activeReader.configure({ zoom: level });
    }
  }

  /**
   * Update zoom percentage display
   */
  private updateZoomDisplay(): void {
    const zoomValue = document.getElementById('cr-zoom-value');
    if (zoomValue) {
      zoomValue.textContent = `${this.currentZoom}%`;
    }
  }

  /**
   * Clean chapter title by removing redundant chapter number prefix
   */
  private cleanChapterTitle(title: string, chapterNumber: number): string {
    if (!title) return '';
    
    // Remove patterns like "Chapter 211", "Chapter211", "Ch. 211", "Ch.211" from start
    const patterns = [
      new RegExp(`^Chapter\\s*${chapterNumber}\\s*[-:]?\\s*`, 'i'),
      new RegExp(`^Ch\\.?\\s*${chapterNumber}\\s*[-:]?\\s*`, 'i'),
    ];
    
    let cleaned = title;
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    return cleaned.trim();
  }

  /**
   * Update chapter button text
   */
  private updateChapterButton(): void {
    const btn = document.getElementById('cr-chapter-select');
    if (btn) {
      const labelSpan = btn.querySelector('.cr-chapter-btn-label');
      const titleSpan = btn.querySelector('.cr-chapter-btn-title');
      if (labelSpan) {
        labelSpan.textContent = `Chapter ${this.currentChapter}`;
      }
      if (titleSpan) {
        const currentChapterData = this.chapters.find(ch => ch.number === this.currentChapter);
        const cleanedTitle = currentChapterData?.title 
          ? this.cleanChapterTitle(currentChapterData.title, this.currentChapter)
          : '';
        titleSpan.textContent = cleanedTitle || '';
      }
    }
  }

  /**
   * Mark current chapter as read
   */
  private async markCurrentChapterAsRead(): Promise<void> {
    await this.markChapterAsRead(this.currentChapter);
  }

  /**
   * Mark a specific chapter as read
   */
  private async markChapterAsRead(chapterNumber: number): Promise<void> {
    if (!this.pageData) return;
    // Only newly-read chapters count toward stats — re-opening an already-read
    // chapter (markReadMode 'onOpen') shouldn't inflate the read count
    const alreadyRead = await readingStateManager.isChapterRead(this.pageData.slug, chapterNumber);
    await readingStateManager.markChapterRead(this.pageData.slug, chapterNumber);
    if (!alreadyRead) {
      void statsManager.recordChapterRead(this.pageData.slug);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTINUOUS READING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load the next chapter's pages and append them to the current reader.
   * Called by VerticalReader's preload trigger when the user scrolls near the end.
   */
  private async loadNextChapterContinuous(): Promise<void> {
    if (this.continuousLoadingChapter || !this.pageData) return;

    // Determine which chapter to load next: the one after the last appended segment
    const reader = this.activeReader as VerticalReader;
    const segments = reader.getChapterSegments();
    const lastAppendedChapter = segments.length > 0
      ? segments[segments.length - 1].chapterNumber
      : this.currentChapter;

    // Get the chapter after the last appended one (not after currentChapter)
    const sorted = [...this.chapters].sort((a, b) => a.number - b.number);
    const lastIdx = sorted.findIndex(c => c.number === lastAppendedChapter);
    if (lastIdx === -1 || lastIdx >= sorted.length - 1) return;
    const nextChapterNum = sorted[lastIdx + 1].number;

    const nextChapter = this.chapters.find(c => c.number === nextChapterNum);
    if (!nextChapter) return;

    this.continuousLoadingChapter = true;
    console.log(`[Viewer] Continuous reading: loading chapter ${nextChapterNum}`);

    try {
      const mapping = await sourceMappingManager.get(this.pageData.slug);
      if (!mapping) return;

      const selectedSource = await sourceMappingManager.getSelectedSource(this.pageData.slug);
      if (!selectedSource) return;

      const source = sourceRegistry.get(selectedSource.sourceId);
      if (!source) return;

      const nextPages = await source.getChapterPages(selectedSource.sourceInfo.slug, nextChapter.slug);
      if (nextPages.length === 0) return;

      // Verify reader is still active (user may have navigated away or closed viewer)
      if (this.activeReader !== reader) return;

      // Append to the reader with cache context for correct persistent caching
      const cacheContext = {
        sourceId: selectedSource.sourceId,
        mangaSlug: selectedSource.sourceInfo.slug,
        chapterSlug: nextChapter.slug,
      };
      const isLastChapter = !this.chapters.some(c => c.number > nextChapterNum);
      reader.appendChapter(nextChapter, nextPages, cacheContext, isLastChapter);

      // Update image elements reference
      this.imageElements = reader.getImageElements();

      // Mark previous chapter as read if markReadMode is onNextChapter
      const settings = await settingsManager.load();
      if (settings.markReadMode === 'onNextChapter') {
        await this.markChapterAsRead(this.currentChapter);
      }

      // If markReadMode is onOpen, mark the new chapter as read
      if (settings.markReadMode === 'onOpen') {
        await this.markChapterAsRead(nextChapterNum);
      }

      // Save page count for the newly loaded chapter
      await readingStateManager.updatePosition(
        this.pageData.slug,
        this.currentSourceId,
        nextChapterNum,
        { anchorImageIndex: 0, anchorImageOffset: 0 },
        nextPages.length
      );

    } catch (error) {
      console.error(`[Viewer] Failed to load next chapter for continuous reading:`, error);
    } finally {
      this.continuousLoadingChapter = false;
      // Reset trigger flag so user can retry by scrolling (safe even on success — appendChapter already reset it)
      if (this.activeReader instanceof VerticalReader) {
        (this.activeReader as VerticalReader).resetNextChapterRequest();
      }
    }
  }

  /**
   * Fetch the previous chapter's pages for pre-loading during initial render.
   * Called in parallel with main chapter page fetch. Returns data for VerticalReader
   * to include in the initial render, avoiding async prepend and scroll jumps.
   */
  private async fetchPrevChapterPages(
    source: any,
    mangaSlug: string,
    currentChapterNum: number
  ): Promise<Array<{
    chapter: Chapter;
    pages: PageInfo[];
    cacheContext: { sourceId: string; mangaSlug: string; chapterSlug: string };
    isFirst: boolean;
  }>> {
    try {
      const sorted = [...this.chapters].sort((a, b) => a.number - b.number);
      const currentIdx = sorted.findIndex(c => c.number === currentChapterNum);
      if (currentIdx <= 0) return [];

      const prevChapter = sorted[currentIdx - 1];
      const prevPages = await source.getChapterPages(mangaSlug, prevChapter.slug);
      if (prevPages.length === 0) return [];

      const isFirst = currentIdx - 1 === 0;
      return [{
        chapter: prevChapter,
        pages: prevPages,
        cacheContext: {
          sourceId: this.currentSourceId,
          mangaSlug,
          chapterSlug: prevChapter.slug,
        },
        isFirst,
      }];
    } catch (error) {
      console.warn('[Viewer] Failed to pre-fetch previous chapter:', error);
      return [];
    }
  }

  /**
   * Load the previous chapter's pages and prepend them above the current reader.
   * Called after position restoration completes, or by the prev chapter trigger.
   */
  private async loadPreviousChapterContinuous(): Promise<void> {
    if (this.continuousLoadingPrevChapter || !this.pageData) return;

    const reader = this.activeReader as VerticalReader;
    const segments = reader.getChapterSegments();
    const firstLoadedChapter = segments.length > 0
      ? segments[0].chapterNumber
      : this.currentChapter;

    // Get the chapter before the first loaded one
    const sorted = [...this.chapters].sort((a, b) => a.number - b.number);
    const firstIdx = sorted.findIndex(c => c.number === firstLoadedChapter);
    if (firstIdx <= 0) return;
    const prevChapterNum = sorted[firstIdx - 1].number;

    const prevChapter = this.chapters.find(c => c.number === prevChapterNum);
    if (!prevChapter) return;

    this.continuousLoadingPrevChapter = true;
    console.log(`[Viewer] Continuous reading: loading previous chapter ${prevChapterNum}`);

    try {
      const selectedSource = await sourceMappingManager.getSelectedSource(this.pageData.slug);
      if (!selectedSource) return;

      const source = sourceRegistry.get(selectedSource.sourceId);
      if (!source) return;

      const prevPages = await source.getChapterPages(selectedSource.sourceInfo.slug, prevChapter.slug);
      if (prevPages.length === 0) return;

      // Verify the reader is still the same instance (user might have navigated away)
      if (this.activeReader !== reader) return;

      const cacheContext = {
        sourceId: selectedSource.sourceId,
        mangaSlug: selectedSource.sourceInfo.slug,
        chapterSlug: prevChapter.slug,
      };
      const isFirstChapter = !this.chapters.some(c => c.number < prevChapterNum);
      reader.prependChapter(prevChapter, prevPages, cacheContext, isFirstChapter);

      // Update image elements reference
      this.imageElements = reader.getImageElements();

      // Mark as read if onOpen mode
      const settings = await settingsManager.load();
      if (settings.markReadMode === 'onOpen') {
        await this.markChapterAsRead(prevChapterNum);
      }

    } catch (error) {
      console.error(`[Viewer] Failed to load previous chapter for continuous reading:`, error);
    } finally {
      this.continuousLoadingPrevChapter = false;
      // Reset trigger flag so user can retry by scrolling
      if (this.activeReader instanceof VerticalReader) {
        (this.activeReader as VerticalReader).resetPrevChapterRequest();
      }
    }
  }

  /**
   * Eagerly load adjacent chapters after position restore completes.
   * Sets up triggers and immediately loads the next and previous chapters.
   */
  private loadAdjacentChaptersContinuous(): void {
    if (!this.continuousReadingActive || this.currentMode !== 'vertical') return;
    if (!(this.activeReader instanceof VerticalReader)) return;

    const reader = this.activeReader as VerticalReader;

    // Setup intersection triggers for further chapters beyond pre-loaded ones
    reader.setupContinuousTriggers();

    // Eagerly load next chapter (prev is already pre-loaded in initial render)
    this.loadNextChapterContinuous();
  }

  /**
   * Handle chapter change during continuous reading scroll.
   * Updates the toolbar, page counter, and reading state.
   */
  private handleContinuousChapterChange(chapterNumber: number, currentPage: number, totalPages: number): void {
    if (chapterNumber === this.currentChapter) return;

    console.log(`[Viewer] Continuous reading: chapter changed to ${chapterNumber} (page ${currentPage}/${totalPages})`);

    // Save position for the NEW chapter directly using the scroll handler's data.
    // Don't call savePosition() which would re-capture and potentially race.
    if (this.pageData) {
      const position = this.activeReader?.getPosition();
      if (position) {
        readingStateManager.updatePosition(
          this.pageData.slug,
          this.currentSourceId,
          chapterNumber,
          { ...position, anchorImageIndex: currentPage - 1 },
          totalPages
        ).catch(err => console.warn('[Viewer] Failed to save continuous position:', err));
      }
    }

    // Update current chapter
    this.currentChapter = chapterNumber;

    // Update toolbar
    this.updateChapterButton();

    // Update page counter with per-chapter progress
    const progressEl = document.getElementById('cr-progress');
    if (progressEl) {
      progressEl.textContent = `${currentPage}/${totalPages}`;
    }

    // Update chapter bounds for nav buttons
    const isFirstChapter = !this.chapters.some(c => c.number < this.currentChapter);
    const isLastChapter = !this.chapters.some(c => c.number > this.currentChapter);
    this.activeReader?.setChapterBounds(isFirstChapter, isLastChapter);

    // Mark as read based on setting
    if (this.pageData) {
      settingsManager.load().then(settings => {
        if (settings.markReadMode === 'onOpen') {
          this.markChapterAsRead(chapterNumber);
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private _cycleMode(): void {
    const modes: ReadingMode[] = ['vertical', 'single', 'double'];
    const currentIndex = modes.indexOf(this.currentMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.setMode(modes[nextIndex]);
  }

  private async setMode(mode: ReadingMode): Promise<void> {
    if (mode === this.currentMode) return;

    // In continuous-vertical mode, this.currentChapter is updated as the user scrolls
    // through the strip (via handleContinuousChapterChange), but this.pages stays as the
    // originally-loaded chapter's pages. A plain renderPages() would hand the new reader
    // pages from the wrong chapter. Reload the current chapter so single/double readers
    // get the right pages, and the position restore lands on the right page.
    const wasContinuousVertical = this.continuousReadingActive && this.currentMode === 'vertical';
    this.currentMode = mode;

    // Save preference
    if (this.pageData) {
      await readingStateManager.updateDisplaySettings(this.pageData.slug, { readingMode: mode });
    }

    if (wasContinuousVertical) {
      await this.savePosition();
      await this.loadChapter(this.currentChapter);
    } else {
      // Re-render (position conversion happens in renderPages)
      this.renderPages();
    }

    // If switching INTO vertical-continuous from a non-continuous mode, set up triggers
    // and eager-load the adjacent chapter. (When wasContinuousVertical, loadChapter's
    // completeChapterLoad already calls loadAdjacentChaptersContinuous for us.)
    if (mode === 'vertical' && this.continuousReadingActive && !wasContinuousVertical) {
      this.loadAdjacentChaptersContinuous();
    }

    // Update mode button icon
    this.updateModeButtonIcon();
  }

  /**
   * Update mode button to show current mode
   */
  private updateModeButtonIcon(): void {
    const modeBtn = document.getElementById('cr-mode-btn');
    if (!modeBtn) return;

    const icons: Record<ReadingMode, string> = {
      vertical: '<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>',
      single: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/>',
      double: '<path d="M3 5v14h8V5H3zm10 0v14h8V5h-8z"/>',
    };

    modeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">${icons[this.currentMode]}</svg>`;
    modeBtn.title = `Mode: ${this.currentMode} (click to cycle)`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.container?.requestFullscreen();
    }
  }

  private async openSettings(): Promise<void> {
    // Get current source mapping
    let sourceMapping = null;
    if (this.pageData) {
      sourceMapping = await sourceMappingManager.get(this.pageData.slug);
    }

    settingsPanel.show(
      (newSettings: GlobalSettings) => {
        this.applySettings(newSettings);
      },
      () => {
        // onClose - refocus container for keyboard events
        this.container?.focus();
      },
      sourceMapping,
      this.currentSourceId,
      (newSlug: string, details: MangaDetails) => {
        this.handleSlugChange(newSlug, details);
      },
      (newSourceId: string) => {
        this.handleSourceMigration(newSourceId);
      }
    );
  }

  /**
   * Handle slug change from settings
   */
  private async handleSlugChange(newSlug: string, details?: MangaDetails): Promise<void> {
    if (!this.pageData) return;

    console.log('[Viewer] Changing slug to:', newSlug);

    // Get current source
    const source = sourceRegistry.get(this.currentSourceId);
    if (!source) {
      console.error('[Viewer] Source not found:', this.currentSourceId);
      return;
    }

    // Update the mapping with the new slug
    await sourceMappingManager.setSource(
      this.pageData.slug,
      this.pageData.title,
      this.currentSourceId,
      {
        slug: newSlug,
        baseSlug: newSlug.replace(/-\d+$/, ''),
        title: details?.title || this.pageData.title,
        available: true,
        lastChecked: Date.now()
      }
    );

    // Reload the chapter list and current chapter
    this.chapters = [];
    await this.loadChapter(this.currentChapter);
  }

  /**
   * Handle source migration from settings dropdown.
   * Opens SourceMatchModal locked to the target source.
   */
  private handleSourceMigration(newSourceId: string): void {
    if (!this.pageData) return;

    sourceMatchModal.show(
      this.pageData,
      async (sourceId: string, result: SearchResult) => {
        // User selected a match on the new source
        this.currentSourceId = sourceId;

        // Update toolbar title to the source result title
        this.toolbarTitleCombobox?.updateDisplayTitle(result.title);

        this.overlay.showLoading('Loading chapters...');

        try {
          const source = sourceRegistry.get(sourceId);
          if (!source) throw new Error('Source not found');

          this.chapters = await source.getChapterList(result.slug);
          if (this.chapters.length === 0) {
            this.overlay.showError('No chapters found for this manga', () => this.loadChapter(this.currentChapter));
            return;
          }

          this.updateChapterDropdown();

          // Try to stay on the current chapter, fallback to first available
          let targetChapter = this.currentChapter;
          if (!this.chapters.find(c => c.number === targetChapter)) {
            const sorted = [...this.chapters].sort((a, b) => a.number - b.number);
            targetChapter = sorted[0]?.number ?? 1;
          }

          // Skip position restore — page sizes differ across sources
          await this.loadChapter(targetChapter, true);
        } catch (error) {
          this.overlay.showError(`Failed to load: ${(error as Error).message}`, () => this.loadChapter(this.currentChapter));
        }
      },
      () => {
        // Cancel migration — stay in reader, refocus
        this.container?.focus();
      },
      { forcedSourceId: newSourceId }
    );
  }

  /**
   * Apply settings changes
   */
  private async applySettings(settings: GlobalSettings): Promise<void> {
    // Update keyboard handler
    this.keyboard.setEnabled(settings.keyboardShortcutsEnabled);

    // Update auto-hide setting
    this.autoHideEnabled = settings.toolbarAutoHide;
    this.toolbarHideDelay = settings.toolbarHideDelay;
    if (this.autoHideEnabled && this.toolbarVisible) {
      this.scheduleToolbarHide();
    } else if (!this.autoHideEnabled) {
      this.cancelToolbarHide();
      this.showToolbar();
    }

    // Update scrollbar auto-hide setting
    this.scrollbarAutoHideEnabled = settings.scrollbarAutoHide;
    this.setupCustomScrollbar();

    // Update background color
    this.currentBgColor = settings.backgroundColor;
    if (this.contentArea) {
      this.contentArea.style.backgroundColor = settings.backgroundColor;
    }

    // Update scroll settings
    this.currentScrollAmount = settings.scrollAmount;
    this.currentScrollSpeed = settings.scrollSpeed;

    // Capture scroll position before fit change (vertical mode only)
    const fitChanged = settings.defaultImageFit !== this.currentFit;
    let savedPosition = fitChanged && this.currentMode === 'vertical' && this.activeReader
      ? this.activeReader.getPosition()
      : null;

    // Update image fit
    this.currentFit = settings.defaultImageFit;
    this.applyFitClass();

    // Push all reader-relevant settings at once
    if (this.activeReader) {
      this.activeReader.configure({
        scrollAmount: settings.scrollAmount,
        scrollSpeed: settings.scrollSpeed,
        backgroundColor: settings.backgroundColor,
        imageFit: settings.defaultImageFit,
      });
    }

    // Restore scroll position after layout settles (vertical mode only)
    if (savedPosition && this.activeReader && this.contentArea) {
      requestAnimationFrame(() => {
        void this.contentArea!.offsetHeight;
        this.activeReader?.restorePosition(savedPosition!);
      });
    }

    // Update cache settings
    updateCacheSettings(settings);

    // Update continuous reading — reload chapter if the setting changed while in vertical mode
    const continuousChanged = this.continuousReadingActive !== settings.continuousReading;
    this.continuousReadingActive = settings.continuousReading;

    if (continuousChanged && this.currentMode === 'vertical' && this.activeReader) {
      // Save position before reloading so it can be restored
      await this.savePosition();
      await this.loadChapter(this.currentChapter);
    }

    // Note: Reading mode changes only affect new sessions
    // Current mode is preserved during this session
  }

  private async changeSource(sourceId: string): Promise<void> {
    if (sourceId === this.currentSourceId || !this.pageData) return;
    
    // Check if we have mapping for this source
    const mapping = await sourceMappingManager.get(this.pageData.slug);
    if (!mapping || !mapping.sources[sourceId]) {
      // Need to search for this source
      console.log('Need to search for manga on new source:', sourceId);
      return;
    }

    // Switch to the new source
    await sourceMappingManager.setSelectedSource(this.pageData.slug, sourceId);
    this.currentSourceId = sourceId;
    
    // Reload chapters and current chapter
    this.chapters = [];
    await this.loadChapter(this.currentChapter);
  }

  private updateProgress(): void {
    if (!this.activeReader) return;

    const progressEl = document.getElementById('cr-progress');
    if (!progressEl) return;

    // Capture position once to avoid double-capture
    const position = this.activeReader.getPosition();

    // Detect continuous mode from the READER's state, not this.continuousReadingActive.
    // applySettings flips that flag BEFORE destroying the continuous reader, so during the
    // toggle-off window the OLD continuous strip is still rendered. Gating on the flag
    // would show standard-chapter progress (raw global index over chapter total) and
    // display nonsense like "26/20" if the user scrolls during that microtask gap.
    if (this.activeReader instanceof VerticalReader) {
      const progress = (this.activeReader as VerticalReader).getContinuousProgress(position);
      if (progress) {
        progressEl.textContent = `${progress.currentPage}/${progress.totalPages}`;
        return;
      }
    }

    // Standard single-chapter progress
    const currentPage = position.anchorImageIndex + 1;
    const totalPages = this.activeReader?.getTotalPages() || this.pages.length || 1;
    progressEl.textContent = `${currentPage}/${totalPages}`;
  }

  private async savePosition(): Promise<void> {
    if (!this.pageData || !this.activeReader) return;

    // Capture position once — avoid double-capture race between getPosition() and getContinuousProgress()
    const position = this.activeReader.getPosition();

    // Detect continuous mode from the READER's state (getContinuousProgress returns null
    // unless the VerticalReader actually has continuousReadingEnabled + a manager). Do NOT
    // check this.continuousReadingActive here — that's the Viewer's setting flag, which
    // applySettings flips BEFORE calling savePosition when toggling continuous off. If we
    // gated on the setting, the toggle-off path would fall through and save the strip's
    // GLOBAL index as the chapter's local index (and the strip total as the chapter total),
    // which restores clamped to the last page of the chapter — the "far lower" bug.
    //
    // Saving under progress.chapterNumber (anchor's chapter, viewport top), not
    // this.currentChapter (center-tracked) — when the viewport straddles a chapter
    // boundary those disagree, and using currentChapter writes the anchor chapter's
    // local index into the wrong chapter's storage slot.
    if (this.activeReader instanceof VerticalReader) {
      const progress = (this.activeReader as VerticalReader).getContinuousProgress(position);
      if (progress) {
        const localPosition = {
          ...position,
          anchorImageIndex: progress.currentPage - 1,
        };
        await readingStateManager.updatePosition(
          this.pageData.slug,
          this.currentSourceId,
          progress.chapterNumber,
          localPosition,
          progress.totalPages
        );
        return;
      }
    }

    // Standard single-chapter save
    await readingStateManager.updatePosition(
      this.pageData.slug,
      this.currentSourceId,
      this.currentChapter,
      position,
      this.activeReader?.getTotalPages() || this.pages.length
    );
  }

  /**
   * Save display settings (mode, fit, etc.) - called by setMode directly
   */
  private async _saveDisplaySettings(): Promise<void> {
    if (!this.pageData) return;

    await readingStateManager.updateDisplaySettings(this.pageData.slug, {
      readingMode: this.currentMode,
      imageFit: this.currentFit
    });
  }

  /**
   * Periodic auto-save of reading position
   */
  private startAutoSave(): void {
    // Clear any existing interval
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    
    // Auto-save position every 10 seconds
    this.autoSaveInterval = window.setInterval(() => {
      if (this.isOpen && this.activeReader) {
        this.savePosition();
      }
    }, 10000);
  }

  /**
   * Stop auto-save interval
   */
  private stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
  }
}

// Export singleton instance
export const viewer = new Viewer();