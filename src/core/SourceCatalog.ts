import { storage, STORAGE_KEYS } from './Storage';

/**
 * SourceCatalogManager - Which built-in catalog presets the user enabled,
 * plus per-source facts the engines learn at runtime (real manga path,
 * image CDN hosts, listing mechanism). One key (`source_catalog`); the
 * registry reads `enabled` at startup and registers an engine instance per
 * id; host permissions are requested at enable time (per-origin, never
 * broad). `learned` is additive — older builds simply ignore it.
 */

export interface LearnedSource {
  /** Path segment(s) between baseUrl and the manga slug, e.g. "serie" or "read-1". */
  mangaPath?: string;
  /** Image CDN hostnames discovered by checks; merged into grants + referer rules. */
  imageHosts?: string[];
  /** Site paginates listings via the admin-ajax load-more POST. */
  loadMore?: boolean;
}

interface CatalogStore {
  v: 1;
  enabled: string[];
  learned?: Record<string, LearnedSource>;
}

const EMPTY: CatalogStore = { v: 1, enabled: [] };

export class SourceCatalogManager {
  private async load(): Promise<CatalogStore> {
    const store = await storage.get<CatalogStore>(STORAGE_KEYS.SOURCE_CATALOG, { ...EMPTY, enabled: [] });
    if (!Array.isArray(store.enabled)) store.enabled = [];
    return store;
  }

  async getEnabledIds(): Promise<string[]> {
    return (await this.load()).enabled;
  }

  async isEnabled(id: string): Promise<boolean> {
    return (await this.getEnabledIds()).includes(id);
  }

  async enable(id: string): Promise<void> {
    const store = await this.load();
    if (!store.enabled.includes(id)) {
      store.enabled.push(id);
      await storage.set(STORAGE_KEYS.SOURCE_CATALOG, store);
    }
  }

  async disable(id: string): Promise<void> {
    const store = await this.load();
    const next = store.enabled.filter((e) => e !== id);
    const hadLearned = !!store.learned?.[id];
    if (next.length !== store.enabled.length || hadLearned) {
      store.enabled = next;
      if (hadLearned) delete store.learned![id];
      await storage.set(STORAGE_KEYS.SOURCE_CATALOG, store);
    }
  }

  async getLearned(id: string): Promise<LearnedSource> {
    return (await this.load()).learned?.[id] ?? {};
  }

  /** Merge a patch into a source's learned facts (imageHosts are unioned). */
  async patchLearned(id: string, patch: LearnedSource): Promise<void> {
    const store = await this.load();
    const current = store.learned?.[id] ?? {};
    const merged: LearnedSource = { ...current, ...patch };
    if (patch.imageHosts) {
      merged.imageHosts = [...new Set([...(current.imageHosts ?? []), ...patch.imageHosts])];
    }
    store.learned = { ...(store.learned ?? {}), [id]: merged };
    await storage.set(STORAGE_KEYS.SOURCE_CATALOG, store);
  }
}

export const sourceCatalogManager = new SourceCatalogManager();
