import { Chapter, ReadingPosition } from '@/types';

/** Tracks a chapter's pages within the continuous scroll container */
export interface ChapterSegment {
  chapterNumber: number;
  chapter: Chapter;
  startIndex: number;   // Global image index where this chapter starts
  pageCount: number;
}

/** Identifies a source + manga + chapter for cache key construction */
export interface CacheContextBase {
  sourceId: string;
  mangaSlug: string;
  chapterSlug: string;
}

/** Per-page cache context including the local (within-chapter) page index */
export interface PageCacheContext extends CacheContextBase {
  localIndex: number;
}

/**
 * ContinuousReadingManager — Pure data model for multi-chapter continuous reading.
 *
 * Owns:
 *  - Chapter segment tracking (which chapters are loaded and their index ranges)
 *  - Per-page cache context mapping (global index → source/manga/chapter/localIndex)
 *  - Trigger guard flags (prevent duplicate next/prev chapter requests)
 *  - Position translation (global index ↔ per-chapter local index)
 *
 * Does NOT own any DOM, IntersectionObservers, or scroll handling.
 * The VerticalReader owns all DOM concerns and delegates data queries here.
 */
export class ContinuousReadingManager {
  private segments: ChapterSegment[] = [];
  private _currentSegmentIndex: number = 0;
  private cacheContexts: Map<number, PageCacheContext> = new Map();
  private _nextRequested: boolean = false;
  private _prevRequested: boolean = false;

  readonly mainChapter: Chapter;
  readonly mainCacheContext: CacheContextBase | undefined;

  constructor(mainChapter: Chapter, mainCacheContext?: CacheContextBase) {
    this.mainChapter = mainChapter;
    this.mainCacheContext = mainCacheContext;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEGMENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Append a new segment at the end (for appended chapters or initial build). */
  addSegment(chapter: Chapter, startIndex: number, pageCount: number): void {
    this.segments.push({ chapterNumber: chapter.number, chapter, startIndex, pageCount });
  }

  /**
   * Prepend a segment at the front, shifting all existing segment startIndex values by pageCount.
   * Callers must separately shift their own index-based state (loadedImages, imageElements, etc.).
   */
  prependSegment(chapter: Chapter, pageCount: number): void {
    for (const seg of this.segments) {
      seg.startIndex += pageCount;
    }
    this.segments.unshift({
      chapterNumber: chapter.number,
      chapter,
      startIndex: 0,
      pageCount,
    });
    this._currentSegmentIndex++;
  }

  /** Get all segments (read-only view). */
  getSegments(): readonly ChapterSegment[] {
    return this.segments;
  }

  /** Find which segment a global image index belongs to (reverse scan). */
  getSegmentForIndex(globalIndex: number): ChapterSegment | null {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (globalIndex >= this.segments[i].startIndex) {
        return this.segments[i];
      }
    }
    return this.segments[0] || null;
  }

  /** Find a segment by chapter number. */
  getSegmentByChapter(chapterNumber: number): ChapterSegment | null {
    return this.segments.find(s => s.chapterNumber === chapterNumber) || null;
  }

  get currentSegmentIndex(): number {
    return this._currentSegmentIndex;
  }

  set currentSegmentIndex(idx: number) {
    this._currentSegmentIndex = idx;
  }

  /** Get the index of a segment in the segments array. Returns -1 if not found. */
  indexOfSegment(seg: ChapterSegment): number {
    return this.segments.indexOf(seg);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CACHE CONTEXT MAPPING
  // ═══════════════════════════════════════════════════════════════════════════

  /** Store cache contexts for a contiguous range of global page indices. */
  setCacheContexts(startIndex: number, count: number, context: CacheContextBase): void {
    for (let i = 0; i < count; i++) {
      this.cacheContexts.set(startIndex + i, {
        ...context,
        localIndex: i,
      });
    }
  }

  /** Get the cache context for a specific global page index. */
  getCacheContext(globalIndex: number): PageCacheContext | undefined {
    return this.cacheContexts.get(globalIndex);
  }

  /**
   * Shift all cache context keys by an offset (used when prepending chapters).
   * Existing entries get shifted up; caller should add new entries for indices 0..offset-1.
   */
  shiftCacheContexts(offset: number): void {
    const shifted = new Map<number, PageCacheContext>();
    for (const [idx, ctx] of this.cacheContexts) {
      shifted.set(idx + offset, ctx);
    }
    this.cacheContexts = shifted;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRIGGER FLAGS
  // ═══════════════════════════════════════════════════════════════════════════

  get nextRequested(): boolean {
    return this._nextRequested;
  }

  set nextRequested(val: boolean) {
    this._nextRequested = val;
  }

  get prevRequested(): boolean {
    return this._prevRequested;
  }

  set prevRequested(val: boolean) {
    this._prevRequested = val;
  }

  resetTriggerFlags(): void {
    this._nextRequested = false;
    this._prevRequested = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITION TRANSLATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert a global image index to per-chapter progress.
   * Returns null if no segments exist.
   */
  getContinuousProgress(anchorImageIndex: number): { chapterNumber: number; currentPage: number; totalPages: number } | null {
    if (this.segments.length === 0) return null;

    const seg = this.getSegmentForIndex(anchorImageIndex);
    if (!seg) return null;

    const localPage = Math.min(anchorImageIndex - seg.startIndex + 1, seg.pageCount);
    return {
      chapterNumber: seg.chapterNumber,
      currentPage: localPage,
      totalPages: seg.pageCount,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  destroy(): void {
    this.segments = [];
    this._currentSegmentIndex = 0;
    this.cacheContexts.clear();
    this._nextRequested = false;
    this._prevRequested = false;
  }
}
