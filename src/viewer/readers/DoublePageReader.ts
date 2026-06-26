import { BaseReader } from './BaseReader';
import { PageInfo, ReadingPosition, ImageFit } from '@/types';
import { loadImage } from '@/utils/imageLoader';

/**
 * DoublePageReader - Two pages side-by-side (spread) reading mode
 * 
 * Features:
 * - Displays two pages as a spread (manga style: right-to-left)
 * - Smart handling of cover pages (first page alone)
 * - Wide page detection (shows alone if aspect ratio > 1.2)
 * - Click navigation (click left/right sides)
 * - Preloads adjacent spreads
 */
export class DoublePageReader extends BaseReader {
  private currentSpreadIndex: number = 0;
  private spreads: number[][] = []; // Array of page indices per spread
  private preloadDistance: number = 1;
  private preloadedImages: Map<number, HTMLImageElement> = new Map();
  private anchorCallbackFired: boolean = false;
  
  // Reading direction (true = right-to-left for manga)
  private rightToLeft: boolean = true;
  
  // Wide page detection threshold (width/height ratio)
  private widePageThreshold: number = 1.2;

  constructor(container: HTMLElement) {
    super(container);
    this.mode = 'double';
  }

  /**
   * Set the initial page index before rendering
   * Used when restoring position from a mode switch
   * Converts page index to spread index
   */
  setInitialPage(pageIndex: number): void {
    // Find which spread contains this page
    for (let i = 0; i < this.spreads.length; i++) {
      if (this.spreads[i].includes(pageIndex)) {
        this.currentSpreadIndex = i;
        return;
      }
    }
  }
  
  /**
   * Configure reader options
   */
  configure(options: { imageFit?: ImageFit; zoom?: number }): void {
    super.configure(options);
    // Apply fit class and zoom to display container if it exists
    this.applyFitClass();
    this.applyZoom();
  }
  
  /**
   * Apply current fit class to display container
   */
  private applyFitClass(): void {
    const display = document.getElementById('cr-double-display');
    if (!display) return;
    
    display.classList.remove('cr-fit-width', 'cr-fit-height', 'cr-fit-contain', 'cr-fit-original');
    display.classList.add(`cr-fit-${this.imageFit}`);
  }

  /**
   * Apply current zoom level
   */
  private applyZoom(): void {
    const container = document.getElementById('cr-spread-container');
    if (!container) return;
    
    container.style.setProperty('--cr-zoom', String(this.zoom / 100));
  }

  /**
   * Calculate dynamic fallback aspect ratio from already-loaded images.
   * Excludes first and last pages (often cover pages with different ratios).
   * Returns '2/3' if not enough data available.
   */
  private getDynamicFallbackRatio(): string {
    const pagesWithDimensions = this.pages.filter((page, index) => {
      if (index === 0 || index === this.pages.length - 1) return false;
      return page.width && page.height;
    });

    if (pagesWithDimensions.length === 0) {
      return this.defaultAspectRatio;
    }

    let totalRatio = 0;
    for (const page of pagesWithDimensions) {
      totalRatio += page.width! / page.height!;
    }
    return (totalRatio / pagesWithDimensions.length).toFixed(4);
  }

  /**
   * Set pages and calculate spreads
   */
  setPages(pages: PageInfo[]): void {
    super.setPages(pages);
    this.calculateSpreads();
  }

  /**
   * Calculate page spreads
   * 
   * Rules:
   * - First page (cover) is shown alone
   * - Wide pages (aspect ratio > threshold) shown alone
   * - Otherwise pair consecutive pages
   */
  private calculateSpreads(): void {
    this.spreads = [];
    let i = 0;

    while (i < this.pages.length) {
      const page = this.pages[i];
      const isWide = this.isWidePage(page);
      const isCover = i === 0;

      if (isWide || isCover) {
        // Single page spread
        this.spreads.push([i]);
        i++;
      } else if (i + 1 < this.pages.length) {
        // Check if next page is wide
        const nextPage = this.pages[i + 1];
        if (this.isWidePage(nextPage)) {
          // Current alone, next will be handled next iteration
          this.spreads.push([i]);
          i++;
        } else {
          // Double page spread
          if (this.rightToLeft) {
            // Manga style: right page first (lower index on right)
            this.spreads.push([i + 1, i]);
          } else {
            // Western style: left page first
            this.spreads.push([i, i + 1]);
          }
          i += 2;
        }
      } else {
        // Last page alone
        this.spreads.push([i]);
        i++;
      }
    }
  }

  /**
   * Check if a page is considered wide (double-page spread in source)
   */
  private isWidePage(page: PageInfo): boolean {
    if (!page.width || !page.height) return false;
    return page.width / page.height > this.widePageThreshold;
  }

  /**
   * Render pages in double page mode
   */
  render(): void {
    this.container.innerHTML = '';
    this.container.className = 'cr-viewer-content cr-mode-double';
    this.imageElements = [];
    this.anchorCallbackFired = false;

    if (this.pages.length === 0 || this.spreads.length === 0) return;

    // Create spread display area
    const spreadDisplay = document.createElement('div');
    spreadDisplay.className = `cr-double-page-display cr-fit-${this.imageFit}`;
    spreadDisplay.id = 'cr-double-display';

    // Navigation zones
    const prevZone = document.createElement('div');
    prevZone.className = 'cr-nav-zone cr-nav-prev';
    prevZone.addEventListener('click', () => this.prevSpread());

    const nextZone = document.createElement('div');
    nextZone.className = 'cr-nav-zone cr-nav-next';
    nextZone.addEventListener('click', () => this.nextSpread());

    // Spread container
    const spreadContainer = document.createElement('div');
    spreadContainer.className = 'cr-double-spread-container';
    spreadContainer.id = 'cr-spread-container';

    spreadDisplay.appendChild(prevZone);
    spreadDisplay.appendChild(spreadContainer);
    spreadDisplay.appendChild(nextZone);

    this.container.appendChild(spreadDisplay);

    // Create spread indicators
    this.createSpreadIndicators();

    // Show current spread
    this.showSpread(this.currentSpreadIndex);

    // Preload adjacent
    this.preloadAdjacent();
  }

  /**
   * Create spread indicator dots
   */
  private createSpreadIndicators(): void {
    const indicatorContainer = document.createElement('div');
    indicatorContainer.className = 'cr-page-indicators';
    indicatorContainer.id = 'cr-spread-indicators';

    // Only show if reasonable number
    if (this.spreads.length <= 30) {
      for (let i = 0; i < this.spreads.length; i++) {
        const dot = document.createElement('button');
        dot.className = 'cr-page-dot';
        if (this.spreads[i].length === 2) {
          dot.classList.add('cr-spread-dot'); // Slightly wider for spreads
        }
        dot.dataset.spread = String(i);
        dot.addEventListener('click', () => this.goToSpread(i));
        indicatorContainer.appendChild(dot);
      }
    }

    this.container.appendChild(indicatorContainer);
    this.updateIndicators();
  }

  /**
   * Update indicator highlighting
   */
  private updateIndicators(): void {
    const indicators = document.getElementById('cr-spread-indicators');
    if (!indicators) return;

    indicators.querySelectorAll('.cr-page-dot').forEach((dot, index) => {
      dot.classList.toggle('active', index === this.currentSpreadIndex);
    });
  }

  /**
   * Show a specific spread
   */
  private showSpread(spreadIndex: number): void {
    const spreadContainer = document.getElementById('cr-spread-container');
    if (!spreadContainer || spreadIndex < 0 || spreadIndex >= this.spreads.length) return;

    this.currentSpreadIndex = spreadIndex;
    const pageIndices = this.spreads[spreadIndex];

    // Clear container
    spreadContainer.innerHTML = '';
    spreadContainer.className = `cr-double-spread-container ${pageIndices.length === 1 ? 'cr-single-spread' : 'cr-double-spread'}`;
    // Create zoom wrapper to hold all pages in spread
    const zoomWrapper = document.createElement('div');
    zoomWrapper.className = 'cr-double-spread-wrapper';
    this.imageElements = [];
    
    // Track how many images in this spread have loaded
    let loadedInSpread = 0;
    const totalInSpread = pageIndices.length;
    
    const checkSpreadReady = () => {
      loadedInSpread++;
      if (loadedInSpread >= totalInSpread && !this.anchorCallbackFired && this.pendingAnchorIndex >= 0) {
        // Check if any page in this spread matches the anchor
        if (pageIndices.includes(this.pendingAnchorIndex)) {
          this.anchorCallbackFired = true;
          if (this.anchorRestoreTimeout) {
            clearTimeout(this.anchorRestoreTimeout);
            this.anchorRestoreTimeout = null;
          }
          this.pendingAnchorIndex = -1;
          this.onAnchorImagesReady?.();
        }
      }
    };

    // Create pages
    for (const pageIndex of pageIndices) {
      const page = this.pages[pageIndex];

      // Create wrapper first with aspect ratio if known, otherwise dynamic fallback
      const wrapper = document.createElement('div');
      wrapper.className = 'cr-double-page-wrapper';
      wrapper.style.aspectRatio = page.width && page.height 
        ? `${page.width}/${page.height}` 
        : this.getDynamicFallbackRatio();

      // Create or get preloaded image
      let img: HTMLImageElement;
      const preloaded = this.preloadedImages.get(pageIndex);
      if (preloaded && preloaded.naturalWidth > 0) {
        img = preloaded;
      } else {
        // Remove failed preload if present
        if (preloaded) this.preloadedImages.delete(pageIndex);
        img = new Image();
        img.className = 'cr-double-page-img';
        img.alt = `Page ${pageIndex + 1}`;
        // Load image (may be proxied with caching) and set src
        // Capture wrapper and page in closure for dimension update
        const wrapperRef = wrapper;
        const pageRef = page;
        const pageIndexRef = pageIndex;
        loadImage(page.url, pageIndex).then(loaded => {
          img.src = loaded.url;
          // Set aspect ratio from loaded dimensions (overwrites fallback)
          if (loaded.width && loaded.height) {
            wrapperRef.style.aspectRatio = `${loaded.width}/${loaded.height}`;
            
            // Notify if page didn't already have dimensions (for cache persistence)
            if (!pageRef.width || !pageRef.height) {
              this.onPageDimensionsLoaded?.(pageIndexRef, pageRef.url, loaded.width, loaded.height);
              // Update local page object
              pageRef.width = loaded.width;
              pageRef.height = loaded.height;
            }
          }
        }).catch(err => {
          console.error(`[DoublePageReader] Failed to load page ${pageIndexRef + 1}:`, err);
          wrapperRef.innerHTML = `
            <div class="cr-page-error">
              <span>Failed to load page ${pageIndexRef + 1}</span>
              <button class="cr-retry-page" data-index="${pageIndexRef}">Retry</button>
            </div>
          `;
          wrapperRef.classList.add('cr-page-failed');
        });
      }

      img.className = 'cr-double-page-img';
      img.alt = `Page ${pageIndex + 1}`;
      
      // Track load for anchor callback
      if (img.complete && img.naturalWidth > 0) {
        checkSpreadReady();
      } else {
        img.addEventListener('load', checkSpreadReady, { once: true });
      }

      wrapper.appendChild(img);
      zoomWrapper.appendChild(wrapper);
      this.imageElements.push(wrapper);
    }

    // Append zoom wrapper to container
    spreadContainer.appendChild(zoomWrapper);

    // Update indicators
    this.updateIndicators();

    // Emit progress
    this.emitProgress();

    // Preload adjacent
    this.preloadAdjacent();
  }

  /**
   * Preload adjacent spreads
   */
  private preloadAdjacent(): void {
    for (let offset = 1; offset <= this.preloadDistance; offset++) {
      // Preload next spread
      const nextSpreadIndex = this.currentSpreadIndex + offset;
      if (nextSpreadIndex < this.spreads.length) {
        for (const pageIndex of this.spreads[nextSpreadIndex]) {
          if (!this.preloadedImages.has(pageIndex)) {
            const img = new Image();
            this.preloadedImages.set(pageIndex, img);
            // Load with cache
            loadImage(this.pages[pageIndex].url, pageIndex).then(loaded => {
              img.src = loaded.url;
            }).catch(err => {
              console.error('[DoublePageReader] Preload error:', err);
              this.preloadedImages.delete(pageIndex);
            });
          }
        }
      }

      // Preload prev spread
      const prevSpreadIndex = this.currentSpreadIndex - offset;
      if (prevSpreadIndex >= 0) {
        for (const pageIndex of this.spreads[prevSpreadIndex]) {
          if (!this.preloadedImages.has(pageIndex)) {
            const img = new Image();
            this.preloadedImages.set(pageIndex, img);
            // Load with cache
            loadImage(this.pages[pageIndex].url, pageIndex).then(loaded => {
              img.src = loaded.url;
            }).catch(err => {
              console.error('[DoublePageReader] Preload error:', err);
              this.preloadedImages.delete(pageIndex);
            });
          }
        }
      }
    }

    // Cleanup distant preloads
    this.cleanupPreloads();
  }

  /**
   * Clean up distant preloaded images
   */
  private cleanupPreloads(): void {
    const currentPages = new Set<number>();
    
    // Get page indices within keep range
    for (let i = Math.max(0, this.currentSpreadIndex - this.preloadDistance * 2); 
         i <= Math.min(this.spreads.length - 1, this.currentSpreadIndex + this.preloadDistance * 2); 
         i++) {
      for (const pageIndex of this.spreads[i]) {
        currentPages.add(pageIndex);
      }
    }

    // Remove pages not in range
    for (const [pageIndex] of this.preloadedImages) {
      if (!currentPages.has(pageIndex)) {
        this.preloadedImages.delete(pageIndex);
      }
    }
  }

  /**
   * Go to specific spread
   */
  goToSpread(spreadIndex: number): void {
    if (spreadIndex >= 0 && spreadIndex < this.spreads.length) {
      this.showSpread(spreadIndex);
    }
  }

  /**
   * Go to specific page (finds containing spread)
   */
  goToPage(pageIndex: number): void {
    const spreadIndex = this.spreads.findIndex(spread => spread.includes(pageIndex));
    if (spreadIndex >= 0) {
      this.goToSpread(spreadIndex);
    }
  }

  /**
   * Go to previous spread
   */
  prevSpread(): void {
    if (this.currentSpreadIndex > 0) {
      this.showSpread(this.currentSpreadIndex - 1);
    } else if (!this.isFirstChapter) {
      this.onChapterEnd?.('prev');
    }
  }

  /**
   * Go to next spread
   */
  nextSpread(): void {
    if (this.currentSpreadIndex < this.spreads.length - 1) {
      this.showSpread(this.currentSpreadIndex + 1);
    } else if (!this.isLastChapter) {
      this.onChapterEnd?.('next');
    }
  }

  /**
   * Navigation aliases
   */
  prevPage(): void {
    this.prevSpread();
  }

  nextPage(): void {
    this.nextSpread();
  }

  /**
   * Emit progress update (reports first page of current spread)
   */
  private emitProgress(): void {
    const currentPages = this.spreads[this.currentSpreadIndex];
    const firstPageIndex = Math.min(...currentPages);
    this.onProgressUpdate?.(firstPageIndex + 1, this.pages.length);
  }

  /**
   * Get current reading position
   */
  getPosition(): ReadingPosition {
    const currentPages = this.spreads[this.currentSpreadIndex];
    const firstPageIndex = Math.min(...currentPages);

    return {
      anchorImageIndex: firstPageIndex,
      anchorImageOffset: 0,
      scrollTop: 0,
      viewportHeight: this.container.clientHeight,
      timestamp: Date.now(),
    };
  }

  /**
   * Check if reader is at the last spread
   */
  isAtEnd(): boolean {
    return this.spreads.length <= 1 || this.currentSpreadIndex >= this.spreads.length - 1;
  }

  /**
   * Restore reading position
   */
  restorePosition(position: ReadingPosition): void {
    this.pendingAnchorIndex = position.anchorImageIndex;
    this.anchorCallbackFired = false;
    
    // Clear any previous timeout
    if (this.anchorRestoreTimeout) {
      clearTimeout(this.anchorRestoreTimeout);
    }
    
    // Set timeout fallback (longer for refetch since images must be re-downloaded)
    const timeoutMs = this.isRefetching ? 60000 : 30000;
    this.anchorRestoreTimeout = setTimeout(() => {
      if (!this.anchorCallbackFired && this.pendingAnchorIndex >= 0) {
        this.anchorCallbackFired = true;
        this.pendingAnchorIndex = -1;
        this.onAnchorImagesReady?.();
      }
    }, timeoutMs);
    
    this.goToPage(position.anchorImageIndex);
  }

  /**
   * Get current page index (first page of spread)
   */
  getCurrentPage(): number {
    const currentPages = this.spreads[this.currentSpreadIndex];
    return Math.min(...currentPages);
  }

  /**
   * Set reading direction
   */
  setRightToLeft(rtl: boolean): void {
    if (this.rightToLeft !== rtl) {
      this.rightToLeft = rtl;
      this.calculateSpreads();
      if (this.pages.length > 0) {
        this.render();
      }
    }
  }

  /**
   * Cleanup
   */
  /**
   * Retry loading a failed page
   */
  retryPage(_index: number): void {
    this.showSpread(this.currentSpreadIndex);
  }

  destroy(): void {
    super.destroy();
    this.preloadedImages.clear();
    this.spreads = [];
    this.anchorCallbackFired = false;
  }
}
