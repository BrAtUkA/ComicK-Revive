import { MangaReadingState, ReadingPosition, ReadingMode, ImageFit } from '@/types';
import { storage, STORAGE_KEYS } from './Storage';
import { settingsManager } from './Settings';

/**
 * ReadingStateManager - Manages per-manga reading progress and settings
 */
export class ReadingStateManager {
  private cache: Map<string, MangaReadingState> = new Map();

  /**
   * Get storage key for a manga
   */
  private getKey(comickSlug: string): string {
    return `${STORAGE_KEYS.READING_STATE_PREFIX}${comickSlug}`;
  }

  /**
   * Get reading state for a manga
   */
  async get(comickSlug: string): Promise<MangaReadingState | null> {
    if (this.cache.has(comickSlug)) {
      return this.cache.get(comickSlug)!;
    }

    const key = this.getKey(comickSlug);
    const exists = await storage.exists(key);

    if (!exists) {
      return null;
    }

    const state = await storage.get<MangaReadingState>(key, null as unknown as MangaReadingState);

    if (state) {
      if (!state.chapterPositions) {
        state.chapterPositions = {};
      }
      this.cache.set(comickSlug, state);
    }

    return state;
  }

  /**
   * Check if manga has saved progress
   */
  async hasProgress(comickSlug: string): Promise<boolean> {
    return await storage.exists(this.getKey(comickSlug));
  }

  /**
   * Save reading state
   */
  async save(comickSlug: string, state: MangaReadingState): Promise<void> {
    const key = this.getKey(comickSlug);
    state.lastRead = Date.now();
    
    await storage.set(key, state);
    this.cache.set(comickSlug, state);
  }

  /**
   * Update position for current chapter (source-scoped)
   */
  async updatePosition(
    comickSlug: string,
    sourceId: string,
    chapter: number,
    position: ReadingPosition,
    pageCount: number
  ): Promise<void> {
    let state = await this.get(comickSlug);
    const settings = await settingsManager.load();

    if (!state) {
      // Create new state with defaults
      state = {
        currentChapter: chapter,
        chapterPositions: { [sourceId]: { [chapter]: { ...position } } },
        readingMode: settings.defaultReadingMode,
        zoomLevel: 100,
        imageFit: settings.defaultImageFit,
        chapterPageCount: pageCount,
        chapterPageCounts: { [sourceId]: { [chapter]: pageCount } },
        lastRead: Date.now(),
      };
    } else {
      state.currentChapter = chapter;
      state.chapterPageCount = pageCount;

      if (!state.chapterPositions) {
        state.chapterPositions = {};
      }
      if (!state.chapterPositions[sourceId]) {
        state.chapterPositions[sourceId] = {};
      }
      state.chapterPositions[sourceId][chapter] = { ...position };

      if (!state.chapterPageCounts) {
        state.chapterPageCounts = {};
      }
      if (!state.chapterPageCounts[sourceId]) {
        state.chapterPageCounts[sourceId] = {};
      }
      state.chapterPageCounts[sourceId][chapter] = pageCount;
    }

    console.log('[ReadingState] updatePosition:', {
      sourceId,
      chapter,
      position,
    });

    await this.save(comickSlug, state);
  }

  /**
   * Update display settings
   */
  async updateDisplaySettings(
    comickSlug: string,
    settings: {
      readingMode?: ReadingMode;
      zoomLevel?: number;
      imageFit?: ImageFit;
    }
  ): Promise<void> {
    const state = await this.get(comickSlug);
    if (!state) return;

    if (settings.readingMode !== undefined) {
      state.readingMode = settings.readingMode;
    }
    if (settings.zoomLevel !== undefined) {
      state.zoomLevel = settings.zoomLevel;
    }
    if (settings.imageFit !== undefined) {
      state.imageFit = settings.imageFit;
    }

    await this.save(comickSlug, state);
  }

  /**
   * Get position for a specific chapter on a specific source
   */
  async getChapterPosition(
    comickSlug: string,
    sourceId: string,
    chapter: number
  ): Promise<ReadingPosition | null> {
    const state = await this.get(comickSlug);
    const position = state?.chapterPositions?.[sourceId]?.[chapter] ?? null;
    return position ? { ...position } : null;
  }

  /**
   * Get page counts for a specific source
   */
  getSourcePageCounts(state: MangaReadingState, sourceId: string): Record<number, number> | undefined {
    return state.chapterPageCounts?.[sourceId];
  }

  /**
   * Get positions for a specific source
   */
  getSourcePositions(state: MangaReadingState, sourceId: string): Record<number, ReadingPosition> | undefined {
    return state.chapterPositions?.[sourceId];
  }

  /**
   * Clear reading state for a manga
   */
  async clear(comickSlug: string): Promise<void> {
    await storage.remove(this.getKey(comickSlug));
    this.cache.delete(comickSlug);
  }

  /**
   * Invalidate cache for a manga (forces reload from storage on next get)
   */
  invalidateCache(comickSlug: string): void {
    this.cache.delete(comickSlug);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // READ CHAPTER TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a chapter is marked as read
   */
  async isChapterRead(comickSlug: string, chapter: number): Promise<boolean> {
    const state = await this.get(comickSlug);
    return state?.readChapters?.includes(chapter) ?? false;
  }

  /**
   * Get all read chapters for a manga
   */
  async getReadChapters(comickSlug: string): Promise<number[]> {
    const state = await this.get(comickSlug);
    return state?.readChapters ?? [];
  }

  /**
   * Mark a chapter as read
   */
  async markChapterRead(comickSlug: string, chapter: number): Promise<void> {
    let state = await this.get(comickSlug);
    const settings = await settingsManager.load();
    
    if (!state) {
      // Create minimal state for tracking
      state = {
        currentChapter: chapter,
        chapterPositions: {},
        readingMode: settings.defaultReadingMode,
        zoomLevel: 100,
        imageFit: settings.defaultImageFit,
        chapterPageCount: 0,
        lastRead: Date.now(),
        readChapters: [chapter],
      };
    } else {
      state.readChapters = state.readChapters ?? [];
      if (!state.readChapters.includes(chapter)) {
        state.readChapters.push(chapter);
        state.readChapters.sort((a, b) => a - b);
      }
    }
    
    await this.save(comickSlug, state);
  }

  /**
   * Mark a chapter as unread
   */
  async markChapterUnread(comickSlug: string, chapter: number): Promise<void> {
    const state = await this.get(comickSlug);
    if (!state || !state.readChapters) return;
    
    state.readChapters = state.readChapters.filter(c => c !== chapter);
    await this.save(comickSlug, state);
  }

  /**
   * Mark all chapters before (not including) a chapter as read
   */
  async markChaptersUpToRead(comickSlug: string, beforeChapter: number, allChapters: number[]): Promise<void> {
    let state = await this.get(comickSlug);
    const settings = await settingsManager.load();
    
    const chaptersToMark = allChapters.filter(c => c < beforeChapter);
    
    if (!state) {
      state = {
        currentChapter: beforeChapter,
        chapterPositions: {},
        readingMode: settings.defaultReadingMode,
        zoomLevel: 100,
        imageFit: settings.defaultImageFit,
        chapterPageCount: 0,
        lastRead: Date.now(),
        readChapters: chaptersToMark,
      };
    } else {
      state.readChapters = state.readChapters ?? [];
      for (const ch of chaptersToMark) {
        if (!state.readChapters.includes(ch)) {
          state.readChapters.push(ch);
        }
      }
      state.readChapters.sort((a, b) => a - b);
    }
    
    await this.save(comickSlug, state);
  }

  /**
   * Mark all chapters before (not including) a chapter as unread
   */
  async markChaptersUpToUnread(comickSlug: string, beforeChapter: number): Promise<void> {
    const state = await this.get(comickSlug);
    if (!state || !state.readChapters) return;
    
    state.readChapters = state.readChapters.filter(c => c >= beforeChapter);
    await this.save(comickSlug, state);
  }

  /**
   * Mark all chapters as unread
   */
  async markAllUnread(comickSlug: string): Promise<void> {
    const state = await this.get(comickSlug);
    if (!state) return;
    
    state.readChapters = [];
    await this.save(comickSlug, state);
  }

  /**
   * Clear all reading states
   */
  async clearAll(): Promise<void> {
    await storage.removeByPrefix(STORAGE_KEYS.READING_STATE_PREFIX);
    this.cache.clear();
  }

  /**
   * Get all manga with saved progress
   */
  async getAllWithProgress(): Promise<{ slug: string; state: MangaReadingState }[]> {
    const all = await storage.getByPrefix<MangaReadingState>(
      STORAGE_KEYS.READING_STATE_PREFIX
    );

    return Object.entries(all).map(([key, state]) => ({
      slug: key.replace(STORAGE_KEYS.READING_STATE_PREFIX, ''),
      state,
    }));
  }
}

// Singleton instance
export const readingStateManager = new ReadingStateManager();
