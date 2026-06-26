import { MangaSourceMapping, MangaReadingState, SourceInfo, GlobalSettings, DEFAULT_SETTINGS, EvictionUnit, EvictionPriority } from '@/types';
import {
  bridgeCacheDetailedStats,
  bridgeSourceDataDetailedStats,
  bridgeCacheClear,
  bridgeCacheClearManga,
  bridgeCacheClearChapter,
  bridgeSourceDataClearAll,
  bridgeSourceDataClearManga,
  bridgeSourceDataClearChapterPages,
  bridgeFetchImageCached,
  bridgeCacheGet,
  bridgeCacheUpdateSettings,
} from '@/utils/bridge';
import { bridgeStorage } from '@/utils/bridge';
import { readingStateManager, sourceMappingManager, settingsManager } from '@/core';
import { setupBackdropClose } from '@/utils/backdrop-close';
import { sourceRegistry } from '@/sources';
import { showAltTitlesPopup } from './alt-titles-popup';
import { formatBytes, formatMB } from '@/utils/format';
import { showToast } from './Toast';

// ─── Data Model ───────────────────────────────────────────────────────────────

interface ImageCacheData {
  imageCount: number;
  totalSize: number;
  chapters: Array<{
    chapterSlug: string;
    imageCount: number;
    totalSize: number;
    oldestTimestamp: number;
    newestTimestamp: number;
  }>;
}

interface SourceDataCacheData {
  hasChapterList: boolean;
  chapterListTimestamp: number | null;
  chapterListCount: number;
  cachedChapterPages: Array<{
    chapterSlug: string;
    pageCount: number;
    timestamp: number;
  }>;
  hasMangaDetails: boolean;
  mangaDetailsTimestamp: number | null;
}

interface MappingData {
  comickSlug: string;
  comickTitle: string;
  customTitle?: string;
  selectedSource: string;
  sources: Record<string, SourceInfo>;
}

interface ReadingStateData {
  currentChapter: number;
  lastRead: number;
  readChapters: number[];
  readingMode: string;
  imageFit: string;
  chapterPositionsCount: number;
}

interface MangaDataRecord {
  key: string;
  comickSlug: string | null;
  sourceId: string;
  mangaSlug: string;
  displayTitle: string;
  sourceName: string;
  alternateTitles: string[];
  imageCache: ImageCacheData | null;
  sourceData: SourceDataCacheData | null;
  mapping: MappingData | null;
  readingState: ReadingStateData | null;
}

interface MappingRowData {
  record: MangaDataRecord;
  allSourceIds: string[];
  allSourceNames: string[];
}

type ImageSortMode = 'size-desc' | 'size-asc' | 'name-asc' | 'recent';
type SourceDataSortMode = 'sd-name-asc' | 'sd-chapters-desc' | 'sd-chapters-asc' | 'sd-pages-desc' | 'sd-recent';
type MappingsSortMode = 'map-name-asc' | 'map-recent-read' | 'map-chapters-read' | 'map-current-chapter';

// ─── Component ────────────────────────────────────────────────────────────────

export class CacheManager {
  private container: HTMLElement | null = null;
  private isOpen = false;
  private records: MangaDataRecord[] = [];
  private filteredRecords: MangaDataRecord[] = [];
  private coverCache = new Map<string, string>();
  private observer: IntersectionObserver | null = null;
  private expandedRows = new Set<string>();
  private onClose?: () => void;
  private activeTab = 'overview';
  private searchQuery = '';
  private sourceFilter = '';
  private imageSortMode: ImageSortMode = 'size-desc';
  private sourceDataSortMode: SourceDataSortMode = 'sd-recent';
  private mappingsSortMode: MappingsSortMode = 'map-recent-read';
  private cachedSettings: GlobalSettings | null = null;

  // Cover loading concurrency
  private coverQueue: Array<() => Promise<void>> = [];
  private activeCoverLoads = 0;
  private readonly MAX_CONCURRENT_COVERS = 3;

  // Persistent thumbnail URL cache (sourceId:slug → thumbnailUrl)
  private thumbnailUrlCache = new Map<string, string>();
  private thumbnailUrlSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Aggregate stats
  private totalSize = 0;
  private totalEntries = 0;
  private maxSizeMB = 500;
  private chapterListCount = 0;
  private chapterPagesCount = 0;
  private mangaDetailsCount = 0;
  private sourceDataBytes = 0;
  private chapterListBytes = 0;
  private chapterPagesBytes = 0;
  private mangaDetailsBytes = 0;
  private sourceMappingsCount = 0;
  private readingStatesCount = 0;
  private altTitlesCount = 0;
  private altTitlesMangaCount = 0;
  private altTitlesBytes = 0;
  private userDataBytes = 0;
  private sourceMappingsBytes = 0;
  private readingStatesBytes = 0;

  async show(onClose?: () => void): Promise<void> {
    if (this.isOpen) {
      this.hide();
      return;
    }

    this.onClose = onClose;
    this.isOpen = true;

    // Clear failed cover entries so they retry (keep successful ones for instant display)
    for (const [key, value] of this.coverCache) {
      if (!value) this.coverCache.delete(key);
    }

    this.createOverlay();
    this.showLoading();

    try {
      await Promise.all([this.loadAllData(), this.loadThumbnailUrls()]);
      this.renderContent();
      this.setupEventListeners();
      this.setupLazyLoading();
    } catch (error) {
      console.error('[CacheManager] Failed to load data:', error);
      this.showError();
    }
  }

  hide(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.coverQueue = [];
    this.activeCoverLoads = 0;
    this.container?.remove();
    this.container = null;
    this.isOpen = false;
    this.expandedRows.clear();
    this.searchQuery = '';
    this.sourceFilter = '';
    this.activeTab = 'overview';
    this.cachedSettings = null;
    this.onClose?.();
  }

  // ─── Overlay & Chrome ──────────────────────────────────────────────────────

  private createOverlay(): void {
    document.getElementById('cr-cache-manager')?.remove();

    this.container = document.createElement('div');
    this.container.id = 'cr-cache-manager';
    this.container.className = 'cr-cm-overlay';
    this.container.innerHTML = `
      <div class="cr-cm-modal">
        <div class="cr-cm-header">
          <h3>Storage Manager</h3>
          <button class="cr-cm-close" id="cr-cm-close">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
        <div class="cr-cm-tabs" id="cr-cm-tabs"></div>
        <div class="cr-cm-body" id="cr-cm-body"></div>
      </div>
    `;

    document.body.appendChild(this.container);

    document.getElementById('cr-cm-close')?.addEventListener('click', () => this.hide());

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        document.removeEventListener('keydown', handleEsc, true);
        this.hide();
      }
    };
    document.addEventListener('keydown', handleEsc, true);
  }

  private showLoading(): void {
    const body = document.getElementById('cr-cm-body');
    if (!body) return;
    body.innerHTML = `
      <div class="cr-cm-loading">
        <div class="cr-cm-loading-spinner"></div>
        <span>Loading storage data...</span>
      </div>
    `;
  }

  private showError(): void {
    const body = document.getElementById('cr-cm-body');
    if (!body) return;
    body.innerHTML = `
      <div class="cr-cm-empty">
        <div class="cr-cm-empty-title">Failed to load data</div>
        <div class="cr-cm-empty-desc">Try closing and reopening this panel.</div>
      </div>
    `;
  }

  // ─── Data Loading & Merging ────────────────────────────────────────────────

  private async loadAllData(): Promise<void> {
    const [imageStats, sourceDataStats, sourceMappings, readingStates, settings] = await Promise.all([
      bridgeCacheDetailedStats(),
      bridgeSourceDataDetailedStats(),
      sourceMappingManager.getAll(),
      readingStateManager.getAllWithProgress(),
      settingsManager.load(),
    ]);

    this.cachedSettings = { ...settings };

    this.totalSize = imageStats.totalSize;
    this.totalEntries = imageStats.totalEntries;
    this.maxSizeMB = imageStats.maxSizeMB;
    this.chapterListCount = sourceDataStats.chapterListCount;
    this.chapterPagesCount = sourceDataStats.chapterPagesCount;
    this.mangaDetailsCount = sourceDataStats.mangaDetailsCount;
    this.sourceDataBytes = sourceDataStats.totalBytes;
    this.chapterListBytes = sourceDataStats.chapterListBytes;
    this.chapterPagesBytes = sourceDataStats.chapterPagesBytes;
    this.mangaDetailsBytes = sourceDataStats.mangaDetailsBytes;
    this.sourceMappingsCount = sourceMappings.reduce((sum, m) => sum + Object.keys(m.sources).length, 0);
    this.readingStatesCount = readingStates.length;
    this.altTitlesCount = sourceMappings.reduce((sum, m) => sum + (m.alternateTitles?.length || 0), 0);
    this.altTitlesMangaCount = sourceMappings.filter(m => m.alternateTitles?.length).length;
    this.altTitlesBytes = sourceMappings.reduce((sum, m) => sum + (m.alternateTitles || []).reduce((s, t) => s + t.length * 2, 0), 0);
    this.sourceMappingsBytes = JSON.stringify(sourceMappings).length * 2;
    this.readingStatesBytes = JSON.stringify(readingStates).length * 2;
    this.userDataBytes = this.sourceMappingsBytes + this.readingStatesBytes;

    this.records = this.mergeData(imageStats, sourceDataStats, sourceMappings, readingStates);
    this.filteredRecords = [...this.records];
  }

  private mergeData(
    imageStats: Awaited<ReturnType<typeof bridgeCacheDetailedStats>>,
    sourceDataStats: Awaited<ReturnType<typeof bridgeSourceDataDetailedStats>>,
    sourceMappings: MangaSourceMapping[],
    readingStates: Array<{ slug: string; state: MangaReadingState }>
  ): MangaDataRecord[] {
    const recordMap = new Map<string, MangaDataRecord>();
    const seenKeys = new Set<string>();

    // Build lookups
    const readingStateMap = new Map<string, MangaReadingState>();
    for (const { slug, state } of readingStates) {
      readingStateMap.set(slug, state);
    }

    const imageCacheMap = new Map<string, (typeof imageStats.manga)[0]>();
    for (const m of imageStats.manga) {
      imageCacheMap.set(`${m.sourceId}:${m.mangaSlug}`, m);
    }

    const sourceDataMap = new Map<string, (typeof sourceDataStats.manga)[0]>();
    for (const m of sourceDataStats.manga) {
      sourceDataMap.set(`${m.sourceId}:${m.mangaSlug}`, m);
    }

    const buildReadingState = (rs: MangaReadingState): ReadingStateData => {
      let posCount = 0;
      for (const srcPositions of Object.values(rs.chapterPositions || {})) {
        posCount += Object.keys(srcPositions).length;
      }
      return {
        currentChapter: rs.currentChapter,
        lastRead: rs.lastRead,
        readChapters: rs.readChapters || [],
        readingMode: rs.readingMode,
        imageFit: rs.imageFit,
        chapterPositionsCount: posCount,
      };
    };

    const buildImageCache = (img: (typeof imageStats.manga)[0]): ImageCacheData => ({
      imageCount: img.imageCount,
      totalSize: img.totalSize,
      chapters: img.chapters,
    });

    const buildSourceData = (sd: (typeof sourceDataStats.manga)[0]): SourceDataCacheData => ({
      hasChapterList: sd.hasChapterList,
      chapterListTimestamp: sd.chapterListTimestamp,
      chapterListCount: sd.chapterListCount,
      cachedChapterPages: sd.cachedChapterPages,
      hasMangaDetails: sd.hasMangaDetails,
      mangaDetailsTimestamp: sd.mangaDetailsTimestamp,
    });

    // Pass 1: Source mappings (primary identity)
    for (const mapping of sourceMappings) {
      const rs = readingStateMap.get(mapping.comickSlug) || null;
      const readingState = rs ? buildReadingState(rs) : null;

      for (const [sourceId, sourceInfo] of Object.entries(mapping.sources)) {
        const sourceKey = `${sourceId}:${sourceInfo.slug}`;
        seenKeys.add(sourceKey);

        const imgCache = imageCacheMap.get(sourceKey);
        const srcData = sourceDataMap.get(sourceKey);
        const source = sourceRegistry.get(sourceId);

        const record: MangaDataRecord = {
          key: sourceKey,
          comickSlug: mapping.comickSlug,
          sourceId,
          mangaSlug: sourceInfo.slug,
          displayTitle: mapping.customTitle || mapping.comickTitle || sourceInfo.title || sourceInfo.slug,
          sourceName: source?.name || sourceId,
          alternateTitles: mapping.alternateTitles || [],
          imageCache: imgCache ? buildImageCache(imgCache) : null,
          sourceData: srcData ? buildSourceData(srcData) : null,
          mapping: {
            comickSlug: mapping.comickSlug,
            comickTitle: mapping.comickTitle,
            customTitle: mapping.customTitle,
            selectedSource: mapping.selectedSource,
            sources: mapping.sources,
          },
          readingState,
        };

        recordMap.set(sourceKey, record);
      }
    }

    // Pass 2: Orphaned image cache entries
    for (const m of imageStats.manga) {
      const key = `${m.sourceId}:${m.mangaSlug}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const srcData = sourceDataMap.get(key);
      const source = sourceRegistry.get(m.sourceId);

      recordMap.set(key, {
        key,
        comickSlug: null,
        sourceId: m.sourceId,
        mangaSlug: m.mangaSlug,
        displayTitle: m.mangaSlug,
        sourceName: source?.name || m.sourceId,
        alternateTitles: [],
        imageCache: buildImageCache(m),
        sourceData: srcData ? buildSourceData(srcData) : null,
        mapping: null,
        readingState: null,
      });
    }

    // Pass 3: Orphaned source data cache entries
    for (const m of sourceDataStats.manga) {
      const key = `${m.sourceId}:${m.mangaSlug}`;
      if (seenKeys.has(key)) continue;

      const source = sourceRegistry.get(m.sourceId);

      recordMap.set(key, {
        key,
        comickSlug: null,
        sourceId: m.sourceId,
        mangaSlug: m.mangaSlug,
        displayTitle: m.mangaSlug,
        sourceName: source?.name || m.sourceId,
        alternateTitles: [],
        imageCache: null,
        sourceData: buildSourceData(m),
        mapping: null,
        readingState: null,
      });
    }

    // Pass 4: Reading states with mappings but no cache data (for mappings tab)
    for (const mapping of sourceMappings) {
      // Check if at least one source entry was already added
      const hasEntry = Object.entries(mapping.sources).some(([sid, si]) =>
        recordMap.has(`${sid}:${si.slug}`)
      );
      if (hasEntry) continue;

      // No cache data at all — create a minimal record for mapping/state display
      const firstSource = Object.entries(mapping.sources)[0];
      if (!firstSource) continue;

      const [sourceId, sourceInfo] = firstSource;
      const sourceKey = `${sourceId}:${sourceInfo.slug}`;
      const rs = readingStateMap.get(mapping.comickSlug) || null;
      const source = sourceRegistry.get(sourceId);

      recordMap.set(sourceKey, {
        key: sourceKey,
        comickSlug: mapping.comickSlug,
        sourceId,
        mangaSlug: sourceInfo.slug,
        displayTitle: mapping.customTitle || mapping.comickTitle || sourceInfo.title || sourceInfo.slug,
        sourceName: source?.name || sourceId,
        alternateTitles: mapping.alternateTitles || [],
        imageCache: null,
        sourceData: null,
        mapping: {
          comickSlug: mapping.comickSlug,
          comickTitle: mapping.comickTitle,
          customTitle: mapping.customTitle,
          selectedSource: mapping.selectedSource,
          sources: mapping.sources,
        },
        readingState: rs ? buildReadingState(rs) : null,
      });
    }

    return Array.from(recordMap.values());
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  private renderContent(): void {
    this.renderTabs();

    const body = document.getElementById('cr-cm-body');
    if (!body) return;

    body.innerHTML = `
      <div class="cr-cm-panel" id="cr-cm-panel-overview">${this.renderOverviewPanel()}</div>
      <div class="cr-cm-panel cr-cm-panel-hidden" id="cr-cm-panel-images">${this.renderImagesPanel()}</div>
      <div class="cr-cm-panel cr-cm-panel-hidden" id="cr-cm-panel-source-data">${this.renderSourceDataPanel()}</div>
      <div class="cr-cm-panel cr-cm-panel-hidden" id="cr-cm-panel-mappings">${this.renderMappingsPanel()}</div>
      <div class="cr-cm-panel cr-cm-panel-hidden" id="cr-cm-panel-settings">${this.renderSettingsPanel()}</div>
    `;
  }

  private renderTabs(): void {
    const tabBar = document.getElementById('cr-cm-tabs');
    if (!tabBar) return;

    const imageCount = this.getImageRecords().length;
    const sourceDataCount = this.getSourceDataRecords().length;
    const mappingsCount = this.deduplicateMappingsRecords(this.getMappingsRecords()).length;

    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'images', label: 'Images', count: imageCount },
      { id: 'source-data', label: 'Source Data', count: sourceDataCount },
      { id: 'mappings', label: 'Mappings', count: mappingsCount },
      { id: 'settings', label: 'Settings' },
    ];
    tabBar.innerHTML = tabs.map(t =>
      `<button class="cr-cm-tab${t.id === this.activeTab ? ' cr-cm-tab-active' : ''}" data-tab="${t.id}">${t.label}${t.count !== undefined ? `<span class="cr-cm-tab-count">${t.count}</span>` : ''}</button>`
    ).join('');
  }

  private switchTab(tabId: string): void {
    this.activeTab = tabId;
    this.searchQuery = '';
    this.sourceFilter = '';
    this.applyFilter();
    this.container?.querySelectorAll('.cr-cm-tab').forEach(btn => {
      btn.classList.toggle('cr-cm-tab-active', (btn as HTMLElement).dataset.tab === tabId);
    });
    this.container?.querySelectorAll('.cr-cm-panel').forEach(panel => {
      panel.classList.toggle('cr-cm-panel-hidden', panel.id !== `cr-cm-panel-${tabId}`);
    });
    this.rerenderActiveTab();
    this.setupLazyLoading();
  }

  // ─── Tab Filters ───────────────────────────────────────────────────────────

  private getImageRecords(): MangaDataRecord[] {
    return this.filteredRecords.filter(r => r.imageCache !== null);
  }

  private getSourceDataRecords(): MangaDataRecord[] {
    return this.filteredRecords.filter(r => r.sourceData !== null);
  }

  private getMappingsRecords(): MangaDataRecord[] {
    return this.filteredRecords.filter(r => r.mapping !== null || r.readingState !== null);
  }

  private getSortedImageRecords(): MangaDataRecord[] {
    const records = this.getImageRecords();
    switch (this.imageSortMode) {
      case 'size-asc':
        return records.sort((a, b) => (a.imageCache?.totalSize || 0) - (b.imageCache?.totalSize || 0));
      case 'name-asc':
        return records.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
      case 'recent':
        return records.sort((a, b) => {
          const aMax = Math.max(...(a.imageCache?.chapters.map(c => c.newestTimestamp) || [0]));
          const bMax = Math.max(...(b.imageCache?.chapters.map(c => c.newestTimestamp) || [0]));
          return bMax - aMax;
        });
      case 'size-desc':
      default:
        return records.sort((a, b) => (b.imageCache?.totalSize || 0) - (a.imageCache?.totalSize || 0));
    }
  }

  private getSortedSourceDataRecords(): MangaDataRecord[] {
    const records = this.getSourceDataRecords();
    switch (this.sourceDataSortMode) {
      case 'sd-chapters-desc':
        return records.sort((a, b) => (b.sourceData?.chapterListCount || 0) - (a.sourceData?.chapterListCount || 0));
      case 'sd-chapters-asc':
        return records.sort((a, b) => (a.sourceData?.chapterListCount || 0) - (b.sourceData?.chapterListCount || 0));
      case 'sd-pages-desc':
        return records.sort((a, b) => (b.sourceData?.cachedChapterPages.length || 0) - (a.sourceData?.cachedChapterPages.length || 0));
      case 'sd-recent': {
        const getNewest = (r: MangaDataRecord): number => {
          const sd = r.sourceData!;
          const ts: number[] = [];
          if (sd.chapterListTimestamp) ts.push(sd.chapterListTimestamp);
          if (sd.mangaDetailsTimestamp) ts.push(sd.mangaDetailsTimestamp);
          for (const cp of sd.cachedChapterPages) ts.push(cp.timestamp);
          return ts.length > 0 ? Math.max(...ts) : 0;
        };
        return records.sort((a, b) => getNewest(b) - getNewest(a));
      }
      case 'sd-name-asc':
      default:
        return records.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    }
  }

  private getSortedMappingsRecords(): MangaDataRecord[] {
    const records = this.getMappingsRecords();
    switch (this.mappingsSortMode) {
      case 'map-recent-read':
        return records.sort((a, b) => (b.readingState?.lastRead || 0) - (a.readingState?.lastRead || 0));
      case 'map-chapters-read':
        return records.sort((a, b) => (b.readingState?.readChapters.length || 0) - (a.readingState?.readChapters.length || 0));
      case 'map-current-chapter':
        return records.sort((a, b) => (b.readingState?.currentChapter || 0) - (a.readingState?.currentChapter || 0));
      case 'map-name-asc':
      default:
        return records.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle));
    }
  }

  /**
   * Deduplicate mapping records by comickSlug so each manga shows as one row.
   * Picks the selected source's record as representative, collects all source names for badges.
   */
  private deduplicateMappingsRecords(records: MangaDataRecord[]): MappingRowData[] {
    const groups = new Map<string, MangaDataRecord[]>();

    for (const r of records) {
      const groupKey = r.comickSlug || r.key;
      const group = groups.get(groupKey);
      if (group) {
        group.push(r);
      } else {
        groups.set(groupKey, [r]);
      }
    }

    const result: MappingRowData[] = [];
    for (const [, group] of groups) {
      const selectedSource = group[0].mapping?.selectedSource;
      const representative = group.find(r => r.sourceId === selectedSource) || group[0];

      // Collect all source IDs/names, selected source first
      const allSourceIds: string[] = [];
      const allSourceNames: string[] = [];
      if (representative.mapping) {
        const sids = Object.keys(representative.mapping.sources);
        // Put selected source first
        sids.sort((a, b) => (a === selectedSource ? -1 : b === selectedSource ? 1 : 0));
        for (const sid of sids) {
          allSourceIds.push(sid);
          allSourceNames.push(sourceRegistry.get(sid)?.name || sid);
        }
      } else {
        allSourceIds.push(representative.sourceId);
        allSourceNames.push(representative.sourceName);
      }

      result.push({ record: representative, allSourceIds, allSourceNames });
    }

    return result;
  }

  // ─── Overview Panel ────────────────────────────────────────────────────────

  private renderOverviewPanel(): string {
    const sizeText = formatBytes(this.totalSize);
    const totalSizeMB = this.totalSize / 1024 / 1024;
    const usagePercent = Math.min(100, (totalSizeMB / this.maxSizeMB) * 100);
    const warnClass = usagePercent > 80 ? ' cr-cm-usage-warn' : '';
    const heroWarnClass = usagePercent > 80 ? ' cr-cm-hero-warn' : '';
    const warnIcon = usagePercent > 80
      ? `<div class="cr-cm-hero-warn-wrap"><div class="cr-cm-hero-warn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div><div class="cr-cm-warn-tip">Clear unwanted manga to avoid automatic deletion of old entries, or increase <span class="cr-cm-warn-tip-link" data-action="go-settings">cache size</span>.</div></div>`
      : '';
    const imageMangaCount = this.records.filter(r => r.imageCache !== null).length;
    const sourceDataMangaCount = this.records.filter(r => r.sourceData !== null).length;

    const totalStorage = this.totalSize + this.sourceDataBytes + this.userDataBytes;

    return `
      <div class="cr-cm-hero-card${heroWarnClass}">
        ${warnIcon}
        <div class="cr-cm-hero-top">
          <div class="cr-cm-hero-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="16" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
          </div>
          <div class="cr-cm-hero-info">
            <div class="cr-cm-hero-size">${sizeText}</div>
            <div class="cr-cm-hero-sub">${this.totalEntries.toLocaleString()} images across ${imageMangaCount} manga</div>
          </div>
        </div>
        <div class="cr-cm-usage-bar">
          <div class="cr-cm-usage-fill${warnClass}" style="width: ${usagePercent}%"></div>
          <span class="cr-cm-usage-text">${usagePercent.toFixed(0)}% of ${formatMB(this.maxSizeMB)}</span>
        </div>
        <div class="cr-cm-hero-total">Remaining: ${formatBytes(Math.max(0, this.maxSizeMB * 1024 * 1024 - this.totalSize))}</div>
      </div>

      <div class="cr-cm-overview-section">
        <div class="cr-cm-overview-label">
          <span>Source Data Cache</span>
          <span class="cr-cm-label-meta">${sourceDataMangaCount} manga · ${formatBytes(this.sourceDataBytes)}</span>
        </div>
        <div class="cr-cm-stats-grid">
          <div class="cr-cm-stat-card" style="--stat-color: #4ade80;" data-tooltip="Cached chapter listings for each manga. Avoids re-fetching the full chapter list from the source every time you open a manga.">
            <div class="cr-cm-stat-value">${this.chapterListCount}</div>
            <div class="cr-cm-stat-label">Chapter Lists</div>
            <div class="cr-cm-stat-desc">Cached listings</div>
            <div class="cr-cm-stat-size">${formatBytes(this.chapterListBytes)}</div>
          </div>
          <div class="cr-cm-stat-card" style="--stat-color: #60a5fa;" data-tooltip="Cached image URLs for each chapter's pages. When you open a chapter, the page URLs are saved so they don't need to be fetched again.">
            <div class="cr-cm-stat-value">${this.chapterPagesCount}</div>
            <div class="cr-cm-stat-label">Page Caches</div>
            <div class="cr-cm-stat-desc">Chapter page URLs</div>
            <div class="cr-cm-stat-size">${formatBytes(this.chapterPagesBytes)}</div>
          </div>
          <div class="cr-cm-stat-card" style="--stat-color: #a855f7;" data-tooltip="Cached manga info like title, cover image, author, and status. Fetched once from the source and reused across sessions.">
            <div class="cr-cm-stat-value">${this.mangaDetailsCount}</div>
            <div class="cr-cm-stat-label">Manga Details</div>
            <div class="cr-cm-stat-desc">Info & metadata</div>
            <div class="cr-cm-stat-size">${formatBytes(this.mangaDetailsBytes)}</div>
          </div>
          <div class="cr-cm-stat-card" style="--stat-color: #fbbf24;" data-tooltip="Alternate titles from ComicK (Korean, Japanese, aliases). Used for richer search across the extension. Updated automatically when you open a manga.">
            <div class="cr-cm-stat-value">${this.altTitlesCount}</div>
            <div class="cr-cm-stat-label">Alt Titles</div>
            <div class="cr-cm-stat-desc">Across ${this.altTitlesMangaCount} manga</div>
            <div class="cr-cm-stat-size">${formatBytes(this.altTitlesBytes)}</div>
          </div>
        </div>
      </div>

      <div class="cr-cm-overview-section">
        <div class="cr-cm-overview-label">
          <span>User Data</span>
          <span class="cr-cm-label-meta">${formatBytes(this.userDataBytes)}</span>
        </div>
        <div class="cr-cm-stats-grid cr-cm-stats-grid-2">
          <div class="cr-cm-stat-card" style="--stat-color: #e06b9a;" data-tooltip="Links between ComicK manga and external sources. Created when you match a manga to a source like AsuraScans. Without these, you'd need to re-link every manga.">
            <div class="cr-cm-stat-value">${this.sourceMappingsCount}</div>
            <div class="cr-cm-stat-label">Source Mappings</div>
            <div class="cr-cm-stat-desc">Linked manga titles</div>
            <div class="cr-cm-stat-size">${formatBytes(this.sourceMappingsBytes)}</div>
          </div>
          <div class="cr-cm-stat-card" style="--stat-color: #e07b3c;" data-tooltip="Your reading progress for each manga — current chapter, scroll position, reading mode, and zoom level. Lets you pick up exactly where you left off.">
            <div class="cr-cm-stat-value">${this.readingStatesCount}</div>
            <div class="cr-cm-stat-label">Reading States</div>
            <div class="cr-cm-stat-desc">Saved progress</div>
            <div class="cr-cm-stat-size">${formatBytes(this.readingStatesBytes)}</div>
          </div>
        </div>
      </div>

      <div class="cr-cm-bulk-actions">
        <button class="cr-cm-bulk-btn cr-cm-bulk-danger" id="cr-cm-clear-all-images">Clear All Image Cache</button>
        <button class="cr-cm-bulk-btn cr-cm-bulk-danger" id="cr-cm-clear-all-source-data">Clear All Source Data</button>
      </div>
    `;
  }

  // ─── Settings Panel ────────────────────────────────────────────────────────

  private renderSettingsPanel(): string {
    const s = this.cachedSettings || DEFAULT_SETTINGS;
    const sizeMB = s.imageCacheMaxSizeMB;
    const sizeLabel = formatMB(sizeMB);

    const ttlOptions = [
      { value: 0, label: 'Never' },
      { value: 7, label: '7 days' },
      { value: 15, label: '15 days' },
      { value: 30, label: '30 days' },
      { value: 60, label: '60 days' },
      { value: 90, label: '90 days' },
    ];
    const ttlSelect = ttlOptions.map(o =>
      `<option value="${o.value}"${s.imageCacheTTLDays === o.value ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    const evictionUnitOptions = [
      { value: 'chapter', label: 'Per Chapter', desc: 'Remove entire chapters — balanced granularity' },
      { value: 'manga', label: 'Per Manga', desc: 'Remove entire manga at once — keeps chapters intact' },
      { value: 'image', label: 'Per Image', desc: 'Remove individual images — more granular, may leave partial chapters' },
    ];
    const evictionUnitSelect = evictionUnitOptions.map(o =>
      `<option value="${o.value}"${s.imageCacheEvictionUnit === o.value ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    const evictionPriorityOptions = [
      { value: 'lru', label: 'Least Recently Read' },
      { value: 'oldest', label: 'Oldest Cached' },
    ];
    const evictionPrioritySelect = evictionPriorityOptions.map(o =>
      `<option value="${o.value}"${s.imageCacheEvictionPriority === o.value ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    return `
      <div class="cr-cm-settings-section">
        <div class="cr-cm-settings-title">Image Cache</div>

        <div class="cr-setting-item">
          <div class="cr-setting-info">
            <label>Enable Image Cache</label>
            <span class="cr-setting-desc">Cache offline copies of manga pages</span>
          </div>
          <label class="cr-toggle">
            <input type="checkbox" id="cr-cm-set-enable"${s.enableImageCache ? ' checked' : ''}>
            <span class="cr-toggle-slider"></span>
          </label>
        </div>

        <div class="cr-setting-item cr-setting-item-stacked">
          <div class="cr-setting-item-top">
            <div class="cr-setting-info">
              <label>Cache Size Limit</label>
              <span class="cr-setting-desc">Maximum storage for cached images (256 MB – 10 GB)</span>
            </div>
            <span class="cr-cm-settings-value" id="cr-cm-set-size-val">${sizeLabel}</span>
          </div>
          <div class="cr-cm-slider-wrap">
            <input type="range" id="cr-cm-set-size" class="cr-setting-range" min="256" max="10240" step="256" value="${sizeMB}">
            <div class="cr-cm-slider-ticks">
              <span class="cr-cm-slider-tick" style="left:0%">256M</span>
              <span class="cr-cm-slider-tick" style="left:17.95%">2G</span>
              <span class="cr-cm-slider-tick" style="left:38.46%">4G</span>
              <span class="cr-cm-slider-tick" style="left:58.97%">6G</span>
              <span class="cr-cm-slider-tick" style="left:79.49%">8G</span>
              <span class="cr-cm-slider-tick" style="left:100%">10G</span>
            </div>
          </div>
        </div>

        <div class="cr-setting-item">
          <div class="cr-setting-info">
            <label>Cache Expiry</label>
            <span class="cr-setting-desc">Auto-remove images older than this</span>
          </div>
          <select id="cr-cm-set-ttl" class="cr-setting-select">${ttlSelect}</select>
        </div>
      </div>

      <div class="cr-cm-settings-section">
        <div class="cr-cm-settings-title">Auto-Cleanup</div>

        <div class="cr-setting-item">
          <div class="cr-setting-info">
            <label>Remove by</label>
            <span class="cr-setting-desc">What to remove when cache is full</span>
          </div>
          <select id="cr-cm-set-eviction-unit" class="cr-setting-select">${evictionUnitSelect}</select>
        </div>

        <div class="cr-setting-item">
          <div class="cr-setting-info">
            <label>Remove first</label>
            <span class="cr-setting-desc">Which items to remove first</span>
          </div>
          <select id="cr-cm-set-eviction-priority" class="cr-setting-select">${evictionPrioritySelect}</select>
        </div>
      </div>

      <div class="cr-cm-settings-section">
        <div class="cr-cm-settings-title">Notifications</div>

        <div class="cr-setting-item">
          <div class="cr-setting-info">
            <label>Cleanup Notifications</label>
            <span class="cr-setting-desc">Show a toast when cached data is removed</span>
          </div>
          <label class="cr-toggle">
            <input type="checkbox" id="cr-cm-set-eviction-notif"${s.imageCacheEvictionNotifications ? ' checked' : ''}>
            <span class="cr-toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="cr-cm-settings-actions">
        <button class="cr-cm-bulk-btn" id="cr-cm-settings-reset">Reset to Defaults</button>
        <button class="cr-cm-save-btn" id="cr-cm-settings-save">Save</button>
      </div>
    `;
  }

  // ─── Images Panel ──────────────────────────────────────────────────────────

  private renderImagesPanel(): string {
    const records = this.getSortedImageRecords();
    const hasAnyImageData = this.records.some(r => r.imageCache);

    if (!hasAnyImageData) {
      return `
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No cached images</div>
          <div class="cr-cm-empty-desc">Start reading manga to populate the image cache.</div>
        </div>
      `;
    }

    if (records.length === 0) {
      return `
        <div class="cr-cm-search-bar">
          <input type="text" class="cr-cm-search-input cr-cm-search-images" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
          ${this.renderFilterChips()}
        </div>
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No matches</div>
          <div class="cr-cm-empty-desc">No cached images match your filters.</div>
        </div>
      `;
    }

    return `
      <div class="cr-cm-search-bar">
        <input type="text" class="cr-cm-search-input cr-cm-search-images" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
        ${this.renderFilterChips()}
      </div>
      <div class="cr-cm-list-header">
        <span>${records.length} manga</span>
        <select class="cr-cm-sort-select" id="cr-cm-sort-images">
          <option value="size-desc"${this.imageSortMode === 'size-desc' ? ' selected' : ''}>Largest first</option>
          <option value="size-asc"${this.imageSortMode === 'size-asc' ? ' selected' : ''}>Smallest first</option>
          <option value="name-asc"${this.imageSortMode === 'name-asc' ? ' selected' : ''}>A to Z</option>
          <option value="recent"${this.imageSortMode === 'recent' ? ' selected' : ''}>Most recent</option>
        </select>
      </div>
      <div class="cr-cm-list" id="cr-cm-image-list">
        ${records.map(r => this.renderImageRow(r)).join('')}
      </div>
    `;
  }

  private renderImageRow(record: MangaDataRecord): string {
    const ic = record.imageCache!;
    const sizeText = formatBytes(ic.totalSize);
    const firstLetter = (record.displayTitle[0] || '?').toUpperCase();
    const isExpanded = this.expandedRows.has(`img:${record.key}`);
    const chapterCount = ic.chapters.length;

    return `
      <div class="cr-cm-row" data-key="${record.key}">
        <div class="cr-cm-row-main">
          ${this.buildCoverHtml(record.sourceId, record.mangaSlug, firstLetter)}
          <div class="cr-cm-row-info">
            <div class="cr-cm-row-title" title="${this.escapeHtml(record.displayTitle)}">${this.escapeHtml(record.displayTitle)}</div>
            <div class="cr-cm-row-meta">
              <span class="cr-cm-source-badge">${this.escapeHtml(record.sourceName)}</span>
              <span>${ic.imageCount} images</span>
              <span class="cr-cm-size-accent">${sizeText}</span>
            </div>
          </div>
          <div class="cr-cm-row-actions">
            ${chapterCount > 0 ? `
              <button class="cr-cm-expand-btn${isExpanded ? ' cr-cm-expanded' : ''}" data-expand-key="img:${record.key}">
                ${chapterCount} ch.
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            ` : ''}
            <button class="cr-cm-delete-btn" data-delete-key="${record.key}" data-delete-type="image" title="Delete cached images">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        ${isExpanded ? `<div class="cr-cm-row-expand">${this.renderImageChapterRows(record)}</div>` : ''}
      </div>
    `;
  }

  private renderImageChapterRows(record: MangaDataRecord): string {
    return record.imageCache!.chapters.map(ch => `
      <div class="cr-cm-chapter-row">
        <span class="cr-cm-ch-slug" title="${this.escapeHtml(ch.chapterSlug)}">${this.escapeHtml(ch.chapterSlug)}</span>
        <span class="cr-cm-ch-stat">${ch.imageCount} img</span>
        <span class="cr-cm-ch-stat">${formatBytes(ch.totalSize)}</span>
        <span class="cr-cm-ch-stat">${this.formatTimeAgo(ch.newestTimestamp)}</span>
        <button class="cr-cm-ch-delete" data-delete-key="${record.key}" data-chapter="${this.escapeHtml(ch.chapterSlug)}" data-delete-type="image-chapter" title="Delete chapter">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `).join('');
  }

  // ─── Source Data Panel ─────────────────────────────────────────────────────

  private renderSourceDataPanel(): string {
    const records = this.getSortedSourceDataRecords();
    const hasAnySourceData = this.records.some(r => r.sourceData);

    if (!hasAnySourceData) {
      return `
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No cached source data</div>
          <div class="cr-cm-empty-desc">Chapter lists and page URLs will appear here once cached.</div>
        </div>
      `;
    }

    if (records.length === 0) {
      return `
        <div class="cr-cm-search-bar">
          <input type="text" class="cr-cm-search-input cr-cm-search-source-data" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
          ${this.renderFilterChips()}
        </div>
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No matches</div>
          <div class="cr-cm-empty-desc">No cached source data matches your filters.</div>
        </div>
      `;
    }

    return `
      <div class="cr-cm-search-bar">
        <input type="text" class="cr-cm-search-input cr-cm-search-source-data" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
        ${this.renderFilterChips()}
      </div>
      <div class="cr-cm-list-header">
        <span>${records.length} manga with cached source data</span>
        <select class="cr-cm-sort-select" id="cr-cm-sort-source-data">
          <option value="sd-name-asc"${this.sourceDataSortMode === 'sd-name-asc' ? ' selected' : ''}>A to Z</option>
          <option value="sd-chapters-desc"${this.sourceDataSortMode === 'sd-chapters-desc' ? ' selected' : ''}>Most chapters</option>
          <option value="sd-chapters-asc"${this.sourceDataSortMode === 'sd-chapters-asc' ? ' selected' : ''}>Fewest chapters</option>
          <option value="sd-pages-desc"${this.sourceDataSortMode === 'sd-pages-desc' ? ' selected' : ''}>Most page caches</option>
          <option value="sd-recent"${this.sourceDataSortMode === 'sd-recent' ? ' selected' : ''}>Recently cached</option>
        </select>
      </div>
      <div class="cr-cm-list" id="cr-cm-source-data-list">
        ${records.map(r => this.renderSourceDataRow(r)).join('')}
      </div>
    `;
  }

  private renderSourceDataRow(record: MangaDataRecord): string {
    const sd = record.sourceData!;
    const firstLetter = (record.displayTitle[0] || '?').toUpperCase();
    const isExpanded = this.expandedRows.has(`sd:${record.key}`);

    // Data tags
    const tags: string[] = [];
    if (sd.hasChapterList) {
      tags.push(`<span class="cr-cm-tag cr-cm-tag-chapters">${sd.chapterListCount} chapters listed</span>`);
    }
    if (sd.cachedChapterPages.length > 0) {
      tags.push(`<span class="cr-cm-tag cr-cm-tag-pages">${sd.cachedChapterPages.length} page caches</span>`);
    }
    if (sd.hasMangaDetails) {
      tags.push(`<span class="cr-cm-tag cr-cm-tag-details">Details cached</span>`);
    }

    return `
      <div class="cr-cm-row" data-key="${record.key}">
        <div class="cr-cm-row-main">
          ${this.buildCoverHtml(record.sourceId, record.mangaSlug, firstLetter)}
          <div class="cr-cm-row-info">
            <div class="cr-cm-row-title" title="${this.escapeHtml(record.displayTitle)}">${this.escapeHtml(record.displayTitle)}</div>
            <div class="cr-cm-row-meta">
              <span class="cr-cm-source-badge">${this.escapeHtml(record.sourceName)}</span>
            </div>
            <div class="cr-cm-data-tags">${tags.join('')}</div>
          </div>
          <div class="cr-cm-row-actions">
            <button class="cr-cm-expand-btn${isExpanded ? ' cr-cm-expanded' : ''}" data-expand-key="sd:${record.key}">
              Details
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <button class="cr-cm-delete-btn" data-delete-key="${record.key}" data-delete-type="source-data" title="Delete source data">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        ${isExpanded ? `<div class="cr-cm-row-expand">${this.renderSourceDataDetails(record)}</div>` : ''}
      </div>
    `;
  }

  private renderSourceDataDetails(record: MangaDataRecord): string {
    const sd = record.sourceData!;
    let html = '';

    if (sd.hasChapterList) {
      html += `
        <div class="cr-cm-detail-section">
          <div class="cr-cm-detail-header">
            <span>Chapter List (${sd.chapterListCount} chapters)</span>
            <span class="cr-cm-detail-age">${sd.chapterListTimestamp ? `Cached ${this.formatTimeAgo(sd.chapterListTimestamp)}` : ''}</span>
          </div>
        </div>
      `;
    }

    if (sd.cachedChapterPages.length > 0) {
      html += `
        <div class="cr-cm-detail-section">
          <div class="cr-cm-detail-header">
            <span>Cached Page URLs (${sd.cachedChapterPages.length} chapters)</span>
          </div>
          <div class="cr-cm-detail-rows">
            ${sd.cachedChapterPages.map(cp => `
              <div class="cr-cm-chapter-row">
                <span class="cr-cm-ch-slug" title="${this.escapeHtml(cp.chapterSlug)}">${this.escapeHtml(cp.chapterSlug)}</span>
                <span class="cr-cm-ch-stat">${cp.pageCount} pages</span>
                <span class="cr-cm-ch-stat">${this.formatTimeAgo(cp.timestamp)}</span>
                <button class="cr-cm-ch-delete" data-delete-key="${record.key}" data-chapter="${this.escapeHtml(cp.chapterSlug)}" data-delete-type="source-data-chapter" title="Delete page cache">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (sd.hasMangaDetails) {
      html += `
        <div class="cr-cm-detail-section">
          <div class="cr-cm-detail-header">
            <span>Manga Details</span>
            <span class="cr-cm-detail-age">${sd.mangaDetailsTimestamp ? `Cached ${this.formatTimeAgo(sd.mangaDetailsTimestamp)}` : ''}</span>
          </div>
        </div>
      `;
    }

    return html || '<div class="cr-cm-detail-section"><span style="color: #555; font-size: 12px;">No detailed data available.</span></div>';
  }

  // ─── Mappings & State Panel ────────────────────────────────────────────────

  private renderMappingsPanel(): string {
    const records = this.getSortedMappingsRecords();
    const deduped = this.deduplicateMappingsRecords(records);
    const hasAnyMapping = this.records.some(r => r.mapping || r.readingState);

    if (!hasAnyMapping) {
      return `
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No mappings or reading states</div>
          <div class="cr-cm-empty-desc">Link a manga to a source to create a mapping.</div>
        </div>
      `;
    }

    if (deduped.length === 0) {
      return `
        <div class="cr-cm-search-bar">
          <input type="text" class="cr-cm-search-input cr-cm-search-mappings" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
          ${this.renderFilterChips()}
        </div>
        <div class="cr-cm-empty">
          <div class="cr-cm-empty-title">No matches</div>
          <div class="cr-cm-empty-desc">No mappings match your filters.</div>
        </div>
      `;
    }

    return `
      <div class="cr-cm-search-bar">
        <input type="text" class="cr-cm-search-input cr-cm-search-mappings" placeholder="Search manga..." value="${this.escapeHtml(this.searchQuery)}" autocomplete="off">
        ${this.renderFilterChips()}
      </div>
      <div class="cr-cm-list-header">
        <span>${deduped.length} manga</span>
        <select class="cr-cm-sort-select" id="cr-cm-sort-mappings">
          <option value="map-name-asc"${this.mappingsSortMode === 'map-name-asc' ? ' selected' : ''}>A to Z</option>
          <option value="map-recent-read"${this.mappingsSortMode === 'map-recent-read' ? ' selected' : ''}>Recently read</option>
          <option value="map-chapters-read"${this.mappingsSortMode === 'map-chapters-read' ? ' selected' : ''}>Most chapters read</option>
          <option value="map-current-chapter"${this.mappingsSortMode === 'map-current-chapter' ? ' selected' : ''}>Current chapter</option>
        </select>
      </div>
      <div class="cr-cm-list" id="cr-cm-mappings-list">
        ${deduped.map(d => this.renderMappingRow(d)).join('')}
      </div>
    `;
  }

  private renderMappingRow(data: MappingRowData): string {
    const { record, allSourceNames } = data;
    const firstLetter = (record.displayTitle[0] || '?').toUpperCase();
    const isExpanded = this.expandedRows.has(`map:${record.key}`);

    // Source badges with truncation — selected (first) is purple, others gray
    const MAX_BADGES = 2;
    const shownNames = allSourceNames.slice(0, MAX_BADGES);
    const remaining = allSourceNames.length - shownNames.length;
    let badgesHtml = shownNames
      .map((name, i) => `<span class="cr-cm-source-badge${i > 0 ? ' cr-cm-source-badge-alt' : ''}">${this.escapeHtml(name)}</span>`)
      .join('');
    if (remaining > 0) {
      badgesHtml += `<span class="cr-cm-source-badge cr-cm-source-badge-more">+${remaining} more</span>`;
    }

    // Summary meta
    const metaParts: string[] = [];
    metaParts.push(badgesHtml);
    if (record.readingState) {
      metaParts.push(`<span>Ch. ${record.readingState.currentChapter}</span>`);
      metaParts.push(`<span>${this.formatTimeAgo(record.readingState.lastRead)}</span>`);
      if (record.readingState.readChapters.length > 0) {
        metaParts.push(`<span>${record.readingState.readChapters.length} read</span>`);
      }
    }

    return `
      <div class="cr-cm-row" data-key="${record.key}">
        <div class="cr-cm-row-main">
          ${this.buildCoverHtml(record.sourceId, record.mangaSlug, firstLetter)}
          <div class="cr-cm-row-info">
            <div class="cr-cm-row-title" title="${this.escapeHtml(record.displayTitle)}">${this.escapeHtml(record.displayTitle)}</div>
            <div class="cr-cm-row-subtitle">${this.escapeHtml(record.mangaSlug)}</div>
            <div class="cr-cm-row-meta">${metaParts.join('')}</div>
          </div>
          <div class="cr-cm-row-actions">
            <button class="cr-cm-expand-btn${isExpanded ? ' cr-cm-expanded' : ''}" data-expand-key="map:${record.key}">
              Details
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
        </div>
        ${isExpanded ? `<div class="cr-cm-row-expand">${this.renderMappingDetails(record)}</div>` : ''}
      </div>
    `;
  }

  private renderMappingDetails(record: MangaDataRecord): string {
    let html = '';

    if (record.mapping) {
      const m = record.mapping;
      let sourceSlugsHtml = '';
      for (const [sid, info] of Object.entries(m.sources)) {
        const sourceName = sourceRegistry.get(sid)?.name || sid;
        const hasDims = info.placeholderWidth && info.placeholderHeight;
        const dimsText = hasDims ? ` (${info.placeholderWidth} × ${info.placeholderHeight})` : '';
        sourceSlugsHtml += `
          <div class="cr-cm-mapping-row cr-cm-mapping-sub">
            <span class="cr-cm-mapping-label">${this.escapeHtml(sourceName)}</span>
            <span class="cr-cm-mapping-value cr-cm-mono">${this.escapeHtml(info.slug)}${dimsText}</span>
          </div>
        `;
      }

      html += `
        <div class="cr-cm-detail-section">
          <div class="cr-cm-detail-header"><span>Source Mapping</span></div>
          <div class="cr-cm-mapping-grid">
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">ComicK Slug</span>
              <span class="cr-cm-mapping-value cr-cm-mono">${this.escapeHtml(m.comickSlug)}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">ComicK Title</span>
              <span class="cr-cm-mapping-value">${this.escapeHtml(m.comickTitle)}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Custom Title</span>
              <span class="cr-cm-mapping-value${m.customTitle ? '' : ' cr-cm-muted'}">${m.customTitle ? this.escapeHtml(m.customTitle) : 'None'}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Alt Titles</span>
              <span class="cr-cm-mapping-value${record.alternateTitles.length ? '' : ' cr-cm-muted'}">${this.renderAltTitlesInline(record)}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Selected Source</span>
              <span class="cr-cm-mapping-value">${this.escapeHtml(m.selectedSource)}</span>
            </div>
            ${sourceSlugsHtml}
          </div>
        </div>
      `;
    }

    if (record.readingState) {
      const rs = record.readingState;
      html += `
        <div class="cr-cm-detail-section">
          <div class="cr-cm-detail-header"><span>Reading State</span></div>
          <div class="cr-cm-mapping-grid">
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Current Chapter</span>
              <span class="cr-cm-mapping-value">${rs.currentChapter}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Last Read</span>
              <span class="cr-cm-mapping-value">${this.formatTimeAgo(rs.lastRead)}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Reading Mode</span>
              <span class="cr-cm-mapping-value">${rs.readingMode}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Image Fit</span>
              <span class="cr-cm-mapping-value">${rs.imageFit}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Chapters Read</span>
              <span class="cr-cm-mapping-value">${rs.readChapters.length}</span>
            </div>
            <div class="cr-cm-mapping-row">
              <span class="cr-cm-mapping-label">Saved Positions</span>
              <span class="cr-cm-mapping-value">${rs.chapterPositionsCount}</span>
            </div>
          </div>
        </div>
      `;
    }

    return html || '<div class="cr-cm-detail-section"><span style="color: #555; font-size: 12px;">No data available.</span></div>';
  }

  // ─── Event Handling ────────────────────────────────────────────────────────

  private setupEventListeners(): void {
    const body = document.getElementById('cr-cm-body');
    if (!body) return;

    // Tab switching
    document.getElementById('cr-cm-tabs')?.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest('.cr-cm-tab') as HTMLElement;
      if (tab?.dataset.tab) {
        this.switchTab(tab.dataset.tab);
      }
    });

    // Search inputs (all tabs share the query)
    body.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains('cr-cm-search-input')) {
        this.handleSearch(target.value);
      }
      // Settings: cache size slider
      if (target.id === 'cr-cm-set-size' && this.cachedSettings) {
        const mb = parseInt(target.value, 10);
        this.cachedSettings.imageCacheMaxSizeMB = mb;
        const label = document.getElementById('cr-cm-set-size-val');
        if (label) {
          label.textContent = formatMB(mb);
        }
      }
    });

    // Sort selector + settings change events
    body.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      if ((target as HTMLSelectElement).id === 'cr-cm-sort-images') {
        this.imageSortMode = (target as HTMLSelectElement).value as ImageSortMode;
        this.rerenderActiveTab();
      } else if ((target as HTMLSelectElement).id === 'cr-cm-sort-source-data') {
        this.sourceDataSortMode = (target as HTMLSelectElement).value as SourceDataSortMode;
        this.rerenderActiveTab();
      } else if ((target as HTMLSelectElement).id === 'cr-cm-sort-mappings') {
        this.mappingsSortMode = (target as HTMLSelectElement).value as MappingsSortMode;
        this.rerenderActiveTab();
      }
      // Settings: toggle — handled in click listener for async confirm
      // Settings: TTL dropdown
      if ((target as HTMLSelectElement).id === 'cr-cm-set-ttl' && this.cachedSettings) {
        this.cachedSettings.imageCacheTTLDays = parseInt((target as HTMLSelectElement).value, 10);
      }
      // Settings: eviction unit dropdown
      if ((target as HTMLSelectElement).id === 'cr-cm-set-eviction-unit' && this.cachedSettings) {
        this.cachedSettings.imageCacheEvictionUnit = (target as HTMLSelectElement).value as EvictionUnit;
      }
      // Settings: eviction priority dropdown
      if ((target as HTMLSelectElement).id === 'cr-cm-set-eviction-priority' && this.cachedSettings) {
        this.cachedSettings.imageCacheEvictionPriority = (target as HTMLSelectElement).value as EvictionPriority;
      }
    });

    // Notification toggle (in click listener for consistency with enable toggle)
    body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const notifToggle = target.closest('#cr-cm-set-eviction-notif') as HTMLInputElement;
      if (notifToggle && this.cachedSettings) {
        this.cachedSettings.imageCacheEvictionNotifications = notifToggle.checked;
      }
    });

    // Click delegation
    body.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;

      // Warning tip: "cache size" link → switch to settings tab
      if (target.dataset.action === 'go-settings') {
        this.switchTab('settings');
        return;
      }

      // Settings: enable toggle with disable warning
      const enableToggle = target.closest('#cr-cm-set-enable') as HTMLInputElement;
      if (enableToggle && this.cachedSettings) {
        const isChecked = enableToggle.checked;
        if (!isChecked) {
          const confirmed = await this.showConfirmDialog(
            'Disable Image Cache?',
            'Disabling the image cache means every page will be fetched from the source on each read. This can cause slower loading and may trigger rate limiting from manga sources, resulting in failed image loads or temporary blocks.\n\nYour browser may still serve recently viewed images from its own cache, but this is not reliable and will not persist across sessions.',
            'Disable'
          );
          if (!confirmed) {
            enableToggle.checked = true;
            return;
          }
        }
        this.cachedSettings.enableImageCache = isChecked;
        return;
      }

      // Source filter chips
      const filterChip = target.closest('.cr-cm-filter-chip') as HTMLElement;
      if (filterChip?.dataset.sourceFilter) {
        const sourceId = filterChip.dataset.sourceFilter;
        this.sourceFilter = this.sourceFilter === sourceId ? '' : sourceId;
        this.applyFilter();
        this.rerenderActiveTab();
        return;
      }

      // Expand/collapse
      const expandBtn = target.closest('.cr-cm-expand-btn') as HTMLElement;
      if (expandBtn?.dataset.expandKey) {
        this.toggleExpand(expandBtn.dataset.expandKey);
        return;
      }

      // Alt titles popup
      const altTitlesBtn = target.closest('.cr-cm-alt-titles-more') as HTMLElement;
      if (altTitlesBtn?.dataset.altTitlesKey) {
        const record = this.records.find(r => r.key === altTitlesBtn.dataset.altTitlesKey);
        if (record) showAltTitlesPopup(record.alternateTitles, this.escapeHtml.bind(this));
        return;
      }

      // Per-chapter delete
      const chDelete = target.closest('.cr-cm-ch-delete') as HTMLElement;
      if (chDelete) {
        const key = chDelete.dataset.deleteKey;
        const chapter = chDelete.dataset.chapter;
        const type = chDelete.dataset.deleteType;
        if (key && chapter && type) {
          const record = this.records.find(r => r.key === key);
          if (record) {
            if (type === 'image-chapter') {
              await this.handleDeleteImageChapter(record, chapter);
            } else if (type === 'source-data-chapter') {
              await this.handleDeleteSourceDataChapter(record, chapter);
            }
          }
        }
        return;
      }

      // Per-manga delete
      const deleteBtn = target.closest('.cr-cm-delete-btn') as HTMLElement;
      if (deleteBtn) {
        const key = deleteBtn.dataset.deleteKey;
        const type = deleteBtn.dataset.deleteType;
        if (key && type) {
          const record = this.records.find(r => r.key === key);
          if (record) {
            if (type === 'image') {
              await this.handleDeleteImageManga(record);
            } else if (type === 'source-data') {
              await this.handleDeleteSourceDataManga(record);
            }
          }
        }
        return;
      }
    });

    // Bulk actions (delegated — survives re-renders without re-attaching)
    body.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('#cr-cm-clear-all-images, #cr-cm-clear-all-source-data') as HTMLElement;
      if (!btn) return;

      if (btn.id === 'cr-cm-clear-all-images') {
        const confirmed = await this.showConfirmDialog(
          'Clear All Image Cache?',
          `This will delete all ${this.totalEntries.toLocaleString()} cached images (${formatBytes(this.totalSize)}). You will need to re-download images when reading.`,
          'Delete'
        );
        if (!confirmed) return;
        await bridgeCacheClear();
        this.totalSize = 0;
        this.totalEntries = 0;
        for (const r of this.records) r.imageCache = null;
        this.applyFilter();
        this.fullRerender();
      } else if (btn.id === 'cr-cm-clear-all-source-data') {
        const confirmed = await this.showConfirmDialog(
          'Clear All Source Data?',
          'This will delete all cached chapter lists, page URLs, and manga details. Data will be re-fetched as needed.',
          'Delete'
        );
        if (!confirmed) return;
        await bridgeSourceDataClearAll();
        this.chapterListCount = 0;
        this.chapterPagesCount = 0;
        this.mangaDetailsCount = 0;
        this.sourceDataBytes = 0;
        for (const r of this.records) r.sourceData = null;
        this.applyFilter();
        this.fullRerender();
      }
    });

    // Settings save/reset
    body.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('#cr-cm-settings-save, #cr-cm-settings-reset') as HTMLElement;
      if (!btn || !this.cachedSettings) return;

      if (btn.id === 'cr-cm-settings-save') {
        const newMaxMB = this.cachedSettings.imageCacheMaxSizeMB;
        const newMaxBytes = newMaxMB * 1024 * 1024;
        const sizeLabel = formatMB(newMaxMB);

        // Confirm if reducing below current usage
        if (this.totalSize > newMaxBytes) {
          const excess = this.totalSize - newMaxBytes;
          const confirmed = await this.showConfirmDialog(
            'Reduce Cache Size?',
            `You currently have ${formatBytes(this.totalSize)} cached. Reducing the limit to ${sizeLabel} will remove approximately ${formatBytes(excess)} of cached images (least recently read manga first).`,
            'Reduce'
          );
          if (!confirmed) return;
        }

        await settingsManager.update({
          enableImageCache: this.cachedSettings.enableImageCache,
          imageCacheMaxSizeMB: this.cachedSettings.imageCacheMaxSizeMB,
          imageCacheTTLDays: this.cachedSettings.imageCacheTTLDays,
          imageCacheEvictionUnit: this.cachedSettings.imageCacheEvictionUnit,
          imageCacheEvictionPriority: this.cachedSettings.imageCacheEvictionPriority,
          imageCacheEvictionNotifications: this.cachedSettings.imageCacheEvictionNotifications,
        });

        const result = await bridgeCacheUpdateSettings({
          enabled: this.cachedSettings.enableImageCache,
          ttlDays: this.cachedSettings.imageCacheTTLDays,
          maxSizeMB: this.cachedSettings.imageCacheMaxSizeMB,
          evictionUnit: this.cachedSettings.imageCacheEvictionUnit,
          evictionPriority: this.cachedSettings.imageCacheEvictionPriority,
        });

        this.maxSizeMB = this.cachedSettings.imageCacheMaxSizeMB;

        // Show eviction notification if data was removed
        if (result.evicted && result.evicted.count > 0) {
          this.totalSize -= result.evicted.freedMB * 1024 * 1024;
          this.totalEntries -= result.evicted.count;
          if (this.cachedSettings.imageCacheEvictionNotifications) {
            showToast(
              `Freed ${formatBytes(result.evicted.freedMB * 1024 * 1024)} — removed ${result.evicted.manga.length} manga from cache`,
              { onDismiss: () => this.disableEvictionNotifications() }
            );
          }
        }

        btn.textContent = 'Saved!';
        setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 1500);

        // Update overview panel to reflect new settings
        const overviewPanel = document.getElementById('cr-cm-panel-overview');
        if (overviewPanel) overviewPanel.innerHTML = this.renderOverviewPanel();
      } else if (btn.id === 'cr-cm-settings-reset') {
        this.cachedSettings.enableImageCache = DEFAULT_SETTINGS.enableImageCache;
        this.cachedSettings.imageCacheMaxSizeMB = DEFAULT_SETTINGS.imageCacheMaxSizeMB;
        this.cachedSettings.imageCacheTTLDays = DEFAULT_SETTINGS.imageCacheTTLDays;
        this.cachedSettings.imageCacheEvictionUnit = DEFAULT_SETTINGS.imageCacheEvictionUnit;
        this.cachedSettings.imageCacheEvictionPriority = DEFAULT_SETTINGS.imageCacheEvictionPriority;
        this.cachedSettings.imageCacheEvictionNotifications = DEFAULT_SETTINGS.imageCacheEvictionNotifications;
        this.rerenderActiveTab();
      }
    });
  }

  // ─── Search & Filter ───────────────────────────────────────────────────────

  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  private handleSearch(query: string): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => {
      this.searchQuery = query;
      this.applyFilter();
      this.rerenderActiveTab();

      // Restore focus to the active tab's search input and place cursor at end
      const activePanel = document.getElementById(`cr-cm-panel-${this.activeTab}`);
      const input = activePanel?.querySelector<HTMLInputElement>('.cr-cm-search-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }, 200);
  }

  private applyFilter(): void {
    const q = this.searchQuery.toLowerCase().trim();
    let filtered = this.records;

    if (this.sourceFilter) {
      filtered = filtered.filter(r => r.sourceId === this.sourceFilter);
    }

    if (q) {
      filtered = filtered.filter(r =>
        r.displayTitle.toLowerCase().includes(q) ||
        r.mangaSlug.toLowerCase().includes(q) ||
        (r.comickSlug && r.comickSlug.toLowerCase().includes(q)) ||
        r.sourceName.toLowerCase().includes(q) ||
        r.alternateTitles.some(t => t.toLowerCase().includes(q))
      );
    }

    this.filteredRecords = filtered;
  }

  private getUniqueSources(): Array<{ id: string; name: string }> {
    const seen = new Map<string, string>();
    for (const r of this.records) {
      if (!seen.has(r.sourceId)) {
        seen.set(r.sourceId, r.sourceName);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }

  private renderFilterChips(): string {
    const sources = this.getUniqueSources();
    if (sources.length <= 1) return '';

    const chips = sources.map(s =>
      `<button class="cr-cm-filter-chip${this.sourceFilter === s.id ? ' cr-cm-filter-active' : ''}" data-source-filter="${s.id}">${this.escapeHtml(s.name)}</button>`
    ).join('');

    return `<div class="cr-cm-filter-chips">${chips}</div>`;
  }

  private toggleExpand(expandKey: string): void {
    if (this.expandedRows.has(expandKey)) {
      this.expandedRows.delete(expandKey);
    } else {
      this.expandedRows.add(expandKey);
    }
    this.rerenderActiveTab();
  }

  private rerenderActiveTab(): void {
    const panelId = `cr-cm-panel-${this.activeTab}`;
    const panel = document.getElementById(panelId);
    if (!panel) return;

    switch (this.activeTab) {
      case 'overview':
        panel.innerHTML = this.renderOverviewPanel();
        break;
      case 'images':
        panel.innerHTML = this.renderImagesPanel();
        break;
      case 'source-data':
        panel.innerHTML = this.renderSourceDataPanel();
        break;
      case 'mappings':
        panel.innerHTML = this.renderMappingsPanel();
        break;
      case 'settings':
        panel.innerHTML = this.renderSettingsPanel();
        break;
    }

    this.renderTabs();
    this.setupLazyLoading();
  }

  private fullRerender(): void {
    this.renderContent();
    this.setupEventListeners();
    this.setupLazyLoading();
  }

  // ─── Delete Handlers ───────────────────────────────────────────────────────

  private async handleDeleteImageManga(record: MangaDataRecord): Promise<void> {
    if (!record.imageCache) return;
    const confirmed = await this.showConfirmDialog(
      'Delete cached images?',
      `Delete all cached images for "${record.displayTitle}"? (${record.imageCache.imageCount} images, ${formatBytes(record.imageCache.totalSize)})`,
      'Delete'
    );
    if (!confirmed) return;

    await bridgeCacheClearManga(record.sourceId, record.mangaSlug);

    this.totalSize -= record.imageCache.totalSize;
    this.totalEntries -= record.imageCache.imageCount;
    record.imageCache = null;
    this.expandedRows.delete(`img:${record.key}`);
    this.applyFilter();
    this.rerenderActiveTab();
  }

  private async handleDeleteImageChapter(record: MangaDataRecord, chapterSlug: string): Promise<void> {
    if (!record.imageCache) return;

    await bridgeCacheClearChapter(record.sourceId, record.mangaSlug, chapterSlug);

    const ch = record.imageCache.chapters.find(c => c.chapterSlug === chapterSlug);
    if (ch) {
      this.totalSize -= ch.totalSize;
      this.totalEntries -= ch.imageCount;
      record.imageCache.totalSize -= ch.totalSize;
      record.imageCache.imageCount -= ch.imageCount;
      record.imageCache.chapters = record.imageCache.chapters.filter(c => c.chapterSlug !== chapterSlug);

      if (record.imageCache.chapters.length === 0) {
        record.imageCache = null;
        this.expandedRows.delete(`img:${record.key}`);
      }
    }
    this.applyFilter();
    this.rerenderActiveTab();
  }

  private async handleDeleteSourceDataManga(record: MangaDataRecord): Promise<void> {
    if (!record.sourceData) return;
    const confirmed = await this.showConfirmDialog(
      'Delete source data?',
      `Delete all cached source data for "${record.displayTitle}"? (chapter list, page URLs, manga details)`,
      'Delete'
    );
    if (!confirmed) return;

    await bridgeSourceDataClearManga(record.sourceId, record.mangaSlug);

    // Adjust global counts
    if (record.sourceData.hasChapterList) this.chapterListCount--;
    this.chapterPagesCount -= record.sourceData.cachedChapterPages.length;
    if (record.sourceData.hasMangaDetails) this.mangaDetailsCount--;

    record.sourceData = null;
    this.expandedRows.delete(`sd:${record.key}`);
    this.applyFilter();
    this.rerenderActiveTab();
  }

  private async handleDeleteSourceDataChapter(record: MangaDataRecord, chapterSlug: string): Promise<void> {
    if (!record.sourceData) return;

    await bridgeSourceDataClearChapterPages(record.sourceId, record.mangaSlug, chapterSlug);

    record.sourceData.cachedChapterPages = record.sourceData.cachedChapterPages.filter(
      c => c.chapterSlug !== chapterSlug
    );
    this.chapterPagesCount--;

    // If no more source data, null out
    if (!record.sourceData.hasChapterList && record.sourceData.cachedChapterPages.length === 0 && !record.sourceData.hasMangaDetails) {
      record.sourceData = null;
      this.expandedRows.delete(`sd:${record.key}`);
    }
    this.applyFilter();
    this.rerenderActiveTab();
  }

  // ─── Cover Art Loading ─────────────────────────────────────────────────────

  private setupLazyLoading(): void {
    this.observer?.disconnect();

    const scrollRoot = document.getElementById('cr-cm-body');
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const container = entry.target as HTMLElement;
            const img = container.querySelector<HTMLImageElement>('.cr-cm-cover-img');
            if (img) {
              const sourceId = img.dataset.source;
              const slug = img.dataset.slug;
              if (sourceId && slug) {
                this.enqueueCoverLoad(img, sourceId, slug);
              }
            }
            this.observer?.unobserve(container);
          }
        }
      },
      { root: scrollRoot, rootMargin: '100px' }
    );

    // Observe cover containers (not the img itself, which is display:none until loaded)
    const activePanel = document.getElementById(`cr-cm-panel-${this.activeTab}`);
    activePanel?.querySelectorAll('.cr-cm-row-cover').forEach(cover => {
      this.observer?.observe(cover);
    });
  }

  private enqueueCoverLoad(img: HTMLImageElement, sourceId: string, slug: string): void {
    this.coverQueue.push(() => this.loadCover(img, sourceId, slug));
    this.processCoverQueue();
  }

  private processCoverQueue(): void {
    while (this.activeCoverLoads < this.MAX_CONCURRENT_COVERS && this.coverQueue.length > 0) {
      const task = this.coverQueue.shift()!;
      this.activeCoverLoads++;
      task().finally(() => {
        this.activeCoverLoads--;
        this.processCoverQueue();
      });
    }
  }

  private async loadThumbnailUrls(): Promise<void> {
    try {
      const stored = await bridgeStorage.get<Record<string, string>>('cover_thumbnail_urls', {});
      this.thumbnailUrlCache = new Map(Object.entries(stored));
    } catch {
      // Non-critical — will just call getMangaDetails as fallback
    }
  }

  private saveThumbnailUrls(): void {
    // Debounce saves — multiple covers load in rapid succession
    if (this.thumbnailUrlSaveTimer) clearTimeout(this.thumbnailUrlSaveTimer);
    this.thumbnailUrlSaveTimer = setTimeout(() => {
      const obj = Object.fromEntries(this.thumbnailUrlCache);
      bridgeStorage.set('cover_thumbnail_urls', obj);
    }, 1000);
  }

  private async loadCover(img: HTMLImageElement, sourceId: string, slug: string): Promise<void> {
    const cacheKey = `${sourceId}:${slug}`;

    // 1. Check in-memory cache (instant — covers tab switches / re-renders)
    if (this.coverCache.has(cacheKey)) {
      const cached = this.coverCache.get(cacheKey)!;
      if (cached) this.showCoverForSlug(sourceId, slug, cached);
      return;
    }

    // Cover cache key for IndexedDB persistence
    const idbCacheKey: import('@/utils/bridge').CacheKey = {
      sourceId,
      mangaSlug: slug,
      chapterSlug: '__cover__',
      pageIndex: 0,
    };

    try {
      // 2. Check IndexedDB image cache (persists across page reloads)
      const idbHit = await bridgeCacheGet(idbCacheKey);
      if (idbHit) {
        this.coverCache.set(cacheKey, idbHit);
        this.showCoverForSlug(sourceId, slug, idbHit);
        return;
      }

      const timeout = <T>(promise: Promise<T>, ms: number, label: string) =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)
          ),
        ]);

      // 3. Resolve thumbnail URL — check persistent cache first, then getMangaDetails()
      let thumbnailUrl = this.thumbnailUrlCache.get(cacheKey);
      if (!thumbnailUrl) {
        const source = sourceRegistry.get(sourceId);
        if (!source) return;
        const details = await timeout(source.getMangaDetails(slug), 15000, 'getMangaDetails');
        if (!details?.thumbnailUrl) return;
        thumbnailUrl = details.thumbnailUrl;
        this.thumbnailUrlCache.set(cacheKey, thumbnailUrl);
        this.saveThumbnailUrls();
      }

      // 4. Fetch image and store in IndexedDB cache
      const result = await timeout(bridgeFetchImageCached(thumbnailUrl, idbCacheKey), 15000, 'bridgeFetchImageCached');
      this.coverCache.set(cacheKey, result.dataUrl);
      this.showCoverForSlug(sourceId, slug, result.dataUrl);
    } catch (err) {
      console.warn(`[CacheManager] Cover load failed for ${cacheKey}:`, err);
    }
  }

  /**
   * Build cover HTML — embeds cached data URL inline to prevent flash on re-render
   */
  private buildCoverHtml(sourceId: string, slug: string, firstLetter: string): string {
    const cacheKey = `${sourceId}:${slug}`;
    const cached = this.coverCache.get(cacheKey);
    if (cached) {
      return `<div class="cr-cm-row-cover">
            <img class="cr-cm-cover-img cr-cm-loaded" data-source="${sourceId}" data-slug="${slug}" src="${cached}" alt="">
            <div class="cr-cm-cover-placeholder cr-cm-hidden">${firstLetter}</div>
          </div>`;
    }
    return `<div class="cr-cm-row-cover">
            <img class="cr-cm-cover-img" data-source="${sourceId}" data-slug="${slug}" src="" alt="">
            <div class="cr-cm-cover-placeholder">${firstLetter}</div>
          </div>`;
  }

  /**
   * Show cover image on all matching img elements across all panels
   */
  private showCoverForSlug(sourceId: string, slug: string, dataUrl: string): void {
    this.container?.querySelectorAll<HTMLImageElement>(
      `img.cr-cm-cover-img[data-source="${sourceId}"][data-slug="${slug}"]`
    ).forEach(img => this.showCoverImage(img, dataUrl));
  }

  private showCoverImage(img: HTMLImageElement, dataUrl: string): void {
    img.src = dataUrl;
    img.classList.add('cr-cm-loaded');
    const placeholder = img.parentElement?.querySelector('.cr-cm-cover-placeholder');
    placeholder?.classList.add('cr-cm-hidden');
  }

  // ─── Notification Helpers ──────────────────────────────────────────────────

  private disableEvictionNotifications(): void {
    settingsManager.update({ imageCacheEvictionNotifications: false });
    if (this.cachedSettings) {
      this.cachedSettings.imageCacheEvictionNotifications = false;
    }
    // Update toggle if settings tab is visible
    const toggle = document.getElementById('cr-cm-set-eviction-notif') as HTMLInputElement | null;
    if (toggle) toggle.checked = false;
  }

  // ─── Alt Titles ───────────────────────────────────────────────────────────

  private renderAltTitlesInline(record: MangaDataRecord): string {
    const titles = record.alternateTitles;
    if (!titles.length) return 'None';

    const MAX_INLINE = 2;
    const shown = titles.slice(0, MAX_INLINE);
    const remaining = titles.length - shown.length;

    let html = shown
      .map(t => `<span class="cr-cm-alt-title-tag">${this.escapeHtml(t)}</span>`)
      .join('');

    if (remaining > 0) {
      html += `<span class="cr-cm-alt-titles-more" data-alt-titles-key="${record.key}">+${remaining} more</span>`;
    } else if (titles.length > 0) {
      html += `<span class="cr-cm-alt-titles-more" data-alt-titles-key="${record.key}">view all</span>`;
    }

    return html;
  }

  // ─── Confirm Dialog ────────────────────────────────────────────────────────

  private showConfirmDialog(title: string, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
    return new Promise((resolve) => {
      document.getElementById('cr-confirm-dialog')?.remove();

      const dialog = document.createElement('div');
      dialog.id = 'cr-confirm-dialog';
      dialog.className = 'cr-confirm-overlay';
      dialog.innerHTML = `
        <div class="cr-confirm-modal">
          <div class="cr-confirm-header"><h4>${this.escapeHtml(title)}</h4></div>
          <div class="cr-confirm-body"><p>${this.escapeHtml(message)}</p></div>
          <div class="cr-confirm-footer">
            <button class="cr-confirm-cancel" id="cr-confirm-cancel">Cancel</button>
            <button class="cr-confirm-ok" id="cr-confirm-ok">${this.escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      const cleanup = (result: boolean) => {
        document.removeEventListener('keydown', handleEsc);
        dialog.remove();
        resolve(result);
      };

      document.getElementById('cr-confirm-ok')?.addEventListener('click', () => cleanup(true));
      document.getElementById('cr-confirm-cancel')?.addEventListener('click', () => cleanup(false));
      setupBackdropClose(dialog, () => cleanup(false));

      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopImmediatePropagation();
          cleanup(false);
        }
      };
      document.addEventListener('keydown', handleEsc);
    });
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

export const cacheManager = new CacheManager();
