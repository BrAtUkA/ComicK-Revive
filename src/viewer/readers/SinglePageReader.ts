import { BaseReader } from './BaseReader';
import { ReadingPosition, ImageFit } from '@/types';
import { loadImage } from '@/utils/imageLoader';

/**
 * SinglePageReader - One page at a time reading mode
 * 
 * Features:
 * - Displays one page centered in viewport
 * - Click/tap navigation (left side = prev, right side = next)
 * - Keyboard navigation with A/D or arrow alternative
 * - Preloads adjacent pages
 * - Fit modes: width, height, contain, original
 */
export class SinglePageReader extends BaseReader {
  private currentPageIndex: number = 0;
  private preloadDistance: number = 2;
  private preloadedImages: Map<number, HTMLImageElement> = new Map();
  private anchorCallbackFired: boolean = false;

  constructor(container: HTMLElement) {
    super(container);
    this.mode = 'single';
  }

  /**
   * Set the initial page index before rendering
   * Used when restoring position from a mode switch
   */
  setInitialPage(index: number): void {
    if (index >= 0 && index < this.pages.length) {
      this.currentPageIndex = index;
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
    const display = document.getElementById('cr-single-display');
    if (!display) return;
    
    display.classList.remove('cr-fit-width', 'cr-fit-height', 'cr-fit-contain', 'cr-fit-original');
    display.classList.add(`cr-fit-${this.imageFit}`);
  }

  /**
   * Apply current zoom level
   */
  private applyZoom(): void {
    const container = document.getElementById('cr-page-container');
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
   * Render pages in single page mode
   */
  render(): void {
    this.container.innerHTML = '';
    this.container.className = 'cr-viewer-content cr-mode-single';
    this.imageElements = [];
    this.anchorCallbackFired = false;

    if (this.pages.length === 0) return;

    // Create page display area
    const pageDisplay = document.createElement('div');
    pageDisplay.className = `cr-single-page-display cr-fit-${this.imageFit}`;
    pageDisplay.id = 'cr-single-display';

    // Navigation zones (invisible, for click detection)
    const prevZone = document.createElement('div');
    prevZone.className = 'cr-nav-zone cr-nav-prev';
    prevZone.addEventListener('click', () => this.prevPage());

    const nextZone = document.createElement('div');
    nextZone.className = 'cr-nav-zone cr-nav-next';
    nextZone.addEventListener('click', () => this.nextPage());

    // Page container
    const pageContainer = document.createElement('div');
    pageContainer.className = 'cr-single-page-container';
    pageContainer.id = 'cr-page-container';

    pageDisplay.appendChild(prevZone);
    pageDisplay.appendChild(pageContainer);
    pageDisplay.appendChild(nextZone);

    this.container.appendChild(pageDisplay);

    // Create page indicators
    this.createPageIndicators();

    // Show current page
    this.showPage(this.currentPageIndex);

    // Preload adjacent
    this.preloadAdjacent();
  }

  /**
   * Create page indicator dots
   */
  private createPageIndicators(): void {
    const indicatorContainer = document.createElement('div');
    indicatorContainer.className = 'cr-page-indicators';
    indicatorContainer.id = 'cr-page-indicators';

    // Only show indicators if reasonable number of pages
    if (this.pages.length <= 50) {
      for (let i = 0; i < this.pages.length; i++) {
        const dot = document.createElement('button');
        dot.className = 'cr-page-dot';
        dot.dataset.page = String(i);
        dot.addEventListener('click', () => this.goToPage(i));
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
    const indicators = document.getElementById('cr-page-indicators');
    if (!indicators) return;

    indicators.querySelectorAll('.cr-page-dot').forEach((dot, index) => {
      dot.classList.toggle('active', index === this.currentPageIndex);
    });
  }

  /**
   * Show a specific page
   */
  private async showPage(index: number): Promise<void> {
    const pageContainer = document.getElementById('cr-page-container');
    if (!pageContainer || index < 0 || index >= this.pages.length) return;

    this.currentPageIndex = index;

    // Clear container
    pageContainer.innerHTML = '';

    const page = this.pages[index];

    // Create wrapper for aspect ratio first
    const wrapper = document.createElement('div');
    wrapper.className = 'cr-single-page-wrapper';
    // Set aspect ratio if known, otherwise use dynamic fallback
    wrapper.style.aspectRatio = page.width && page.height 
      ? `${page.width}/${page.height}` 
      : this.getDynamicFallbackRatio();

    // Create or get preloaded image
    let img: HTMLImageElement;
    const preloaded = this.preloadedImages.get(index);
    if (preloaded && preloaded.naturalWidth > 0) {
      img = preloaded;
    } else {
      // Remove failed preload if present
      if (preloaded) this.preloadedImages.delete(index);
      img = new Image();
      img.className = 'cr-single-page-img';
      img.alt = `Page ${index + 1}`;

      // Get image URL (may be proxied with caching) and set src
      try {
        const loadedImage = await loadImage(page.url, index);
        img.src = loadedImage.url;

        // Set aspect ratio from loaded dimensions (overwrites fallback)
        if (loadedImage.width && loadedImage.height) {
          wrapper.style.aspectRatio = `${loadedImage.width}/${loadedImage.height}`;

          // Notify if page didn't already have dimensions (for cache persistence)
          if (!page.width || !page.height) {
            this.onPageDimensionsLoaded?.(index, page.url, loadedImage.width, loadedImage.height);
            // Update local page object
            page.width = loadedImage.width;
            page.height = loadedImage.height;
          }
        }
      } catch (error) {
        console.error(`[SinglePageReader] Failed to load page ${index + 1}:`, error);
        wrapper.innerHTML = `
          <div class="cr-page-error">
            <span>Failed to load page ${index + 1}</span>
            <button class="cr-retry-page" data-index="${index}">Retry</button>
          </div>
        `;
        wrapper.classList.add('cr-page-failed');
        pageContainer.appendChild(wrapper);
        this.imageElements = [wrapper];
        this.emitProgress();
        return;
      }
    }

    img.className = 'cr-single-page-img';
    img.alt = `Page ${index + 1}`;

    // Track image load for anchor callback
    const checkAnchorReady = () => {
      if (!this.anchorCallbackFired && this.pendingAnchorIndex >= 0 && index === this.pendingAnchorIndex) {
        this.anchorCallbackFired = true;
        if (this.anchorRestoreTimeout) {
          clearTimeout(this.anchorRestoreTimeout);
          this.anchorRestoreTimeout = null;
        }
        this.pendingAnchorIndex = -1;
        this.onAnchorImagesReady?.();
      }
    };
    
    // Check if already loaded (from preload cache)
    if (img.complete && img.naturalWidth > 0) {
      checkAnchorReady();
    } else {
      img.addEventListener('load', checkAnchorReady, { once: true });
    }

    wrapper.appendChild(img);
    pageContainer.appendChild(wrapper);

    // Store reference
    this.imageElements = [wrapper];

    // Update indicators
    this.updateIndicators();

    // Update progress callback
    this.emitProgress();

    // Preload adjacent pages
    this.preloadAdjacent();
  }

  /**
   * Preload adjacent pages
   */
  private async preloadAdjacent(): Promise<void> {
    for (let offset = 1; offset <= this.preloadDistance; offset++) {
      // Preload next
      const nextIndex = this.currentPageIndex + offset;
      if (nextIndex < this.pages.length && !this.preloadedImages.has(nextIndex)) {
        const img = new Image();
        this.preloadedImages.set(nextIndex, img);
        // Get image URL (may be proxied with caching) and set src
        loadImage(this.pages[nextIndex].url, nextIndex).then(loaded => {
          img.src = loaded.url;
        }).catch(err => {
          console.error('[SinglePageReader] Preload error:', err);
          this.preloadedImages.delete(nextIndex);
        });
      }

      // Preload prev
      const prevIndex = this.currentPageIndex - offset;
      if (prevIndex >= 0 && !this.preloadedImages.has(prevIndex)) {
        const img = new Image();
        this.preloadedImages.set(prevIndex, img);
        // Get image URL (may be proxied with caching) and set src
        loadImage(this.pages[prevIndex].url, prevIndex).then(loaded => {
          img.src = loaded.url;
        }).catch(err => {
          console.error('[SinglePageReader] Preload error:', err);
          this.preloadedImages.delete(prevIndex);
        });
      }
    }

    // Clean up distant preloads to save memory
    this.cleanupPreloads();
  }

  /**
   * Clean up distant preloaded images
   */
  private cleanupPreloads(): void {
    const keepRange = this.preloadDistance * 2;
    for (const [index] of this.preloadedImages) {
      if (Math.abs(index - this.currentPageIndex) > keepRange) {
        this.preloadedImages.delete(index);
      }
    }
  }

  /**
   * Go to specific page
   */
  goToPage(index: number): void {
    if (index >= 0 && index < this.pages.length) {
      this.showPage(index);
    }
  }

  /**
   * Go to previous page
   */
  prevPage(): void {
    if (this.currentPageIndex > 0) {
      this.showPage(this.currentPageIndex - 1);
    } else if (!this.isFirstChapter) {
      // At first page - trigger prev chapter if not first
      this.onChapterEnd?.('prev');
    }
  }

  /**
   * Go to next page
   */
  nextPage(): void {
    if (this.currentPageIndex < this.pages.length - 1) {
      this.showPage(this.currentPageIndex + 1);
    } else if (!this.isLastChapter) {
      // At last page - trigger next chapter if not last
      this.onChapterEnd?.('next');
    }
  }

  /**
   * Emit progress update
   */
  private emitProgress(): void {
    this.onProgressUpdate?.(this.currentPageIndex + 1, this.pages.length);
  }

  /**
   * Get current reading position
   */
  getPosition(): ReadingPosition {
    return {
      anchorImageIndex: this.currentPageIndex,
      anchorImageOffset: 0,
      scrollTop: 0,
      viewportHeight: this.container.clientHeight,
      timestamp: Date.now(),
    };
  }

  /**
   * Check if reader is at the last page
   */
  isAtEnd(): boolean {
    return this.pages.length <= 1 || this.currentPageIndex >= this.pages.length - 1;
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
   * Get current page index
   */
  getCurrentPage(): number {
    return this.currentPageIndex;
  }

  /**
   * Cleanup
   */
  /**
   * Retry loading a failed page
   */
  retryPage(_index: number): void {
    this.showPage(this.currentPageIndex);
  }

  destroy(): void {
    super.destroy();
    this.preloadedImages.clear();
    this.anchorCallbackFired = false;
  }
}
