import { MangaSourceMapping, SourceInfo } from '@/types';
import { storage, STORAGE_KEYS } from './Storage';

/**
 * SourceMappingManager - Manages manga to source mappings
 * 
 * When a user links a ComicK manga to a source (e.g., AsuraScans),
 * we save that mapping so we know where to fetch content from.
 */
export class SourceMappingManager {
  private cache: Map<string, MangaSourceMapping> = new Map();

  /**
   * Get storage key for a manga
   */
  private getKey(comickSlug: string): string {
    return `${STORAGE_KEYS.SOURCE_MAPPING_PREFIX}${comickSlug}`;
  }

  /**
   * Get source mapping for a manga
   */
  async get(comickSlug: string): Promise<MangaSourceMapping | null> {
    // Check cache first
    if (this.cache.has(comickSlug)) {
      return this.cache.get(comickSlug)!;
    }

    const key = this.getKey(comickSlug);
    const exists = await storage.exists(key);
    
    if (!exists) {
      return null;
    }

    const mapping = await storage.get<MangaSourceMapping>(key, null as unknown as MangaSourceMapping);

    if (mapping) {
      // Migrate: placeholderWidth/Height used to be on the mapping, now on SourceInfo
      const legacy = mapping as MangaSourceMapping & { placeholderWidth?: number; placeholderHeight?: number };
      if (legacy.placeholderWidth && legacy.placeholderHeight) {
        // Try selected source first, fall back to first available source
        const target = mapping.sources[mapping.selectedSource]
          || Object.values(mapping.sources)[0];
        if (target && !target.placeholderWidth) {
          target.placeholderWidth = legacy.placeholderWidth;
          target.placeholderHeight = legacy.placeholderHeight;
        }
        delete legacy.placeholderWidth;
        delete legacy.placeholderHeight;
        await this.save(comickSlug, mapping);
      }

      this.cache.set(comickSlug, mapping);
    }
    
    return mapping;
  }

  /**
   * Check if manga has a source mapping
   */
  async hasMapping(comickSlug: string): Promise<boolean> {
    return await storage.exists(this.getKey(comickSlug));
  }

  /**
   * Create or update source mapping
   */
  async save(comickSlug: string, mapping: MangaSourceMapping): Promise<void> {
    const key = this.getKey(comickSlug);
    await storage.set(key, mapping);
    this.cache.set(comickSlug, mapping);
  }

  /**
   * Add or update a source for a manga
   */
  async setSource(
    comickSlug: string,
    comickTitle: string,
    sourceId: string,
    sourceInfo: SourceInfo,
    setAsSelected: boolean = true
  ): Promise<MangaSourceMapping> {
    let mapping = await this.get(comickSlug);

    if (!mapping) {
      mapping = {
        comickSlug,
        comickTitle,
        selectedSource: sourceId,
        sources: {},
      };
    }

    mapping.sources[sourceId] = {
      ...sourceInfo,
      lastChecked: Date.now(),
    };

    if (setAsSelected) {
      mapping.selectedSource = sourceId;
    }

    await this.save(comickSlug, mapping);
    return mapping;
  }

  /**
   * Update source availability
   */
  async updateAvailability(
    comickSlug: string,
    sourceId: string,
    available: boolean
  ): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping || !mapping.sources[sourceId]) return;

    mapping.sources[sourceId].available = available;
    mapping.sources[sourceId].lastChecked = Date.now();

    await this.save(comickSlug, mapping);
  }

  /**
   * Change selected source for a manga
   */
  async setSelectedSource(comickSlug: string, sourceId: string): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return;

    mapping.selectedSource = sourceId;
    await this.save(comickSlug, mapping);
  }

  /**
   * Get the selected source info for a manga
   */
  async getSelectedSource(comickSlug: string): Promise<{
    sourceId: string;
    sourceInfo: SourceInfo;
  } | null> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return null;

    const sourceInfo = mapping.sources[mapping.selectedSource];
    if (!sourceInfo) return null;

    return {
      sourceId: mapping.selectedSource,
      sourceInfo,
    };
  }

  /**
   * Remove a source mapping
   */
  async remove(comickSlug: string): Promise<void> {
    await storage.remove(this.getKey(comickSlug));
    this.cache.delete(comickSlug);
  }

  /**
   * Remove all source mappings
   */
  async removeAll(): Promise<void> {
    await storage.removeByPrefix(STORAGE_KEYS.SOURCE_MAPPING_PREFIX);
    this.cache.clear();
  }

  /**
   * Get all mappings
   */
  async getAll(): Promise<MangaSourceMapping[]> {
    const all = await storage.getByPrefix<MangaSourceMapping>(
      STORAGE_KEYS.SOURCE_MAPPING_PREFIX
    );
    return Object.values(all);
  }

  /**
   * Update slug for a source (when AsuraScans slug changes)
   */
  async updateSourceSlug(
    comickSlug: string,
    sourceId: string,
    newSlug: string
  ): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping || !mapping.sources[sourceId]) return;

    mapping.sources[sourceId].slug = newSlug;
    // Update base slug too
    mapping.sources[sourceId].baseSlug = newSlug.replace(/-\d+$/, '');

    await this.save(comickSlug, mapping);
  }

  /**
   * Set custom title for a manga
   */
  async setCustomTitle(comickSlug: string, customTitle: string | null): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return;

    if (customTitle && customTitle.trim()) {
      mapping.customTitle = customTitle.trim();
    } else {
      delete mapping.customTitle;
    }

    await this.save(comickSlug, mapping);
  }

  /**
   * Set alternate titles for a manga (from ComicK)
   */
  async setAlternateTitles(comickSlug: string, titles: string[]): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return;
    mapping.alternateTitles = titles;
    await this.save(comickSlug, mapping);
  }

  /**
   * Set placeholder dimensions for a source+manga (write-once from page 3 of first chapter)
   */
  async setPlaceholderDimensions(comickSlug: string, sourceId: string, width: number, height: number, force: boolean = false): Promise<void> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return;
    const source = mapping.sources[sourceId];
    if (!source || (!force && source.placeholderWidth)) return; // Write-once unless forced (e.g. refetch)
    source.placeholderWidth = width;
    source.placeholderHeight = height;
    await this.save(comickSlug, mapping);
  }

  /**
   * Get display title (custom or original)
   */
  async getDisplayTitle(comickSlug: string): Promise<string | null> {
    const mapping = await this.get(comickSlug);
    if (!mapping) return null;
    return mapping.customTitle || mapping.comickTitle;
  }
}

// Singleton instance
export const sourceMappingManager = new SourceMappingManager();
