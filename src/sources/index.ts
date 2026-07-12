import { MangaSource } from './Source.interface';
import { asuraScans } from './AsuraScans';
import { mangaKatana } from './MangaKatana';
import { mangaDex } from './MangaDex';
import { createCachedSource, CachedMangaSource } from './CachedSource';
import { sourceConfigManager } from '@/core/SourceConfig';
import { userSourcesManager } from '@/core/UserSources';
import { sourceCatalogManager } from '@/core/SourceCatalog';
import { DeclarativeSource } from './spec/DeclarativeSource';
import type { SourceSpecV1 } from './spec/SourceSpec';
import { MadaraSource } from './engines/Madara';
import { getCatalogPreset, type CatalogPreset } from './catalog/presets';

/** Engine dispatch for catalog presets. Also used by the catalog's batch
 *  tester to run presets that aren't enabled (detached, never registered). */
export function createEngineSource(preset: CatalogPreset): MangaSource {
  switch (preset.engine) {
    case 'madara':
      return new MadaraSource(preset);
  }
}

/**
 * Source Registry - Central registry for all manga sources
 *
 * All sources are wrapped with caching layer for improved performance.
 *
 * Config-aware: `getAll()`/`getIds()` return sources in the user's priority
 * order with disabled sources filtered out (pass `includeDisabled: true` for
 * display/abort paths that must see everything). `get(id)` deliberately
 * ignores the disabled list so manga already linked to a disabled source
 * keep working. The config snapshot loads asynchronously at startup; call
 * `refreshConfig()` at entry points that must see changes made from another
 * context (e.g. the dashboard reordering sources while a reader tab is open).
 */
class SourceRegistry {
  private sources: Map<string, MangaSource> = new Map();
  private cachedSources: Map<string, CachedMangaSource> = new Map();
  private configOrder: string[] = [];
  private configDisabled: Set<string> = new Set();
  private userSourceIds: Set<string> = new Set();
  private catalogIds: Set<string> = new Set();
  private builtinIds: Set<string> = new Set();
  private rawSources: Map<string, MangaSource> = new Map();
  private originalBaseUrls: Map<string, string> = new Map();

  constructor() {
    // Register built-in sources with caching
    this.register(asuraScans);
    this.register(mangaKatana);
    this.register(mangaDex);
    this.builtinIds = new Set(this.sources.keys());

    // Load priority/enablement config; until it resolves, registration
    // order with everything enabled applies
    void this.refreshConfig();
    void this.loadUserSources();
    void this.loadCatalogSources();
    sourceConfigManager.subscribe((config) => {
      this.configOrder = config.order;
      this.configDisabled = new Set(config.disabled);
      this.applyOverrides(config.overrides ?? {});
    });
  }

  /** Load stored user specs and register them (startup + after imports). */
  async loadUserSources(): Promise<void> {
    try {
      const specs = await userSourcesManager.getAll();
      for (const spec of specs) {
        this.registerUserSource(spec);
      }
    } catch (error) {
      console.warn('[SourceRegistry] Failed to load user sources:', error);
    }
  }

  /** Register (or re-register after edit) a declarative user source. */
  registerUserSource(spec: SourceSpecV1): void {
    if (this.builtinIds.has(spec.id) || this.catalogIds.has(spec.id)) {
      throw new Error(`Source id "${spec.id}" collides with a built-in source`);
    }
    this.register(new DeclarativeSource(spec));
    this.userSourceIds.add(spec.id);
  }

  /** Remove a user source from the live registry (storage handled by caller). */
  unregisterUserSource(id: string): void {
    if (!this.userSourceIds.has(id)) return;
    this.sources.delete(id);
    this.cachedSources.delete(id);
    this.rawSources.delete(id);
    this.originalBaseUrls.delete(id);
    this.userSourceIds.delete(id);
  }

  isUserSource(id: string): boolean {
    return this.userSourceIds.has(id);
  }

  /** Load enabled catalog presets and register their engine instances. */
  async loadCatalogSources(): Promise<void> {
    try {
      const ids = await sourceCatalogManager.getEnabledIds();
      for (const id of ids) {
        const preset = getCatalogPreset(id);
        if (preset && !this.sources.has(id)) {
          this.registerCatalogSource(preset);
        }
      }
    } catch (error) {
      console.warn('[SourceRegistry] Failed to load catalog sources:', error);
    }
  }

  /** Register (or re-register) an enabled catalog preset. */
  registerCatalogSource(preset: CatalogPreset): void {
    if (this.builtinIds.has(preset.id) || this.userSourceIds.has(preset.id)) {
      throw new Error(`Catalog id "${preset.id}" collides with an existing source`);
    }
    this.register(createEngineSource(preset));
    this.catalogIds.add(preset.id);
  }

  /** Remove a catalog source from the live registry (storage handled by caller). */
  unregisterCatalogSource(id: string): void {
    if (!this.catalogIds.has(id)) return;
    this.sources.delete(id);
    this.cachedSources.delete(id);
    this.rawSources.delete(id);
    this.originalBaseUrls.delete(id);
    this.catalogIds.delete(id);
  }

  isCatalogSource(id: string): boolean {
    return this.catalogIds.has(id);
  }

  /**
   * Re-read source config from storage (order + disabled set).
   */
  async refreshConfig(): Promise<void> {
    try {
      const config = await sourceConfigManager.load();
      this.configOrder = config.order;
      this.configDisabled = new Set(config.disabled);
      this.applyOverrides(config.overrides ?? {});
    } catch (error) {
      console.warn('[SourceRegistry] Failed to load source config:', error);
    }
  }

  /**
   * Apply (or restore) custom domains on built-in sources. Best effort:
   * sources that talk to a separate API domain (e.g. Asura) only partially
   * follow the override.
   */
  private applyOverrides(overrides: Record<string, { baseUrl?: string }>): void {
    for (const id of this.builtinIds) {
      const raw = this.rawSources.get(id);
      const original = this.originalBaseUrls.get(id);
      if (!raw || !original) continue;
      const target = overrides[id]?.baseUrl?.replace(/\/+$/, '') || original;
      if (raw.baseUrl !== target) {
        (raw as { baseUrl: string }).baseUrl = target;
      }
    }
  }

  /**
   * Register a new source (with caching wrapper)
   */
  register(source: MangaSource): void {
    const cached = createCachedSource(source);
    this.sources.set(source.id, cached);
    this.cachedSources.set(source.id, cached);
    this.rawSources.set(source.id, source);
    this.originalBaseUrls.set(source.id, source.baseUrl);
  }

  /**
   * Get a source by ID (returns cached wrapper).
   * Works for disabled sources on purpose (linked manga keep reading).
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
   * Get the raw, uncached source instance (domain overrides applied).
   * Used by the source test harness so runs hit the live site.
   */
  getRaw(id: string): MangaSource | undefined {
    return this.rawSources.get(id);
  }

  /**
   * Get sources in priority order. Disabled sources are excluded unless
   * `includeDisabled` is set.
   */
  getAll(options?: { includeDisabled?: boolean }): MangaSource[] {
    const ordered = this.orderedIds().map((id) => this.sources.get(id)!);
    if (options?.includeDisabled) return ordered;
    return ordered.filter((s) => !this.configDisabled.has(s.id));
  }

  /**
   * Get source IDs in priority order (enabled only unless includeDisabled)
   */
  getIds(options?: { includeDisabled?: boolean }): string[] {
    return this.getAll(options).map((s) => s.id);
  }

  /**
   * Whether a source is enabled (appears in new searches / link flows)
   */
  isEnabled(id: string): boolean {
    return !this.configDisabled.has(id);
  }

  /**
   * Check if a source exists
   */
  has(id: string): boolean {
    return this.sources.has(id);
  }

  /** Stored priority order merged with registration order for unlisted ids */
  private orderedIds(): string[] {
    const registered = Array.from(this.sources.keys());
    const known = this.configOrder.filter((id) => this.sources.has(id));
    const rest = registered.filter((id) => !known.includes(id));
    return [...known, ...rest];
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
