import { ReadingPosition, ReadingMode, DEFAULT_POSITION } from '@/types';

/**
 * ScrollAnchor - Content-anchored position tracking
 * 
 * Instead of storing pixel scroll positions (which break on resize/zoom/mode change),
 * we track which image the user is viewing and how far into that image.
 * This allows perfect position restoration across layout changes.
 */
export class ScrollAnchor {
  private anchor: ReadingPosition | null = null;

  /**
   * Capture current viewing position BEFORE any layout change.
   * Call this before: resize, zoom change, mode switch
   */
  capture(container: HTMLElement, images: HTMLElement[]): ReadingPosition {
    if (images.length === 0) {
      this.anchor = { ...DEFAULT_POSITION };
      return this.anchor;
    }

    const viewportTop = container.scrollTop;

    // Find which image is at or crossing the viewport top
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imgTop = img.offsetTop;
      const imgHeight = img.offsetHeight;
      const imgBottom = imgTop + imgHeight;

      if (imgBottom > viewportTop) {
        // This image is at or crossing viewport top
        const offset = imgHeight > 0 
          ? Math.max(0, Math.min(1, (viewportTop - imgTop) / imgHeight))
          : 0;

        this.anchor = {
          anchorImageIndex: i,
          anchorImageOffset: offset,
        };
        return this.anchor;
      }
    }

    // Fallback: user scrolled past all images, anchor to last
    this.anchor = {
      anchorImageIndex: images.length - 1,
      anchorImageOffset: 1,
    };
    return this.anchor;
  }

  /**
   * Restore position AFTER layout change.
   * Call this after: resize settles, zoom applied, mode switched, images loaded
   */
  restore(container: HTMLElement, images: HTMLElement[]): void {
    if (!this.anchor || images.length === 0) return;

    // Clamp anchor index to valid range (in case chapter changed)
    const index = Math.min(this.anchor.anchorImageIndex, images.length - 1);
    const img = images[index];
    if (!img) return;

    // Force synchronous layout reflow before calculating position
    // This ensures all pending style changes (aspectRatio, etc.) are applied
    void container.offsetHeight;
    void img.offsetHeight;

    const targetScroll = img.offsetTop + (img.offsetHeight * this.anchor.anchorImageOffset);
    
    // Use direct scrollTop assignment for guaranteed synchronous scroll
    // (scrollTo with 'instant' can still be async in some browsers)
    container.scrollTop = targetScroll;
  }

  /**
   * Get current anchor without capturing
   */
  getAnchor(): ReadingPosition | null {
    return this.anchor ? { ...this.anchor } : null;
  }

  /**
   * Set anchor directly (e.g., from saved state)
   */
  setAnchor(position: ReadingPosition): void {
    this.anchor = { ...position };
  }

  /**
   * Clear the anchor
   */
  clear(): void {
    this.anchor = null;
  }

  /**
   * Convert position between reading modes.
   * 
   * Vertical: anchorImageIndex is exact, anchorImageOffset is scroll within
   * Single: anchorImageIndex is current page, offset is ignored (always 0)
   * Double: anchorImageIndex is left page of spread, offset is ignored
   */
  static convert(
    position: ReadingPosition,
    fromMode: ReadingMode,
    toMode: ReadingMode,
    _totalPages: number
  ): ReadingPosition {
    if (fromMode === toMode) {
      return { ...position };
    }

    const pageIndex = position.anchorImageIndex;

    // From Vertical
    if (fromMode === 'vertical') {
      if (toMode === 'single') {
        // Use the anchor image as current page
        return {
          anchorImageIndex: pageIndex,
          anchorImageOffset: 0,
        };
      }
      if (toMode === 'double') {
        // Convert to spread (even page numbers)
        return {
          anchorImageIndex: Math.floor(pageIndex / 2) * 2,
          anchorImageOffset: 0,
        };
      }
    }

    // From Single
    if (fromMode === 'single') {
      if (toMode === 'vertical') {
        // Current page becomes anchor, start at top
        return {
          anchorImageIndex: pageIndex,
          anchorImageOffset: 0,
        };
      }
      if (toMode === 'double') {
        // Convert to spread
        return {
          anchorImageIndex: Math.floor(pageIndex / 2) * 2,
          anchorImageOffset: 0,
        };
      }
    }

    // From Double
    if (fromMode === 'double') {
      if (toMode === 'vertical') {
        // Left page of spread becomes anchor
        return {
          anchorImageIndex: pageIndex,
          anchorImageOffset: 0,
        };
      }
      if (toMode === 'single') {
        // Left page of spread becomes current
        return {
          anchorImageIndex: pageIndex,
          anchorImageOffset: 0,
        };
      }
    }

    // Fallback
    return { ...position };
  }

  /**
   * Get page index from position (for display purposes)
   */
  static getPageIndex(position: ReadingPosition): number {
    return position.anchorImageIndex;
  }

  /**
   * Create position for specific page
   */
  static forPage(pageIndex: number): ReadingPosition {
    return {
      anchorImageIndex: pageIndex,
      anchorImageOffset: 0,
    };
  }
}
