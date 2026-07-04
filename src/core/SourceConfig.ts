import { storage, STORAGE_KEYS } from './Storage';
import { DEFAULT_SETTINGS, type GlobalSettings } from '@/types';

/**
 * SourceConfigManager - Persistent source priority and enablement
 *
 * Storage key `source_config`:
 * - `order`: source ids by priority. The first enabled source is the default
 *   for new manga, and search-all runs in this order. Ids missing from the
 *   list (newly registered sources) are appended in registration order by
 *   the registry.
 * - `disabled`: hidden from new searches and link flows. Manga already
 *   linked to a disabled source keep working (registry `get(id)` ignores
 *   this list on purpose).
 *
 * The registry keeps an in-memory snapshot of this config; call `load()`
 * again (it always re-reads storage, same lesson as SettingsManager) at
 * meaningful entry points to pick up changes made from other contexts.
 */

export interface SourceConfig {
  order: string[];
  disabled: string[];
  /** Per-source overrides (built-ins only): custom domain when a site moves. */
  overrides?: Record<string, { baseUrl?: string }>;
}

export class SourceConfigManager {
  private config: SourceConfig | null = null;
  private listeners: Set<(config: SourceConfig) => void> = new Set();

  /** Load from storage (always re-reads; other contexts may have written) */
  async load(): Promise<SourceConfig> {
    const stored = await storage.get<SourceConfig | null>(STORAGE_KEYS.SOURCE_CONFIG, null);
    if (stored) {
      this.config = {
        order: Array.isArray(stored.order) ? stored.order : [],
        disabled: Array.isArray(stored.disabled) ? stored.disabled : [],
        overrides: stored.overrides ?? {},
      };
    } else {
      // First run: honor the legacy defaultSource setting by hoisting it to
      // the top. Not persisted until the user actually changes something.
      const settings = await storage.get<GlobalSettings>(STORAGE_KEYS.GLOBAL_SETTINGS, DEFAULT_SETTINGS);
      this.config = {
        order: settings.defaultSource ? [settings.defaultSource] : [],
        disabled: [],
        overrides: {},
      };
    }
    return this.get();
  }

  get(): SourceConfig {
    if (!this.config) {
      throw new Error('Source config not loaded. Call load() first.');
    }
    return {
      order: [...this.config.order],
      disabled: [...this.config.disabled],
      overrides: { ...(this.config.overrides ?? {}) },
    };
  }

  /** Set (or clear, with null) a built-in source's custom domain. */
  async setBaseUrlOverride(sourceId: string, baseUrl: string | null): Promise<SourceConfig> {
    await this.load();
    const overrides = { ...(this.config!.overrides ?? {}) };
    if (baseUrl) {
      overrides[sourceId] = { baseUrl };
    } else {
      delete overrides[sourceId];
    }
    this.config = { ...this.config!, overrides };
    await this.save();
    return this.get();
  }

  async setOrder(order: string[]): Promise<SourceConfig> {
    await this.load();
    this.config = { ...this.config!, order: [...order] };
    await this.save();
    return this.get();
  }

  async setEnabled(sourceId: string, enabled: boolean): Promise<SourceConfig> {
    await this.load();
    const disabled = new Set(this.config!.disabled);
    if (enabled) {
      disabled.delete(sourceId);
    } else {
      disabled.add(sourceId);
    }
    this.config = { ...this.config!, disabled: Array.from(disabled) };
    await this.save();
    return this.get();
  }

  subscribe(listener: (config: SourceConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async save(): Promise<void> {
    await storage.set(STORAGE_KEYS.SOURCE_CONFIG, this.config);
    for (const listener of this.listeners) {
      listener(this.get());
    }
  }
}

export const sourceConfigManager = new SourceConfigManager();
