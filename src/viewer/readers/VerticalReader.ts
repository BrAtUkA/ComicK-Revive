import { PageInfo, ImageFit, ReadingPosition, Chapter } from '@/types';
import { BaseReader } from './BaseReader';
import { debounce, SmoothScroller } from '@/utils';
import { loadImage, LoadedImage } from '@/utils/imageLoader';
import { ContinuousReadingManager, CacheContextBase } from './ContinuousReadingManager';
import type { ChapterSegment } from './ContinuousReadingManager';

/**
 * VerticalReader - Continuous vertical scrolling mode
 *
 * Displays all pages in a vertical strip that the user scrolls through.
 * Optimized for webtoon-style content.
 */
export class VerticalReader extends BaseReader {
  private backgroundColor: string = '#0a0a0a';
  private gap: number = 0;
  private preloadCount: number = 3;
  private scrollAmount: number = 80;
  private scrollSpeed: number = 5;
  private scrollHandler: (() => void) | null = null;
  private chapterScrollHandler: (() => void) | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private loadedImages: Set<number> = new Set();  // Tracks images we've started loading (for dedup)
  private fullyLoadedImages: Set<number> = new Set();  // Tracks images that have finished loading
  private anchorCallbackFired: boolean = false;

  // Position restoration
  private targetAnchorIndex: number = -1;  // How many images we need to load before restore
  private static readonly ANCHOR_BUFFER = 3;  // Load a few extra pages past anchor
  private isRestoringPosition: boolean = false;  // Suppresses scroll capture during restoration

  // Sequential loading (for new chapters to prevent spoilers)
  private sequentialLoadingEnabled: boolean = false;
  private sequentialLoadIndex: number = 0;  // Next image to display in sequence (display cursor)
  private prefetchResults: Map<number, Promise<LoadedImage>> = new Map();  // In-flight fetch promises
  private static readonly PREFETCH_WINDOW = 4;  // How many images to fetch ahead of display cursor

  // Custom smooth scrolling
  private smoothScroller: SmoothScroller = new SmoothScroller();

  // Continuous reading state
  private continuousReadingEnabled: boolean = false;
  private continuousMainChapter: Chapter | null = null;  // The primary chapter being loaded
  private continuousManager: ContinuousReadingManager | null = null;
  private nextChapterTriggerObserver: IntersectionObserver | null = null;
  private nextChapterTriggerElement: HTMLElement | null = null;

  // Previous chapter trigger (deferred until after position restoration completes)
  private prevChapterTriggerObserver: IntersectionObserver | null = null;
  private prevChapterTriggerElement: HTMLElement | null = null;
  onRequestPrevChapter?: () => void;

  // Pre-loaded chapters to include in initial render (avoids async prepend after load)
  private preloadedPrevChapters: Array<{
    chapter: Chapter;
    pages: PageInfo[];
    cacheContext?: { sourceId: string; mangaSlug: string; chapterSlug: string };
    isFirst: boolean;
  }> = [];
  private preloadedPageCount: number = 0;  // Stored after render consumes preloadedPrevChapters

  // Suppress chapter-change detection during programmatic smooth scrolls (e.g., chapter picker).
  // Without this, the chapter scroll handler fires for every intermediate chapter the viewport
  // center crosses during the animation, causing currentChapter to oscillate.
  private suppressChapterDetection: boolean = false;
  private suppressChapterDetectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    super(container);
    this.setupScrollHandler();
  }

  /**
   * Configure the reader
   */
  configure(options: {
    imageFit?: ImageFit;
    zoom?: number;
    backgroundColor?: string;
    gap?: number;
    preloadCount?: number;
    scrollAmount?: number;
    scrollSpeed?: number;
  }): void {
    const fitChanged = options.imageFit !== undefined && options.imageFit !== this.imageFit;
    const zoomChanged = options.zoom !== undefined && options.zoom !== this.zoom;

    if (options.imageFit !== undefined) this.imageFit = options.imageFit;
    if (options.zoom !== undefined) this.zoom = options.zoom;
    if (options.backgroundColor !== undefined) this.backgroundColor = options.backgroundColor;
    if (options.gap !== undefined) this.gap = options.gap;
    if (options.preloadCount !== undefined) this.preloadCount = options.preloadCount;
    if (options.scrollAmount !== undefined) this.scrollAmount = options.scrollAmount;
    if (options.scrollSpeed !== undefined) {
      this.scrollSpeed = options.scrollSpeed;
      // Map scrollSpeed (1–10) to smoothing for tap animations
      // Speed 1 → 0.125 (responsive min), Speed 5 → 0.225, Speed 10 → 0.35 (snappy)
      this.smoothScroller.setSmoothing(0.10 + 0.025 * options.scrollSpeed);
    }
    
    // Re-apply fit/zoom styles to existing wrappers if changed
    if (fitChanged || zoomChanged) {
      this.applyFitToWrappers();
    }
  }
  
  /**
   * Apply current imageFit and zoom to all existing wrappers
   */
  private applyFitToWrappers(): void {
    const zoomFactor = this.zoom / 100;
    const baseMaxWidth = 900;
    const zoomedMaxWidth = Math.round(baseMaxWidth * zoomFactor);

    const wrappers = this.container.querySelectorAll('.cr-page-wrapper');
    wrappers.forEach(wrapper => {
      const el = wrapper as HTMLElement;
      switch (this.imageFit) {
        case 'width':
          el.style.width = '100%';
          el.style.maxWidth = `${zoomedMaxWidth}px`;
          el.style.height = 'auto';
          el.style.maxHeight = 'none';
          el.style.margin = '0 auto';
          break;
        case 'height':
          el.style.width = 'auto';
          el.style.maxWidth = 'none';
          el.style.height = `${100 * zoomFactor}vh`;
          el.style.maxHeight = 'none';
          el.style.margin = '0 auto';
          break;
        case 'contain':
          el.style.width = '100%';
          el.style.maxWidth = `${zoomedMaxWidth}px`;
          el.style.height = 'auto';
          el.style.maxHeight = `${100 * zoomFactor}vh`;
          el.style.margin = '0 auto';
          break;
        case 'original': {
          // Original size = image's natural pixel width × zoom. No cap.
          // The contentArea CSS `.cr-fit-original.cr-mode-vertical { overflow-x: auto }`
          // provides horizontal scroll when the image is wider than the viewport.
          const pageIndex = parseInt(el.dataset.pageIndex || '-1');
          const page = pageIndex >= 0 ? this.pages[pageIndex] : null;
          if (page?.width) {
            el.style.width = `${page.width * zoomFactor}px`;
            el.style.maxWidth = 'none';
          } else {
            // Dimensions not yet known — clear inline styles so the CSS default
            // (width:100% max-width:900px) acts as the placeholder size until load.
            el.style.width = '';
            el.style.maxWidth = '';
          }
          el.style.height = 'auto';
          el.style.maxHeight = 'none';
          el.style.margin = '0 auto';
          break;
        }
      }

      // Reset transform on all wrappers
      el.style.transform = 'none';
    });
  }

  /**
   * Setup scroll handler for position tracking
   */
  private setupScrollHandler(): void {
    this.scrollHandler = debounce(() => {
      // Don't capture during position restoration - would overwrite the anchor we're trying to restore to
      if (this.isRestoringPosition) {
        console.log('[VerticalReader] Scroll capture suppressed during restoration');
        return;
      }
      const position = this.scrollAnchor.capture(this.container, this.imageElements);
      this.onPositionChange?.(position);
    }, 100);

    this.container.addEventListener('scroll', this.scrollHandler);
  }

  /**
   * Setup real-time chapter detection for continuous reading.
   * Must be called AFTER enableContinuousReading() since it depends on continuousReadingEnabled.
   */
  private setupChapterScrollHandler(): void {
    // Clean up previous handler if any
    if (this.chapterScrollHandler) {
      this.container.removeEventListener('scroll', this.chapterScrollHandler);
      this.chapterScrollHandler = null;
    }

    if (!this.continuousReadingEnabled) return;

    let chapterRafPending = false;
    this.chapterScrollHandler = () => {
      if (chapterRafPending || this.isRestoringPosition || this.suppressChapterDetection || !this.continuousManager || this.continuousManager.getSegments().length <= 1) return;
      chapterRafPending = true;
      requestAnimationFrame(() => {
        chapterRafPending = false;
        // Find which image is at the viewport center using a lightweight check
        const containerRect = this.container.getBoundingClientRect();
        const centerY = containerRect.top + containerRect.height / 2;
        let anchorIndex = 0;
        for (let i = 0; i < this.imageElements.length; i++) {
          const rect = this.imageElements[i].getBoundingClientRect();
          if (rect.bottom >= centerY) {
            anchorIndex = i;
            break;
          }
          anchorIndex = i;
        }
        const seg = this.continuousManager!.getSegmentForIndex(anchorIndex);
        if (seg) {
          const segIdx = this.continuousManager!.indexOfSegment(seg);
          if (segIdx !== this.continuousManager!.currentSegmentIndex) {
            this.continuousManager!.currentSegmentIndex = segIdx;
            const localPage = anchorIndex - seg.startIndex + 1;
            this.onCurrentChapterChange?.(seg.chapterNumber, localPage, seg.pageCount);
          }
        }
      });
    };
    this.container.addEventListener('scroll', this.chapterScrollHandler);
  }

  /**
   * Enable sequential loading mode for new chapters.
   * Images will load one by one in order to prevent spoilers.
   */
  enableSequentialLoading(): void {
    console.log('[VerticalReader] Sequential loading enabled');
    this.sequentialLoadingEnabled = true;
    this.sequentialLoadIndex = 0;
    this.prefetchResults.clear();
  }

  /**
   * Enable continuous reading mode.
   * When enabled, the reader will request and append next chapter pages
   * instead of showing end-of-chapter navigation.
   */
  enableContinuousReading(currentChapter: Chapter, cacheContext?: CacheContextBase): void {
    this.continuousReadingEnabled = true;
    this.continuousMainChapter = currentChapter;
    this.continuousManager = new ContinuousReadingManager(currentChapter, cacheContext);
    // Segments are built in render() to handle both preloaded and non-preloaded cases
  }

  /**
   * Set pre-loaded previous chapters to include in the initial render.
   * Call BEFORE render(). These chapters appear above the main chapter
   * in the continuous strip, avoiding async prepend and scroll jumps.
   * Chapters should be ordered from earliest to latest (closest to current last).
   */
  setPreloadedPrevChapters(chapters: Array<{
    chapter: Chapter;
    pages: PageInfo[];
    cacheContext?: { sourceId: string; mangaSlug: string; chapterSlug: string };
    isFirst: boolean;
  }>): void {
    this.preloadedPrevChapters = chapters;
  }

  /**
   * Get the number of pages prepended by pre-loaded chapters.
   * Used by Viewer to offset position restore. Safe to call after render().
   */
  getPreloadedPageCount(): number {
    return this.preloadedPageCount;
  }

  /**
   * Append a new chapter's pages to the continuous scroll.
   * Called by Viewer when next chapter pages are ready.
   */
  appendChapter(chapter: Chapter, newPages: PageInfo[], cacheContext?: { sourceId: string; mangaSlug: string; chapterSlug: string }, isLast?: boolean): void {
    if (!this.continuousReadingEnabled || !this.continuousManager || newPages.length === 0) return;

    const globalStartIndex = this.imageElements.length;

    // Store per-page cache context for correct caching of appended chapter images
    if (cacheContext) {
      this.continuousManager.setCacheContexts(globalStartIndex, newPages.length, cacheContext);
    }

    // Track the new segment
    this.continuousManager.addSegment(chapter, globalStartIndex, newPages.length);

    // Remove the chapter navigation (end-of-chapter buttons) if present
    const existingNav = this.container.querySelector('.cr-chapter-nav');
    existingNav?.remove();

    // Create chapter divider
    const segments = this.continuousManager.getSegments();
    const lastSegment = segments[segments.length - 2];
    const divider = this.createChapterDivider(lastSegment.chapterNumber, chapter.number);
    this.container.appendChild(divider);

    // Ensure IntersectionObserver exists for lazy loading appended pages.
    // The initial chapter may have used sequential loading, which skips setupLazyLoading().
    if (!this.intersectionObserver) {
      this.setupLazyLoading();
    }

    // Add all new pages as wrappers
    this.pages.push(...newPages);
    for (let i = 0; i < newPages.length; i++) {
      const globalIndex = globalStartIndex + i;
      const wrapper = this.createPageWrapper(newPages[i], globalIndex);
      this.container.appendChild(wrapper);
      this.imageElements.push(wrapper);

      // Observe for lazy loading
      this.intersectionObserver!.observe(wrapper);
    }

    // Update chapter bounds for the appended chapter's nav buttons
    if (isLast !== undefined) {
      this.isLastChapter = isLast;
    }

    // Re-add chapter navigation at the very end
    this.container.appendChild(this.createChapterNavigation());

    // Setup trigger for next chapter preload
    this.setupNextChapterTrigger();

    // Allow requesting the next chapter again
    this.continuousManager!.nextRequested = false;

    console.log(`[VerticalReader] Appended chapter ${chapter.number}: ${newPages.length} pages (global ${globalStartIndex}-${globalStartIndex + newPages.length - 1})`);
  }

  /**
   * Prepend a previous chapter's pages above the current scroll.
   * Preserves scroll position so the user doesn't see a jump.
   *
   * IMPORTANT: Must NEVER be called while restorePosition() is in flight.
   * The Viewer ensures this by only triggering prepend after onAnchorImagesReady fires.
   */
  prependChapter(chapter: Chapter, newPages: PageInfo[], cacheContext?: { sourceId: string; mangaSlug: string; chapterSlug: string }, isFirst?: boolean): void {
    if (!this.continuousReadingEnabled || !this.continuousManager || newPages.length === 0) return;
    if (this.isRestoringPosition) {
      console.warn('[VerticalReader] prependChapter called during position restore — ignoring');
      return;
    }

    const pageCount = newPages.length;

    // Capture scroll state before DOM changes
    const oldScrollHeight = this.container.scrollHeight;

    // Shift all existing cache contexts and add new ones for the prepended pages
    this.continuousManager.shiftCacheContexts(pageCount);
    if (cacheContext) {
      this.continuousManager.setCacheContexts(0, pageCount, cacheContext);
    }

    // Shift existing segments and add new segment at front
    this.continuousManager.prependSegment(chapter, pageCount);

    // Shift loadedImages and fullyLoadedImages sets
    const shiftedLoaded = new Set<number>();
    for (const idx of this.loadedImages) shiftedLoaded.add(idx + pageCount);
    this.loadedImages = shiftedLoaded;

    const shiftedFully = new Set<number>();
    for (const idx of this.fullyLoadedImages) shiftedFully.add(idx + pageCount);
    this.fullyLoadedImages = shiftedFully;

    // Ensure IntersectionObserver exists
    if (!this.intersectionObserver) {
      this.setupLazyLoading();
    }

    // Prepend pages array
    this.pages.unshift(...newPages);

    // Create DOM elements for new pages
    const fragment = document.createDocumentFragment();
    const newImageElements: HTMLElement[] = [];

    for (let i = 0; i < pageCount; i++) {
      const wrapper = this.createPageWrapper(newPages[i], i);
      fragment.appendChild(wrapper);
      newImageElements.push(wrapper);
      this.intersectionObserver!.observe(wrapper);
    }

    // Create divider between prepended chapter and existing first chapter
    const existingFirstSeg = this.continuousManager!.getSegments()[1];
    const divider = this.createChapterDivider(chapter.number, existingFirstSeg.chapterNumber);
    fragment.appendChild(divider);

    // Insert at the beginning of the container
    this.container.insertBefore(fragment, this.container.firstChild);

    // Update existing wrapper data-pageIndex attributes (shifted by pageCount)
    for (const el of this.imageElements) {
      const oldIdx = parseInt(el.dataset.pageIndex || '0');
      el.dataset.pageIndex = String(oldIdx + pageCount);
    }

    // Merge imageElements
    this.imageElements = [...newImageElements, ...this.imageElements];

    // Update chapter bounds
    if (isFirst !== undefined) {
      this.isFirstChapter = isFirst;
    }

    // Restore scroll position so user doesn't see a jump
    const addedHeight = this.container.scrollHeight - oldScrollHeight;
    this.container.scrollTop += addedHeight;

    // Setup trigger for next prepend
    this.setupPrevChapterTrigger();

    // Allow requesting previous chapter again
    this.continuousManager!.prevRequested = false;

    console.log(`[VerticalReader] Prepended chapter ${chapter.number}: ${pageCount} pages. Scroll adjusted by ${addedHeight}px`);
  }

  /**
   * Setup an IntersectionObserver trigger near the top to request the previous chapter.
   * MUST NOT be called during position restoration — only after restore completes.
   */
  private setupPrevChapterTrigger(): void {
    // Clean up previous trigger
    if (this.prevChapterTriggerElement && this.prevChapterTriggerObserver) {
      this.prevChapterTriggerObserver.unobserve(this.prevChapterTriggerElement);
    }

    if (this.isFirstChapter) return;

    // Trigger at page 3 of the first segment (not page 0 — avoids firing immediately)
    const segments = this.continuousManager!.getSegments();
    const firstSeg = segments[0];
    const triggerIndex = firstSeg.startIndex + Math.min(3, firstSeg.pageCount - 1);
    const triggerEl = this.imageElements[triggerIndex];
    if (!triggerEl) return;

    this.prevChapterTriggerElement = triggerEl;

    if (!this.prevChapterTriggerObserver) {
      this.prevChapterTriggerObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.continuousManager!.prevRequested && !this.isRestoringPosition) {
              this.continuousManager!.prevRequested = true;
              console.log('[VerticalReader] Requesting previous chapter (preload trigger)');
              this.onRequestPrevChapter?.();
            }
          }
        },
        {
          root: this.container,
          rootMargin: '400px 0px',
          threshold: 0,
        }
      );
    }

    this.prevChapterTriggerObserver.observe(triggerEl);
  }

  /**
   * Setup triggers for adjacent chapter loading.
   * Called by Viewer AFTER position restoration completes (not during render).
   */
  setupContinuousTriggers(): void {
    if (!this.continuousReadingEnabled) return;
    if (!this.isLastChapter) this.setupNextChapterTrigger();
    if (!this.isFirstChapter) this.setupPrevChapterTrigger();
  }

  /**
   * Create a minimal divider between chapters in continuous reading mode.
   */
  private createChapterDivider(endChapter: number, startChapter: number): HTMLElement {
    const divider = document.createElement('div');
    divider.className = 'cr-chapter-divider';
    divider.dataset.chapterStart = String(startChapter);
    divider.innerHTML = `
      <span class="cr-chapter-divider-label">Chapter ${endChapter} End</span>
      <div class="cr-chapter-divider-line"></div>
      <span class="cr-chapter-divider-label">Chapter ${startChapter} Start</span>
    `;
    return divider;
  }

  /**
   * Setup an IntersectionObserver trigger near the end of the current last chapter
   * to request preloading the next chapter.
   */
  private setupNextChapterTrigger(): void {
    // Clean up previous trigger
    if (this.nextChapterTriggerElement && this.nextChapterTriggerObserver) {
      this.nextChapterTriggerObserver.unobserve(this.nextChapterTriggerElement);
    }

    // Place trigger ~5 pages from the end of the last segment
    const segments = this.continuousManager!.getSegments();
    const lastSeg = segments[segments.length - 1];
    const triggerIndex = lastSeg.startIndex + lastSeg.pageCount - Math.min(5, lastSeg.pageCount);
    const triggerEl = this.imageElements[triggerIndex];
    if (!triggerEl) return;

    this.nextChapterTriggerElement = triggerEl;

    if (!this.nextChapterTriggerObserver) {
      this.nextChapterTriggerObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.continuousManager!.nextRequested) {
              this.continuousManager!.nextRequested = true;
              console.log('[VerticalReader] Requesting next chapter (preload trigger)');
              this.onRequestNextChapter?.();
            }
          }
        },
        {
          root: this.container,
          rootMargin: '400px 0px',
          threshold: 0,
        }
      );
    }

    this.nextChapterTriggerObserver.observe(triggerEl);
  }

  /**
   * Get the current chapter's local page and total for progress display.
   * Accepts an optional pre-captured position to avoid double-capturing.
   * Returns null if not in continuous reading mode.
   */
  getContinuousProgress(preCapture?: ReadingPosition): { chapterNumber: number; currentPage: number; totalPages: number } | null {
    if (!this.continuousReadingEnabled || !this.continuousManager) return null;

    const position = preCapture ?? this.scrollAnchor.capture(this.container, this.imageElements);
    return this.continuousManager.getContinuousProgress(position.anchorImageIndex);
  }

  /**
   * Get all chapter segments (for external queries like duplicate detection).
   */
  getChapterSegments(): readonly ChapterSegment[] {
    return this.continuousManager?.getSegments() ?? [];
  }

  /**
   * Get per-page cache context for a global index (used by Viewer for dimension persistence).
   */
  getPageCacheContext(globalIndex: number): { sourceId: string; mangaSlug: string; chapterSlug: string; localIndex: number } | undefined {
    return this.continuousManager?.getCacheContext(globalIndex);
  }

  /**
   * Get the chapter segment for a given global image index.
   */
  getSegmentForIndex(globalIndex: number): ChapterSegment | null {
    return this.continuousManager?.getSegmentForIndex(globalIndex) ?? null;
  }

  /**
   * Render all pages
   */
  render(): void {
    // Clear container
    this.container.innerHTML = '';
    this.imageElements = [];
    this.loadedImages.clear();
    this.fullyLoadedImages.clear();
    this.anchorCallbackFired = false;

    // Start at top to avoid flashing old scroll position during load
    this.container.scrollTop = 0;

    // Apply styles
    this.container.style.backgroundColor = this.backgroundColor;
    this.container.className = 'cr-viewer-content cr-mode-vertical';

    // Attach smooth scroller to container
    this.smoothScroller.attach(this.container);

    // Build the page strip: preloaded prev chapters + main chapter
    const hasPreloaded = this.continuousReadingEnabled && this.preloadedPrevChapters.length > 0;
    let globalIndex = 0;

    if (hasPreloaded) {
      // Prepend preloaded pages to this.pages array
      const allPreloadedPages = this.preloadedPrevChapters.flatMap(ch => ch.pages);
      this.pages.unshift(...allPreloadedPages);

      // Render preloaded chapters with dividers between them
      for (let pIdx = 0; pIdx < this.preloadedPrevChapters.length; pIdx++) {
        const preloaded = this.preloadedPrevChapters[pIdx];

        // Add segment
        this.continuousManager!.addSegment(preloaded.chapter, globalIndex, preloaded.pages.length);

        // Store cache contexts
        if (preloaded.cacheContext) {
          this.continuousManager!.setCacheContexts(globalIndex, preloaded.pages.length, preloaded.cacheContext);
        }

        // Create page wrappers
        for (let i = 0; i < preloaded.pages.length; i++) {
          const wrapper = this.createPageWrapper(preloaded.pages[i], globalIndex);
          this.container.appendChild(wrapper);
          this.imageElements.push(wrapper);
          globalIndex++;
        }

        // Update isFirstChapter
        if (preloaded.isFirst) {
          this.isFirstChapter = true;
        }

        // Divider between this preloaded chapter and the next one (or main chapter)
        const nextChapterNum = pIdx < this.preloadedPrevChapters.length - 1
          ? this.preloadedPrevChapters[pIdx + 1].chapter.number
          : this.continuousMainChapter!.number;
        const divider = this.createChapterDivider(preloaded.chapter.number, nextChapterNum);
        this.container.appendChild(divider);
      }

      // Add main chapter segment
      const mainPageCount = this.pages.length - globalIndex;
      this.continuousManager!.addSegment(this.continuousMainChapter!, globalIndex, mainPageCount);

      // Store cache contexts for main chapter pages (prevents cache key mismatch on resume)
      if (this.continuousManager!.mainCacheContext) {
        this.continuousManager!.setCacheContexts(globalIndex, mainPageCount, this.continuousManager!.mainCacheContext);
      }

      // Current segment is the main chapter (last one)
      this.continuousManager!.currentSegmentIndex = this.continuousManager!.getSegments().length - 1;

      // Store preloaded page count for position offset, then clear
      this.preloadedPageCount = globalIndex;
      this.preloadedPrevChapters = [];
    } else if (this.continuousReadingEnabled && this.continuousManager && this.continuousMainChapter) {
      // No preloaded chapters — just the main chapter
      this.continuousManager.addSegment(this.continuousMainChapter, 0, this.pages.length);

      // Store cache contexts for main chapter pages (prevents cache key mismatch on resume)
      if (this.continuousManager.mainCacheContext) {
        this.continuousManager.setCacheContexts(0, this.pages.length, this.continuousManager.mainCacheContext);
      }
    }

    // Create page wrappers for main chapter pages
    for (let i = globalIndex; i < this.pages.length; i++) {
      const wrapper = this.createPageWrapper(this.pages[i], i);
      this.container.appendChild(wrapper);
      this.imageElements.push(wrapper);
    }

    // Add chapter navigation at the end (continuous mode will replace this when next chapter loads)
    this.container.appendChild(this.createChapterNavigation());

    // NOTE: Continuous reading triggers (next/prev chapter) are NOT set up here.
    // They are deferred to setupContinuousTriggers(), called by Viewer after
    // position restoration completes. This prevents race conditions.

    // Setup real-time chapter detection for continuous reading
    this.setupChapterScrollHandler();

    // Setup loading strategy
    if (this.sequentialLoadingEnabled) {
      if (this.preloadedPageCount > 0) {
        // Start sequential display from main chapter, not preloaded pages.
        // Preloaded pages load lazily when user scrolls up.
        this.sequentialLoadIndex = this.preloadedPageCount;
        this.setupLazyLoading();
      }
      this.startSequentialDisplayLoop();
    } else {
      // Normal lazy loading via intersection observer
      this.setupLazyLoading();
    }

    // Restore position after render (only if not doing a proper restore flow)
    requestAnimationFrame(() => {
      // Skip if we're doing a proper restore via restorePosition()
      if (this.isRestoringPosition) {
        console.log('[VerticalReader] Skipping render restore - using restorePosition flow');
        return;
      }
      const anchor = this.scrollAnchor.getAnchor();
      if (anchor) {
        this.scrollAnchor.restore(this.container, this.imageElements);
      }
    });
  }

  /**
   * Start the sequential display loop with prefetch pipeline.
   * Fetches PREFETCH_WINDOW images ahead while displaying in strict order.
   */
  private startSequentialDisplayLoop(): void {
    if (!this.sequentialLoadingEnabled) return;
    this.fillPrefetchWindow();
    this.advanceDisplayLoop();
  }

  /**
   * Fill the prefetch window — start loading images ahead of the display cursor.
   * Each call ensures up to PREFETCH_WINDOW fetches are in flight.
   */
  private fillPrefetchWindow(): void {
    const windowEnd = Math.min(
      this.sequentialLoadIndex + VerticalReader.PREFETCH_WINDOW,
      this.pages.length
    );
    for (let i = this.sequentialLoadIndex; i < windowEnd; i++) {
      if (this.prefetchResults.has(i) || this.loadedImages.has(i)) continue;
      const page = this.pages[i];
      if (!page) continue;
      const knownDims = (page.width && page.height)
        ? { width: page.width, height: page.height }
        : undefined;
      this.prefetchResults.set(i, loadImage(page.url, i, knownDims));
    }
  }

  /**
   * Display the next image in sequence by awaiting its prefetch result.
   * Images always appear in strict page order (no spoilers).
   */
  private async advanceDisplayLoop(): Promise<void> {
    if (!this.sequentialLoadingEnabled) return;
    if (this.sequentialLoadIndex >= this.pages.length) {
      console.log('[VerticalReader] Sequential loading complete');
      this.sequentialLoadingEnabled = false;
      this.prefetchResults.clear();
      return;
    }

    const index = this.sequentialLoadIndex;
    const wrapper = this.imageElements[index];
    const page = this.pages[index];

    if (!wrapper || !page) {
      this.sequentialLoadIndex++;
      this.fillPrefetchWindow();
      this.advanceDisplayLoop();
      return;
    }

    // Skip if already loaded
    if (this.loadedImages.has(index)) {
      this.sequentialLoadIndex++;
      this.prefetchResults.delete(index);
      this.fillPrefetchWindow();
      this.advanceDisplayLoop();
      return;
    }

    this.loadedImages.add(index);

    // Get or start the prefetch for this index
    let prefetchPromise = this.prefetchResults.get(index);
    if (!prefetchPromise) {
      const knownDims = (page.width && page.height)
        ? { width: page.width, height: page.height }
        : undefined;
      prefetchPromise = loadImage(page.url, index, knownDims);
      this.prefetchResults.set(index, prefetchPromise);
    }

    try {
      const loadedImage = await prefetchPromise;
      this.prefetchResults.delete(index);

      // Set aspect ratio BEFORE creating/displaying image to prevent layout shift
      // If overlay is dismissed and user is reading, re-anchor scroll around the dimension change
      if (loadedImage.width && loadedImage.height) {
        const shouldReanchor = !this.isRestoringPosition && this.anchorCallbackFired;

        if (shouldReanchor) {
          this.scrollAnchor.capture(this.container, this.imageElements);
          wrapper.style.aspectRatio = `${loadedImage.width}/${loadedImage.height}`;
          if (this.imageFit === 'original') {
            wrapper.style.width = `${loadedImage.width * (this.zoom / 100)}px`;
            wrapper.style.maxWidth = 'none';
          }
          void this.container.offsetHeight;
          this.scrollAnchor.restore(this.container, this.imageElements);
        } else {
          wrapper.style.aspectRatio = `${loadedImage.width}/${loadedImage.height}`;
          if (this.imageFit === 'original') {
            wrapper.style.width = `${loadedImage.width * (this.zoom / 100)}px`;
            wrapper.style.maxWidth = 'none';
          }
        }

        // Notify if page didn't already have dimensions (for cache persistence)
        if (!page.width || !page.height) {
          this.onPageDimensionsLoaded?.(index, page.url, loadedImage.width, loadedImage.height);
          // Update local page object for dynamic fallback calculation
          page.width = loadedImage.width;
          page.height = loadedImage.height;
        }
      }

      const img = document.createElement('img');
      img.className = 'cr-page-img';
      img.alt = `Page ${index + 1}`;
      img.loading = 'eager';  // Always eager in sequential mode

      img.onload = () => {
        if (this.destroyed) return;
        wrapper.classList.add('cr-loaded');
        this.fullyLoadedImages.add(index);

        // Report progress for overlay display during sequential loading
        this.onRestoreProgress?.(this.fullyLoadedImages.size, this.pages.length);

        // Also check anchor images (for restorePosition-based readiness)
        this.checkAnchorImagesLoaded();

        // Advance to next image
        this.sequentialLoadIndex++;
        this.fillPrefetchWindow();
        this.advanceDisplayLoop();
      };

      img.onerror = () => {
        console.error(`[VerticalReader] Sequential load error for page ${index + 1}`);
        wrapper.innerHTML = `
          <div class="cr-page-error">
            <span>Failed to load page ${index + 1}</span>
            <button class="cr-retry-page" data-index="${index}">Retry</button>
          </div>
        `;
        wrapper.classList.add('cr-page-failed');
        this.loadedImages.delete(index);

        // Continue to next image even on error
        this.sequentialLoadIndex++;
        this.fillPrefetchWindow();
        this.advanceDisplayLoop();
      };

      wrapper.innerHTML = '';
      wrapper.appendChild(img);
      img.src = loadedImage.url;
    } catch (error) {
      console.error(`[VerticalReader] Failed to load image ${index}:`, error);
      this.prefetchResults.delete(index);
      wrapper.innerHTML = `
        <div class="cr-page-error">
          <span>Failed to load page ${index + 1}</span>
          <button class="cr-retry-page" data-index="${index}">Retry</button>
        </div>
      `;
      wrapper.classList.add('cr-page-failed');
      this.loadedImages.delete(index);

      this.sequentialLoadIndex++;
      this.fillPrefetchWindow();
      this.advanceDisplayLoop();
    }
  }

  /**
   * Override restorePosition to use callback-based loading for smooth restoration.
   * 
   * Flow:
   * 1. Fire onRestoreStart callback (Viewer shows overlay)
   * 2. Force-load images from 0 to (anchor + buffer) with EAGER loading
   * 3. Wait for all target images to fully load
   * 4. Restore scroll position
   * 5. Fire onAnchorImagesReady callback (Viewer hides overlay)
   */
  restorePosition(position: ReadingPosition): void {
    const startTime = performance.now();
    console.log('[VerticalReader] restorePosition called', {
      anchorImageIndex: position.anchorImageIndex,
      anchorImageOffset: position.anchorImageOffset,
      totalPages: this.pages.length,
      alreadyLoaded: Array.from(this.fullyLoadedImages),
      currentScrollAnchor: this.scrollAnchor.getAnchor()
    });
    
    // Set flag to suppress scroll capture during restoration
    this.isRestoringPosition = true;
    
    this.scrollAnchor.setAnchor(position);
    
    console.log('[VerticalReader] scrollAnchor after setAnchor:', this.scrollAnchor.getAnchor());
    
    this.pendingAnchorIndex = position.anchorImageIndex;
    this.anchorCallbackFired = false;
    
    // Only notify for non-zero positions (continuing reading)
    const needsRestore = position.anchorImageIndex > 0 || position.anchorImageOffset > 0;
    
    if (needsRestore) {
      // Notify Viewer to show restoring overlay
      this.onRestoreStart?.();
    }
    
    // Clear any previous timeout
    if (this.anchorRestoreTimeout) {
      clearTimeout(this.anchorRestoreTimeout);
    }
    
    // Calculate target: anchor + buffer (but not more than page count)
    this.targetAnchorIndex = Math.min(
      this.pendingAnchorIndex + VerticalReader.ANCHOR_BUFFER,
      this.pages.length - 1
    );
    
    console.log('[VerticalReader] Target images to load: 0 to', this.targetAnchorIndex);
    
    // Force-load all images from 0 to target (with eager loading flag)
    for (let i = 0; i <= this.targetAnchorIndex && i < this.pages.length; i++) {
      this.loadImage(i);
    }
    
    // Set timeout fallback - restore even if images haven't loaded
    // Use longer timeout for refetch since caches are cleared and images must be re-downloaded
    const timeoutMs = this.isRefetching ? 60000 : 30000;
    this.anchorRestoreTimeout = setTimeout(() => {
      if (!this.anchorCallbackFired && this.pendingAnchorIndex >= 0) {
        console.log('[VerticalReader] Anchor timeout - restoring with current dimensions');
        this.fireAnchorReady();
      }
    }, timeoutMs);
    
    // Check if anchor images are already loaded (e.g., from cache)
    this.checkAnchorImagesLoaded();
  }

  /**
   * Check if all images up to and including target have loaded.
   * Uses targetAnchorIndex (anchor + buffer) for smoother restoration.
   */
  private checkAnchorImagesLoaded(): void {
    if (this.anchorCallbackFired || this.pendingAnchorIndex < 0) return;
    
    // Check if all images from 0 to target have FULLY loaded (not just started)
    const target = this.targetAnchorIndex >= 0 ? this.targetAnchorIndex : this.pendingAnchorIndex;
    const missing: number[] = [];
    for (let i = 0; i <= target; i++) {
      if (!this.fullyLoadedImages.has(i)) {
        missing.push(i);
      }
    }
    
    if (missing.length > 0) {
      console.log('[VerticalReader] Still waiting for images:', missing, 'of target:', target);
      // Report progress to Viewer for overlay display
      const total = target + 1;
      const loaded = total - missing.length;
      this.onRestoreProgress?.(loaded, total);
      return; // Still waiting for some images to finish loading
    }
    
    console.log('[VerticalReader] All target images loaded! Firing anchor ready.');
    // All target images loaded - fire callback
    this.fireAnchorReady();
  }

  /**
   * Fire the anchor ready callback and restore position.
   * Hides the loading overlay after scroll is complete.
   */
  private fireAnchorReady(): void {
    if (this.anchorCallbackFired || this.destroyed) return;
    this.anchorCallbackFired = true;

    console.log('[VerticalReader] fireAnchorReady called');

    // Clear timeout
    if (this.anchorRestoreTimeout) {
      clearTimeout(this.anchorRestoreTimeout);
      this.anchorRestoreTimeout = null;
    }

    if (this.imageElements.length > 0) {
      // Force synchronous reflow to ensure all pending style changes are applied
      void this.container.offsetHeight;

      // Restore scroll position synchronously
      this.scrollAnchor.restore(this.container, this.imageElements);

      console.log('[VerticalReader] Scroll restored. Container scrollTop:', this.container.scrollTop);
    }

    // Reset state (except isRestoringPosition - cleared after debounce delay)
    this.pendingAnchorIndex = -1;
    this.targetAnchorIndex = -1;

    // Delay clearing isRestoringPosition to outlast the debounced scroll handler (100ms + margin)
    setTimeout(() => {
      this.isRestoringPosition = false;
      console.log('[VerticalReader] isRestoringPosition cleared, scroll capture re-enabled');
    }, 150);

    // Wait for next frame to ensure scroll position is painted before hiding overlay
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.onAnchorImagesReady?.();
      });
    });
  }

  /**
   * Create chapter navigation element for end of chapter
   */
  private createChapterNavigation(): HTMLElement {
    const nav = document.createElement('div');
    nav.className = 'cr-chapter-nav';
    nav.innerHTML = `
      <div class="cr-chapter-end-label">End of Chapter</div>
      <div class="cr-chapter-nav-content">
        <button class="cr-chapter-nav-btn cr-prev-chapter-btn ${this.isFirstChapter ? 'disabled' : ''} ${this.hasGapPrev ? 'cr-chapter-gap' : ''}" id="cr-end-prev-chapter" ${this.isFirstChapter ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
          </svg>
          <span>Previous Chapter</span>
        </button>
        <div class="cr-chapter-nav-divider"></div>
        <button class="cr-chapter-nav-btn cr-next-chapter-btn ${this.isLastChapter ? 'disabled' : ''} ${this.hasGapNext ? 'cr-chapter-gap' : ''}" id="cr-end-next-chapter" ${this.isLastChapter ? 'disabled' : ''}>
          <span>Next Chapter</span>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/>
          </svg>
        </button>
      </div>
    `;

    // Add event listeners
    nav.querySelector('#cr-end-prev-chapter')?.addEventListener('click', () => {
      if (!this.isFirstChapter) {
        this.onChapterEnd?.('prev');
      }
    });
    nav.querySelector('#cr-end-next-chapter')?.addEventListener('click', () => {
      if (!this.isLastChapter) {
        this.onChapterEnd?.('next');
      }
    });

    return nav;
  }

  /**
   * Calculate dynamic fallback aspect ratio from already-loaded images.
   * Excludes first and last pages (often cover pages with different ratios).
   * Returns '2/3' if not enough data available.
   */
  private getDynamicFallbackRatio(): string {
    // Get pages with known dimensions, excluding first and last
    const pagesWithDimensions = this.pages.filter((page, index) => {
      // Exclude first and last page
      if (index === 0 || index === this.pages.length - 1) return false;
      return page.width && page.height;
    });

    if (pagesWithDimensions.length === 0) {
      return this.defaultAspectRatio;
    }

    // Calculate average aspect ratio
    let totalRatio = 0;
    for (const page of pagesWithDimensions) {
      totalRatio += page.width! / page.height!;
    }
    const avgRatio = totalRatio / pagesWithDimensions.length;

    // Return as fraction string (width/height)
    // Round to 4 decimal places for cleaner CSS
    return avgRatio.toFixed(4);
  }

  /**
   * Create a page wrapper element
   */
  private createPageWrapper(page: PageInfo, index: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cr-page-wrapper cr-vertical-page';
    wrapper.dataset.pageIndex = index.toString();
    wrapper.style.marginBottom = `${this.gap}px`;

    // Calculate zoom factor
    const zoomFactor = this.zoom / 100;

    // Apply image fit with zoom
    switch (this.imageFit) {
      case 'width':
        wrapper.style.width = '100%';
        wrapper.style.maxWidth = `${900 * zoomFactor}px`;
        wrapper.style.height = 'auto';
        wrapper.style.maxHeight = 'none';
        wrapper.style.margin = '0 auto';
        wrapper.style.transform = 'none';
        break;
      case 'height':
        wrapper.style.width = 'auto';
        wrapper.style.maxWidth = 'none';
        wrapper.style.height = `${100 * zoomFactor}vh`;
        wrapper.style.maxHeight = 'none';
        wrapper.style.margin = '0 auto';
        wrapper.style.transform = 'none';
        break;
      case 'contain':
        wrapper.style.width = '100%';
        wrapper.style.maxWidth = `${900 * zoomFactor}px`;
        wrapper.style.height = 'auto';
        wrapper.style.maxHeight = `${100 * zoomFactor}vh`;
        wrapper.style.margin = '0 auto';
        wrapper.style.transform = 'none';
        break;
      case 'original':
        // Original size = image's natural pixel width × zoom. No cap.
        // The contentArea CSS `.cr-fit-original.cr-mode-vertical { overflow-x: auto }`
        // provides horizontal scroll when the image is wider than the viewport.
        if (page.width) {
          wrapper.style.width = `${page.width * zoomFactor}px`;
          wrapper.style.maxWidth = 'none';
        } else {
          // Dimensions not yet known — defer to CSS default (width:100% max-width:900px)
          // for the placeholder. loadImage() switches to natural × zoom once known.
          wrapper.style.width = '';
          wrapper.style.maxWidth = '';
        }
        wrapper.style.height = 'auto';
        wrapper.style.maxHeight = 'none';
        wrapper.style.margin = '0 auto';
        wrapper.style.transform = 'none';
        break;
    }

    // Set aspect ratio if known (prevents layout shift)
    // Use dynamic fallback from already-loaded images, or 2/3 as last resort
    if (page.width && page.height) {
      wrapper.style.aspectRatio = `${page.width}/${page.height}`;
    } else {
      // Use dynamic fallback ratio based on already-loaded images
      wrapper.style.aspectRatio = this.getDynamicFallbackRatio();
    }

    // Create placeholder
    const placeholder = document.createElement('div');
    placeholder.className = 'cr-page-placeholder';
    placeholder.innerHTML = `
      <div class="cr-page-loading">
        <span>Page ${index + 1}</span>
      </div>
    `;
    wrapper.appendChild(placeholder);

    return wrapper;
  }

  /**
   * Setup intersection observer for lazy loading
   */
  private setupLazyLoading(): void {
    // Disconnect existing observer
    this.intersectionObserver?.disconnect();

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt((entry.target as HTMLElement).dataset.pageIndex || '0');
          
          if (entry.isIntersecting) {
            // Load this image and preload neighbors
            this.loadImage(index);
            
            // Preload ahead
            for (let i = 1; i <= this.preloadCount; i++) {
              if (index + i < this.pages.length) {
                this.loadImage(index + i);
              }
            }
          }
        });
      },
      {
        root: this.container,
        rootMargin: '200px 0px', // Start loading before image enters viewport
        threshold: 0,
      }
    );

    // Observe all page wrappers
    this.imageElements.forEach((wrapper) => {
      this.intersectionObserver!.observe(wrapper);
    });
  }

  /**
   * Load an image by index
   */
  private async loadImage(index: number): Promise<void> {
    if (this.loadedImages.has(index) || index >= this.pages.length) return;

    const wrapper = this.imageElements[index];
    const page = this.pages[index];

    if (!wrapper || !page) return;

    this.loadedImages.add(index);

    try {
      // Get image URL and dimensions (may be proxied through background script with caching)
      const knownDims = (page.width && page.height)
        ? { width: page.width, height: page.height }
        : undefined;
      // Use per-page cache context override for appended chapters (continuous reading)
      const pageCtx = this.continuousManager?.getCacheContext(index);
      const cacheOverride = pageCtx ? { sourceId: pageCtx.sourceId, mangaSlug: pageCtx.mangaSlug, chapterSlug: pageCtx.chapterSlug } : undefined;
      const pageIndexForCache = pageCtx ? pageCtx.localIndex : index;
      const loadedImage = await loadImage(page.url, pageIndexForCache, knownDims, cacheOverride);

      // Set aspect ratio BEFORE creating/displaying image to prevent layout shift
      // If overlay is dismissed and user is reading, re-anchor scroll around the dimension change
      if (loadedImage.width && loadedImage.height) {
        const shouldReanchor = !this.isRestoringPosition && this.anchorCallbackFired;

        if (shouldReanchor) {
          // Capture scroll position before layout shift
          this.scrollAnchor.capture(this.container, this.imageElements);
          wrapper.style.aspectRatio = `${loadedImage.width}/${loadedImage.height}`;
          // In original mode, now that real dimensions are known, size the wrapper
          // explicitly to natural × zoom so the image displays at its native pixels.
          if (this.imageFit === 'original') {
            wrapper.style.width = `${loadedImage.width * (this.zoom / 100)}px`;
            wrapper.style.maxWidth = 'none';
          }
          // Force reflow and restore scroll position
          void this.container.offsetHeight;
          this.scrollAnchor.restore(this.container, this.imageElements);
        } else {
          wrapper.style.aspectRatio = `${loadedImage.width}/${loadedImage.height}`;
          if (this.imageFit === 'original') {
            wrapper.style.width = `${loadedImage.width * (this.zoom / 100)}px`;
            wrapper.style.maxWidth = 'none';
          }
        }

        // Notify if page didn't already have dimensions (for cache persistence)
        if (!page.width || !page.height) {
          this.onPageDimensionsLoaded?.(index, page.url, loadedImage.width, loadedImage.height);
          // Update local page object for dynamic fallback calculation
          page.width = loadedImage.width;
          page.height = loadedImage.height;
        }
      }

      // Create image element
      const img = document.createElement('img');
      img.className = 'cr-page-img';
      img.alt = `Page ${index + 1}`;

      // Use eager loading for anchor images (0 to targetAnchorIndex)
      // Otherwise lazy load for performance
      const isAnchorImage = this.targetAnchorIndex >= 0 && index <= this.targetAnchorIndex;
      img.loading = isAnchorImage ? 'eager' : 'lazy';
      
      if (isAnchorImage) {
        console.log(`[VerticalReader] Loading image ${index} with EAGER (anchor image)`);
      }

      // Set handlers BEFORE src to ensure they fire for data URLs
      img.onload = () => {
        if (this.destroyed) return;
        console.log(`[VerticalReader] Image ${index} onload fired. Natural size: ${img.naturalWidth}x${img.naturalHeight}`);
        wrapper.classList.add('cr-loaded');
        // Aspect ratio already set from loadedImage dimensions - no need to update
        
        // Mark as fully loaded and check anchor readiness
        this.fullyLoadedImages.add(index);
        this.checkAnchorImagesLoaded();
      };

      // Handle load error
      img.onerror = (e) => {
        console.error(`[VerticalReader] Image load error for page ${index + 1}:`, e);
        wrapper.innerHTML = `
          <div class="cr-page-error">
            <span>Failed to load page ${index + 1}</span>
            <button class="cr-retry-page" data-index="${index}">Retry</button>
          </div>
        `;
        wrapper.classList.add('cr-page-failed');
        this.loadedImages.delete(index); // Allow retry
        // Count errored images toward anchor readiness to prevent indefinite waiting
        this.fullyLoadedImages.add(index);
        this.checkAnchorImagesLoaded();
      };

      // Clear wrapper and append image
      wrapper.innerHTML = '';
      wrapper.appendChild(img);
      
      // Set src - image is already loaded/cached so this should be instant
      img.src = loadedImage.url;
    } catch (error) {
      console.error(`[VerticalReader] Failed to load image ${index}:`, error);
      wrapper.innerHTML = `
        <div class="cr-page-error">
          <span>Failed to load page ${index + 1}</span>
          <button class="cr-retry-page" data-index="${index}">Retry</button>
        </div>
      `;
      wrapper.classList.add('cr-page-failed');
      this.loadedImages.delete(index);
      // Count errored images toward anchor readiness to prevent indefinite waiting
      this.fullyLoadedImages.add(index);
      this.checkAnchorImagesLoaded();
    }
  }

  /**
   * Retry loading a failed page
   */
  retryPage(index: number): void {
    const wrapper = this.imageElements[index];
    if (!wrapper) return;

    // Reset error state
    wrapper.classList.remove('cr-page-failed');
    wrapper.innerHTML = '';

    // Re-create placeholder
    const placeholder = document.createElement('div');
    placeholder.className = 'cr-page-placeholder';
    placeholder.innerHTML = `<div class="cr-page-loading"><span>Page ${index + 1}</span></div>`;
    wrapper.appendChild(placeholder);

    // Allow re-load
    this.loadedImages.delete(index);
    this.fullyLoadedImages.delete(index);

    // Re-trigger load
    this.loadImage(index);
  }

  /**
   * Scroll to next section (distance based on scrollAmount %)
   */
  nextPage(): void {
    const distance = this.container.clientHeight * (this.scrollAmount / 100);
    this.smoothScroller.scrollBy(distance);
  }

  /**
   * Scroll to previous section
   */
  prevPage(): void {
    const distance = this.container.clientHeight * (this.scrollAmount / 100);
    this.smoothScroller.scrollBy(-distance);
  }

  /**
   * Start continuous scrolling at constant velocity (hold key behavior).
   * Velocity derived from scrollSpeed setting.
   */
  startContinuousScroll(direction: 1 | -1): void {
    // scrollSpeed 1 → 0.2 vh/s, 5 (default) → 1.0 vh/s, 10 → 2.0 vh/s
    const velocity = direction * this.container.clientHeight * this.scrollSpeed * 0.2;
    this.smoothScroller.startContinuousScroll(velocity);
  }

  /**
   * Stop continuous scrolling (key released).
   */
  stopContinuousScroll(): void {
    this.smoothScroller.stopContinuousScroll();
  }

  /**
   * Go to a specific page
   */
  goToPage(pageIndex: number): void {
    if (pageIndex < 0 || pageIndex >= this.pages.length) return;

    const wrapper = this.imageElements[pageIndex];
    if (wrapper) {
      const targetTop = wrapper.offsetTop - this.container.offsetTop;
      this.smoothScroller.scrollTo(targetTop);
    }
  }

  /**
   * Override getPosition to NOT capture during restoration.
   * This prevents updateProgress/savePosition from corrupting the anchor
   * we're trying to restore to.
   */
  getPosition(): ReadingPosition {
    if (this.isRestoringPosition) {
      // During restoration, return the anchor we're restoring to (don't capture)
      const anchor = this.scrollAnchor.getAnchor();
      if (anchor) {
        console.log('[VerticalReader] getPosition during restore - returning existing anchor');
        return anchor;
      }
    }
    // Normal case: capture current position
    return this.scrollAnchor.capture(this.container, this.imageElements);
  }

  /**
   * Check if reader is scrolled to (or near) the bottom, or has only 1 page
   */
  isAtEnd(): boolean {
    if (this.pages.length <= 1) return true;
    const threshold = 50;
    return this.container.scrollTop + this.container.clientHeight >= this.container.scrollHeight - threshold;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    super.destroy();

    // Stop smooth scroller
    this.smoothScroller.detach();

    // Remove scroll handlers
    if (this.scrollHandler && this.container) {
      this.container.removeEventListener('scroll', this.scrollHandler);
    }
    if (this.chapterScrollHandler && this.container) {
      this.container.removeEventListener('scroll', this.chapterScrollHandler);
    }
    
    // Disconnect intersection observer
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    
    // Clear anchor restore timeout
    if (this.anchorRestoreTimeout) {
      clearTimeout(this.anchorRestoreTimeout);
      this.anchorRestoreTimeout = null;
    }
    
    // Clear loaded images tracking
    this.loadedImages.clear();
    this.fullyLoadedImages.clear();
    this.anchorCallbackFired = false;
    this.targetAnchorIndex = -1;
    
    // Reset sequential loading state
    this.sequentialLoadingEnabled = false;
    this.sequentialLoadIndex = 0;
    this.prefetchResults.clear();

    // Cleanup continuous reading observers
    this.nextChapterTriggerObserver?.disconnect();
    this.nextChapterTriggerObserver = null;
    this.nextChapterTriggerElement = null;
    this.prevChapterTriggerObserver?.disconnect();
    this.prevChapterTriggerObserver = null;
    this.prevChapterTriggerElement = null;
    this.continuousManager?.destroy();
    this.continuousManager = null;
    this.continuousReadingEnabled = false;

    // Cleanup chapter-detection suppression
    if (this.suppressChapterDetectionTimer) {
      clearTimeout(this.suppressChapterDetectionTimer);
      this.suppressChapterDetectionTimer = null;
    }
    this.suppressChapterDetection = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTINUOUS READING — PUBLIC TRIGGER RESET
  // ═══════════════════════════════════════════════════════════════════════════

  /** Reset the next-chapter request flag (allows IntersectionObserver to fire again). */
  resetNextChapterRequest(): void {
    if (this.continuousManager) this.continuousManager.nextRequested = false;
  }

  /** Reset the prev-chapter request flag (allows IntersectionObserver to fire again). */
  resetPrevChapterRequest(): void {
    if (this.continuousManager) this.continuousManager.prevRequested = false;
  }

  /**
   * Smoothly scroll to the first page of a chapter segment that's already loaded in the strip.
   * Used by the chapter picker shortcut in continuous mode.
   *
   * Suppresses the scroll-driven chapter detection for the duration of the smooth-scroll
   * animation. Without suppression, the detector would fire for every chapter the viewport
   * center crosses during the animation, causing currentChapter to oscillate through
   * intermediate values before settling.
   */
  scrollToSegment(seg: ChapterSegment): void {
    if (!this.continuousManager) return;

    // Pre-set the manager's currentSegmentIndex to the target so post-suppression
    // detection treats the target as "already current" (no spurious fire on settle).
    const segIdx = this.continuousManager.indexOfSegment(seg);
    if (segIdx >= 0) {
      this.continuousManager.currentSegmentIndex = segIdx;
    }

    this.suppressChapterDetection = true;
    if (this.suppressChapterDetectionTimer) clearTimeout(this.suppressChapterDetectionTimer);
    // Smooth scroll settles within ~300ms even for long distances (exponential ease-out).
    // 1500ms gives ample margin while still releasing detection promptly.
    this.suppressChapterDetectionTimer = setTimeout(() => {
      this.suppressChapterDetection = false;
      this.suppressChapterDetectionTimer = null;
    }, 1500);

    this.goToPage(seg.startIndex);
  }
}