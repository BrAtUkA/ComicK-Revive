// ═══════════════════════════════════════════════════════════════════════════
// READING MODES
// ═══════════════════════════════════════════════════════════════════════════
export type ReadingMode = 'vertical' | 'single' | 'double';
export type ImageFit = 'width' | 'height' | 'original' | 'contain';
export type BackgroundColor = '#000000' | '#0a0a0a' | '#1a1a1a' | '#ffffff';
export type EvictionUnit = 'chapter' | 'manga' | 'image';
export type EvictionPriority = 'lru' | 'oldest';
export type MarkReadMode = 'onOpen' | 'onNextChapter';

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
export interface GlobalSettings {
  // Source
  defaultSource: string;

  // Reading
  defaultReadingMode: ReadingMode;
  defaultImageFit: ImageFit;
  backgroundColor: BackgroundColor;
  scrollAmount: number;    // % of viewport per tap/keypress (25–100)
  scrollSpeed: number;     // Animation speed (1–10), maps to smoothing factor
  preloadPages: number;

  // UI
  toolbarAutoHide: boolean;
  toolbarHideDelay: number;
  scrollbarAutoHide: boolean;

  // Behavior
  rememberChapter: boolean;
  rememberPerChapterPosition: boolean;
  resumePositionOnReadChapter: boolean;
  keyboardShortcutsEnabled: boolean;
  markReadMode: MarkReadMode;
  continuousReading: boolean;

  // Cache
  enableImageCache: boolean;      // Cache manga pages for offline/faster loading
  imageCacheTTLDays: number;      // Days to keep cached images (0 = never expire)
  imageCacheMaxSizeMB: number;    // Maximum cache size in MB
  imageCacheEvictionUnit: EvictionUnit;      // 'chapter' = per-chapter, 'manga' = whole manga, 'image' = per-image
  imageCacheEvictionPriority: EvictionPriority; // 'lru' = least recently accessed, 'oldest' = oldest cached
  imageCacheEvictionNotifications: boolean;  // Show toast when eviction occurs
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  defaultSource: 'asura',
  defaultReadingMode: 'vertical',
  defaultImageFit: 'width',
  backgroundColor: '#000000',
  scrollAmount: 80,
  scrollSpeed: 5,
  preloadPages: 3,
  toolbarAutoHide: true,
  toolbarHideDelay: 4000,
  scrollbarAutoHide: false,
  rememberChapter: true,
  rememberPerChapterPosition: true,
  resumePositionOnReadChapter: false,
  keyboardShortcutsEnabled: true,
  markReadMode: 'onOpen',
  continuousReading: false,
  enableImageCache: true,
  imageCacheTTLDays: 0,
  imageCacheMaxSizeMB: 1024,
  imageCacheEvictionUnit: 'chapter',
  imageCacheEvictionPriority: 'lru',
  imageCacheEvictionNotifications: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// READING POSITION (content-anchored)
// ═══════════════════════════════════════════════════════════════════════════
export interface ReadingPosition {
  anchorImageIndex: number;    // Which page (0-indexed)
  anchorImageOffset: number;   // 0.0 to 1.0, position within page
  
  // Optional extended position data
  scrollTop?: number;
  viewportHeight?: number;
  timestamp?: number;
}

export const DEFAULT_POSITION: ReadingPosition = {
  anchorImageIndex: 0,
  anchorImageOffset: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// MANGA READING STATE (per manga)
// ═══════════════════════════════════════════════════════════════════════════
export interface MangaReadingState {
  // Current chapter (last chapter read)
  currentChapter: number;

  // Per-source, per-chapter positions
  // Outer key: sourceId (e.g. 'asura', 'mangakatana')
  // Inner key: chapter number
  chapterPositions: Record<string, Record<number, ReadingPosition>>;

  // Display settings (per-manga overrides)
  readingMode: ReadingMode;
  zoomLevel: number;
  imageFit: ImageFit;

  // Metadata
  chapterPageCount: number;
  lastRead: number;

  // Per-source, per-chapter page counts (for progress display)
  chapterPageCounts?: Record<string, Record<number, number>>;

  // Read chapters tracking
  readChapters?: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE MAPPING
// ═══════════════════════════════════════════════════════════════════════════
export interface SourceInfo {
  slug: string;           // Full slug with ID
  baseSlug: string;       // Base slug for matching
  title: string;          // Title on that source
  available: boolean;
  lastChecked: number;
  placeholderWidth?: number;   // Typical page width (from page 3 of first chapter)
  placeholderHeight?: number;  // Typical page height
}

export interface MangaSourceMapping {
  comickSlug: string;
  comickTitle: string;
  customTitle?: string;  // User-defined custom title
  selectedSource: string;
  sources: Record<string, SourceInfo>;
  alternateTitles?: string[];  // ComicK alternate titles for search
}

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE TYPES
// ═══════════════════════════════════════════════════════════════════════════
export interface SearchResult {
  slug: string;
  title: string;
  thumbnailUrl: string;
  url: string;
  sourceId?: string;
}

export interface MangaDetails {
  slug: string;
  title: string;
  description: string;
  author: string;
  artist: string;
  status: string;
  genres: string[];
  thumbnailUrl: string;
}

export interface Chapter {
  slug: string;
  id?: string;  // Legacy compatibility
  number: number;
  title: string;
  dateUpload: number;
  isPremium: boolean;
}

export interface PageInfo {
  url: string;
  width?: number;
  height?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMICK PAGE DATA
// ═══════════════════════════════════════════════════════════════════════════
export interface ComickPageData {
  slug: string;
  title: string;
  alternateTitles?: string[];  // All alternate titles from ComicK (md_titles, filteredTitles)
  chapterNumber?: number;
  chapterHid?: string;
  language?: string;
  pageType: 'manga' | 'chapter';
  overrideChapter?: number;  // If set, viewer opens this chapter instead of saved state
  startFromBeginning?: boolean;  // If true, skip position restore and start chapter from page 1
  forceResume?: boolean;  // If true, restore saved position even when "Remember Reading Position" is off
                         // Set by the explicit "Continue Reading" / "Continue Ch.X" buttons whose
                         // sole purpose is resuming — those override the master toggle.
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGES (content script <-> background)
// ═══════════════════════════════════════════════════════════════════════════
export type MessageType =
  | 'FETCH'
  | 'SEARCH_SOURCE'
  | 'GET_CHAPTERS'
  | 'GET_PAGES'
  | 'CHECK_AVAILABILITY';

export interface Message<T = unknown> {
  type: MessageType;
  sourceId: string;
  payload: T;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE MANAGER TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ChapterImageCacheInfo {
  chapterSlug: string;
  imageCount: number;
  totalSize: number;
  oldestTimestamp: number;
  newestTimestamp: number;
}

export interface MangaImageCacheInfo {
  sourceId: string;
  mangaSlug: string;
  imageCount: number;
  totalSize: number;
  chapters: ChapterImageCacheInfo[];
}

export interface DetailedImageCacheStats {
  totalSize: number;
  totalEntries: number;
  maxSizeMB: number;
  ttlDays: number;
  enabled: boolean;
  lastCleanup: number;
  manga: MangaImageCacheInfo[];
}

export interface MangaSourceDataCacheInfo {
  sourceId: string;
  mangaSlug: string;
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

export interface DetailedSourceDataCacheStats {
  chapterListCount: number;
  chapterPagesCount: number;
  manga: MangaSourceDataCacheInfo[];
}
