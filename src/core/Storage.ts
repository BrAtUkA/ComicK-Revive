/**
 * Storage - Chrome storage wrapper with type safety
 * 
 * Provides async/await interface for chrome.storage.local
 * with proper typing and default values.
 * 
 * Automatically detects if running in page context (viewer) vs extension context
 * and uses the appropriate method (bridge vs direct chrome API).
 */

import { bridgeStorage } from '@/utils/bridge';

type StorageArea = 'local' | 'sync';

/**
 * Check if we're running in extension context (have access to chrome.storage)
 */
function isExtensionContext(): boolean {
  try {
    return typeof chrome !== 'undefined' && 
           typeof chrome.storage !== 'undefined' && 
           typeof chrome.storage.local !== 'undefined';
  } catch {
    return false;
  }
}

export class Storage {
  private area: StorageArea;
  private usesBridge: boolean;

  constructor(area: StorageArea = 'local') {
    this.area = area;
    this.usesBridge = !isExtensionContext();
    
    if (this.usesBridge) {
      console.log('[Storage] Using bridge mode (page context)');
    }
  }

  private get storage(): chrome.storage.StorageArea {
    return this.area === 'sync' ? chrome.storage.sync : chrome.storage.local;
  }

  /**
   * Get a value from storage
   */
  async get<T>(key: string, defaultValue: T): Promise<T> {
    try {
      if (this.usesBridge) {
        return await bridgeStorage.get<T>(key, defaultValue);
      }
      
      const result = await this.storage.get(key);
      if (result[key] === undefined) {
        return defaultValue;
      }
      return result[key] as T;
    } catch (error) {
      console.error(`[Storage] Error getting ${key}:`, error);
      return defaultValue;
    }
  }

  /**
   * Set a value in storage
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      if (this.usesBridge) {
        await bridgeStorage.set(key, value);
        return;
      }
      
      await this.storage.set({ [key]: value });
    } catch (error) {
      console.error(`[Storage] Error setting ${key}:`, error);
      throw error;
    }
  }

  /**
   * Remove a value from storage
   */
  async remove(key: string): Promise<void> {
    try {
      if (this.usesBridge) {
        await bridgeStorage.remove(key);
        return;
      }
      
      await this.storage.remove(key);
    } catch (error) {
      console.error(`[Storage] Error removing ${key}:`, error);
      throw error;
    }
  }

  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    try {
      if (this.usesBridge) {
        // Bridge doesn't support clear, skip
        console.warn('[Storage] Clear not supported in bridge mode');
        return;
      }
      
      await this.storage.clear();
    } catch (error) {
      console.error('[Storage] Error clearing:', error);
      throw error;
    }
  }

  /**
   * Get all keys matching a prefix
   */
  async getByPrefix<T>(prefix: string): Promise<Record<string, T>> {
    try {
      let all: Record<string, any>;
      
      if (this.usesBridge) {
        all = await bridgeStorage.getAll();
      } else {
        all = await this.storage.get(null);
      }
      
      const result: Record<string, T> = {};
      
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) {
          result[key] = all[key] as T;
        }
      }
      
      return result;
    } catch (error) {
      console.error(`[Storage] Error getting prefix ${prefix}:`, error);
      return {};
    }
  }

  /**
   * Remove all keys matching a prefix
   */
  async removeByPrefix(prefix: string): Promise<void> {
    try {
      if (this.usesBridge) {
        const all = await bridgeStorage.getAll();
        for (const key of Object.keys(all)) {
          if (key.startsWith(prefix)) {
            await bridgeStorage.remove(key);
          }
        }
        return;
      }
      
      const all = await this.storage.get(null);
      const keysToRemove = Object.keys(all).filter(key => key.startsWith(prefix));
      
      if (keysToRemove.length > 0) {
        await this.storage.remove(keysToRemove);
      }
    } catch (error) {
      console.error(`[Storage] Error removing prefix ${prefix}:`, error);
      throw error;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      if (this.usesBridge) {
        const value = await bridgeStorage.get(key, undefined);
        return value !== undefined;
      }
      
      const result = await this.storage.get(key);
      return result[key] !== undefined;
    } catch (error) {
      console.error(`[Storage] Error checking ${key}:`, error);
      return false;
    }
  }

  /**
   * Get storage usage info
   */
  async getUsage(): Promise<{ bytesInUse: number; quota?: number }> {
    try {
      if (this.usesBridge) {
        // Not supported in bridge mode
        return { bytesInUse: 0 };
      }
      
      const bytesInUse = await this.storage.getBytesInUse(null);
      return {
        bytesInUse,
        quota: this.area === 'sync' ? chrome.storage.sync.QUOTA_BYTES : undefined,
      };
    } catch (error) {
      console.error('[Storage] Error getting usage:', error);
      return { bytesInUse: 0 };
    }
  }
}

// Default storage instance
export const storage = new Storage('local');

// Storage keys constants
export const STORAGE_KEYS = {
  GLOBAL_SETTINGS: 'global_settings',
  SOURCE_MAPPING_PREFIX: 'source_mapping_',
  READING_STATE_PREFIX: 'reading_state_',
  STATS_DAILY_PREFIX: 'stats_daily_',
  STATS_TOTALS: 'stats_totals',
  SOURCE_CONFIG: 'source_config',
  SOURCE_CATALOG: 'source_catalog',
  USER_SOURCE_PREFIX: 'user_source_',
  LIBRARY_META: 'library_meta',
  READING_HISTORY: 'reading_history',
} as const;
