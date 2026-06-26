import { PageInfo, ReadingPosition, ReadingMode, ImageFit } from '@/types';
import { ScrollAnchor } from '@/core';

/**
 * BaseReader - Abstract base class for all reading modes
 */
export abstract class BaseReader {
  protected container: HTMLElement;
  protected pages: PageInfo[] = [];
  protected imageElements: HTMLElement[] = [];
  protected scrollAnchor: ScrollAnchor;
  protected mode: ReadingMode = 'vertical';
  protected imageFit: ImageFit = 'width';
  protected zoom: number = 100;

  // Default aspect ratio for placeholders (per-manga, set from mapping)
  defaultAspectRatio: string = '2/3';
  
  // Chapter bounds
  protected isFirstChapter: boolean = false;
  protected isLastChapter: boolean = false;
  protected hasGapNext: boolean = false;
  protected hasGapPrev: boolean = false;
  
  // Anchor image loading state
  protected pendingAnchorIndex: number = -1;
  protected anchorRestoreTimeout: ReturnType<typeof setTimeout> | null = null;

  // Tracks whether this reader has been destroyed
  protected destroyed = false;

  // Whether this load is a refetch (caches cleared, guaranteed uncached)
  isRefetching: boolean = false;
  
  // Callbacks
  onProgressUpdate?: (currentPage: number, totalPages: number) => void;
  onChapterEnd?: (direction: 'prev' | 'next') => void;
  onRequestNextChapter?: () => void;
  onCurrentChapterChange?: (chapterNumber: number, currentPage: number, totalPages: number) => void;
  protected onPositionChange?: (position: ReadingPosition) => void;
  
  /**
   * Callback fired when position restore begins (overlay should show).
   * Called when restorePosition() is invoked with a non-zero position.
   */
  onRestoreStart?: () => void;
  
  /**
   * Callback fired when anchor image (and all images before it) have loaded,
   * meaning it's safe to restore scroll position with accurate dimensions.
   * Will also fire after timeout as fallback.
   */
  onAnchorImagesReady?: () => void;

  /**
   * Callback fired when an image's dimensions are loaded for the first time.
   * Used by Viewer to persist dimensions to SourceDataCache for scroll preservation.
   * Only fires if the page didn't already have dimensions.
   */
  onPageDimensionsLoaded?: (pageIndex: number, url: string, width: number, height: number) => void;

  /**
   * Callback fired during image loading to report progress.
   * Used by Viewer to show progress on the overlay during slow loads.
   * @param loaded - number of required images that have finished loading
   * @param total - total number of required images
   */
  onRestoreProgress?: (loaded: number, total: number) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scrollAnchor = new ScrollAnchor();
  }

  /**
   * Get the reading mode of this reader.
   * Used by the Viewer to correctly translate position between modes during a mode switch.
   */
  getMode(): ReadingMode {
    return this.mode;
  }

  /**
   * Set chapter boundary info (for disabling nav buttons)
   */
  setChapterBounds(isFirst: boolean, isLast: boolean, hasGapNext?: boolean, hasGapPrev?: boolean): void {
    this.isFirstChapter = isFirst;
    this.isLastChapter = isLast;
    this.hasGapNext = hasGapNext ?? false;
    this.hasGapPrev = hasGapPrev ?? false;
  }

  /**
   * Set pages to display
   */
  setPages(pages: PageInfo[]): void {
    this.pages = pages;
  }

  /**
   * Configure reader options (can be called after render to update)
   */
  configure(options: { imageFit?: ImageFit; zoom?: number; backgroundColor?: string; scrollAmount?: number; scrollSpeed?: number }): void {
    if (options.imageFit !== undefined) {
      this.imageFit = options.imageFit;
    }
    if (options.zoom !== undefined) {
      this.zoom = options.zoom;
    }
  }

  /**
   * Set position change callback
   */
  onPositionUpdate(callback: (position: ReadingPosition) => void): void {
    this.onPositionChange = callback;
  }

  /**
   * Start continuous scrolling (hold key behavior).
   * Override in readers that support it (e.g., VerticalReader).
   */
  startContinuousScroll(_direction: 1 | -1): void {
    // No-op for page-based readers
  }

  /**
   * Stop continuous scrolling.
   */
  stopContinuousScroll(): void {
    // No-op for page-based readers
  }

  /**
   * Get current position
   */
  getPosition(): ReadingPosition {
    return this.scrollAnchor.capture(this.container, this.imageElements);
  }

  /**
   * Restore position
   */
  restorePosition(position: ReadingPosition): void {
    this.scrollAnchor.setAnchor(position);
    if (this.imageElements.length > 0) {
      this.scrollAnchor.restore(this.container, this.imageElements);
    }
  }

  /**
   * Set position (alias for restorePosition)
   */
  setPosition(position: ReadingPosition): void {
    this.restorePosition(position);
  }

  /**
   * Enable sequential loading mode (images load one by one in order).
   * Override in subclasses that support this mode.
   */
  enableSequentialLoading(_firstReadyCount?: number): void {
    // Default: no-op. Override in VerticalReader.
  }

  /**
   * Get current page index
   */
  getCurrentPage(): number {
    const position = this.getPosition();
    return position.anchorImageIndex;
  }

  /**
   * Get total pages
   */
  getTotalPages(): number {
    return this.pages.length;
  }

  /**
   * Get image elements (for external scroll anchor use)
   */
  getImageElements(): HTMLElement[] {
    return this.imageElements;
  }

  /**
   * Render the reader
   */
  abstract render(): void;

  /**
   * Go to specific page
   */
  abstract goToPage(pageIndex: number): void;

  /**
   * Go to next page/section
   */
  abstract nextPage(): void;

  /**
   * Go to previous page/section
   */
  abstract prevPage(): void;

  /**
   * Check if the reader is at the end of the chapter
   */
  abstract isAtEnd(): boolean;

  /**
   * Aliases for navigation
   */
  next(): void {
    this.nextPage();
  }

  prev(): void {
    this.prevPage();
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.destroyed = true;
    // Clear anchor timeout if pending
    if (this.anchorRestoreTimeout) {
      clearTimeout(this.anchorRestoreTimeout);
      this.anchorRestoreTimeout = null;
    }
    this.pendingAnchorIndex = -1;
    this.container.innerHTML = '';
    this.imageElements = [];
    this.pages = [];
  }

  /**
   * Retry loading a failed page. Override in subclasses.
   */
  retryPage(_index: number): void {
    // Default no-op
  }
}
