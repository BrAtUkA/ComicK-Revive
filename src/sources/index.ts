import { MangaSource } from './Source.interface';
import { asuraScans } from './AsuraScans';
import { mangaKatana } from './MangaKatana';
import { mangaDex } from './MangaDex';
import { createCachedSource, CachedMangaSource } from './CachedSource';

/**
 * Source Registry - Central registry for all manga sources
 * 
 * All sources are wrapped with caching layer for improved performance.
 */
class SourceRegistry {
  private sources: Map<string, MangaSource> = new Map();
  private cachedSources: Map<string, CachedMangaSource> = new Map();

  constructor() {
    // Register built-in sources with caching
    this.register(asuraScans);
    this.register(mangaKatana);
    this.register(mangaDex);
  }

  /**
   * Register a new source (with caching wrapper)
   */
  register(source: MangaSource): void {
    const cached = createCachedSource(source);
    this.sources.set(source.id, cached);
    this.cachedSources.set(source.id, cached);
  }

  /**
   * Get a source by ID (returns cached wrapper)
   */
  get(id: string): MangaSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Get the cached source wrapper for advanced operations (like force refresh)
   */
  getCached(id: string): CachedMangaSource | undefined {
    return this.cachedSources.get(id);
  }

  /**
   * Get all registered sources
   */
  getAll(): MangaSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Get all source IDs
   */
  getIds(): string[] {
    return Array.from(this.sources.keys());
  }

  /**
   * Check if a source exists
   */
  has(id: string): boolean {
    return this.sources.has(id);
  }

  /**
   * Force refresh chapters for a source/manga (invalidates cache)
   */
  async invalidateChapters(sourceId: string, mangaSlug: string): Promise<void> {
    const cached = this.cachedSources.get(sourceId);
    if (cached) {
      await cached.invalidateChapterList(mangaSlug);
    }
  }
}

// Export singleton registry
export const sourceRegistry = new SourceRegistry();

// Re-export types and sources
export type { MangaSource } from './Source.interface';
export { SourceError } from './Source.interface';
export { AsuraScans, asuraScans } from './AsuraScans';
export { MangaKatana, mangaKatana } from './MangaKatana';
export { MangaDex, mangaDex } from './MangaDex';
export { CachedMangaSource } from './CachedSource';
