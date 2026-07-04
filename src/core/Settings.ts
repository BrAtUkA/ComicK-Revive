import { GlobalSettings, DEFAULT_SETTINGS } from '@/types';
import { storage, STORAGE_KEYS } from './Storage';

/**
 * SettingsManager - Manages global user preferences
 */
export class SettingsManager {
  private settings: GlobalSettings | null = null;
  private listeners: Set<(settings: GlobalSettings) => void> = new Set();

  /**
   * Load settings from storage.
   * Always re-reads storage: settings can be changed from another context
   * (dashboard, popup) while this one keeps its module-level singleton alive,
   * so serving the in-memory copy here would hand out stale values. The
   * in-memory cache exists only so get() can stay synchronous.
   */
  async load(): Promise<GlobalSettings> {
    this.settings = await storage.get<GlobalSettings>(
      STORAGE_KEYS.GLOBAL_SETTINGS,
      DEFAULT_SETTINGS
    );

    // Merge with defaults to handle new settings added in updates
    this.settings = { ...DEFAULT_SETTINGS, ...this.settings };

    // Migration: old scrollSpeed was 0.001–0.1, new is 1–10. Reset old values.
    if (this.settings.scrollSpeed < 1) {
      this.settings.scrollSpeed = DEFAULT_SETTINGS.scrollSpeed;
      await storage.set(STORAGE_KEYS.GLOBAL_SETTINGS, this.settings);
    }

    return { ...this.settings };
  }

  /**
   * Get current settings (must call load() first)
   */
  get(): GlobalSettings {
    if (!this.settings) {
      throw new Error('Settings not loaded. Call load() first.');
    }
    return { ...this.settings };
  }

  /**
   * Update settings
   */
  async update(partial: Partial<GlobalSettings>): Promise<GlobalSettings> {
    await this.load(); // Ensure loaded

    this.settings = { ...this.settings!, ...partial };
    await storage.set(STORAGE_KEYS.GLOBAL_SETTINGS, this.settings);

    // Notify listeners
    this.notifyListeners();

    return this.settings;
  }

  /**
   * Reset to defaults
   */
  async reset(): Promise<GlobalSettings> {
    this.settings = { ...DEFAULT_SETTINGS };
    await storage.set(STORAGE_KEYS.GLOBAL_SETTINGS, this.settings);
    this.notifyListeners();
    return this.settings;
  }

  /**
   * Save the provided settings (replaces current settings)
   */
  async save(newSettings: GlobalSettings): Promise<GlobalSettings> {
    this.settings = { ...newSettings };
    await storage.set(STORAGE_KEYS.GLOBAL_SETTINGS, this.settings);
    this.notifyListeners();
    return this.settings;
  }

  /**
   * Subscribe to settings changes
   */
  subscribe(listener: (settings: GlobalSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    if (this.settings) {
      for (const listener of this.listeners) {
        listener(this.settings);
      }
    }
  }

  /**
   * Export settings as JSON string
   */
  async export(): Promise<string> {
    await this.load();
    return JSON.stringify(this.settings, null, 2);
  }

  /**
   * Import settings from JSON string
   */
  async import(jsonString: string): Promise<GlobalSettings> {
    try {
      const imported = JSON.parse(jsonString) as Partial<GlobalSettings>;
      return await this.update(imported);
    } catch (error) {
      throw new Error('Invalid settings JSON');
    }
  }
}

// Singleton instance
export const settingsManager = new SettingsManager();
