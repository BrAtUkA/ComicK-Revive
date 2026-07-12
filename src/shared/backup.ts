/**
 * Backup / restore of user data (reading history, library, stats, source
 * config, user sources, settings). Deliberately EXCLUDES the IndexedDB image
 * and page caches: they are large and re-fetchable, so a backup stays small
 * and portable.
 *
 * Pure data layer, context-agnostic (uses the storage wrapper). The
 * dashboard orchestrates the UI, permission prompts, and referer rules for
 * imported user sources on top of this.
 */

import { storage, STORAGE_KEYS } from '@/core';
import type { MangaReadingState, MangaSourceMapping } from '@/types';
import type { DailyStats, StatsTotals } from '@/core';
import type { SourceSpecV1 } from '@/sources/spec/SourceSpec';

export const BACKUP_APP_ID = 'comick-revive';
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupEnvelope {
  app: typeof BACKUP_APP_ID;
  schemaVersion: number;
  exportedAt: number;
  extensionVersion: string;
  data: Record<string, unknown>;
}

export interface BackupSummary {
  mangaWithProgress: number;
  linkedManga: number;
  userSources: string[];
  statsDays: number;
  statsRange: { from: string; to: string } | null;
  chaptersRead: number;
  hasSettings: boolean;
  exportedAt: number | null;
  extensionVersion: string | null;
}

export interface MergeOptions {
  mode: 'merge' | 'replace';
  includeSettings: boolean;
}

export interface MergeResult {
  writes: Record<string, unknown>;
  removes: string[];
  changes: { newManga: number; updatedManga: number; userSources: number; statsDaysAdded: number };
}

const K = STORAGE_KEYS;
const EXACT_KEYS: string[] = [K.GLOBAL_SETTINGS, K.STATS_TOTALS, K.SOURCE_CONFIG, K.SOURCE_CATALOG, K.LIBRARY_META, K.READING_HISTORY];
const PREFIXES: string[] = [
  K.READING_STATE_PREFIX,
  K.SOURCE_MAPPING_PREFIX,
  K.STATS_DAILY_PREFIX,
  K.USER_SOURCE_PREFIX,
];

type Category = 'reading' | 'mapping' | 'statsDaily' | 'statsTotals' | 'settings' | 'sourceConfig' | 'sourceCatalog' | 'userSource' | 'libraryMeta' | 'history' | null;

export function isBackupKey(key: string): boolean {
  return EXACT_KEYS.includes(key) || PREFIXES.some((p) => key.startsWith(p));
}

function categorize(key: string): Category {
  if (key === K.GLOBAL_SETTINGS) return 'settings';
  if (key === K.SOURCE_CONFIG) return 'sourceConfig';
  if (key === K.SOURCE_CATALOG) return 'sourceCatalog';
  if (key === K.STATS_TOTALS) return 'statsTotals';
  if (key === K.LIBRARY_META) return 'libraryMeta';
  if (key === K.READING_HISTORY) return 'history';
  if (key.startsWith(K.READING_STATE_PREFIX)) return 'reading';
  if (key.startsWith(K.SOURCE_MAPPING_PREFIX)) return 'mapping';
  if (key.startsWith(K.STATS_DAILY_PREFIX)) return 'statsDaily';
  if (key.startsWith(K.USER_SOURCE_PREFIX)) return 'userSource';
  return null;
}

const isSettingsKey = (key: string): boolean => key === K.GLOBAL_SETTINGS || key === K.SOURCE_CONFIG;

// ── Read / write ─────────────────────────────────────────────────────────────

/** All backup-eligible key→value pairs from storage. */
export async function collectBackupData(): Promise<Record<string, unknown>> {
  const all = await storage.getByPrefix<unknown>('');
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) {
    if (isBackupKey(key)) data[key] = value;
  }
  return data;
}

export async function buildBackup(extensionVersion: string): Promise<BackupEnvelope> {
  return {
    app: BACKUP_APP_ID,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: Date.now(),
    extensionVersion,
    data: await collectBackupData(),
  };
}

export async function applySnapshot(writes: Record<string, unknown>, removes: string[]): Promise<void> {
  for (const key of removes) await storage.remove(key);
  for (const [key, value] of Object.entries(writes)) await storage.set(key, value);
}

/** User-source specs contained in a backup's data (for permission + referer setup). */
export function extractUserSpecs(data: Record<string, unknown>): SourceSpecV1[] {
  return Object.entries(data)
    .filter(([key]) => key.startsWith(K.USER_SOURCE_PREFIX))
    .map(([, value]) => value as SourceSpecV1)
    .filter((spec) => spec && typeof spec.id === 'string');
}

// ── Validation & summary ─────────────────────────────────────────────────────

export function validateBackup(raw: unknown): { errors: string[]; envelope?: BackupEnvelope } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { errors: ['File is not a valid backup (not a JSON object)'] };
  const env = raw as Partial<BackupEnvelope>;

  if (env.app !== BACKUP_APP_ID) errors.push('This is not a ComicK Revive backup file');
  if (typeof env.schemaVersion !== 'number') errors.push('Missing or invalid schema version');
  else if (env.schemaVersion > BACKUP_SCHEMA_VERSION) {
    errors.push('This backup was made by a newer version of the extension. Update first, then import.');
  }
  if (!env.data || typeof env.data !== 'object') errors.push('Backup contains no data');

  if (errors.length) return { errors };
  return { errors, envelope: env as BackupEnvelope };
}

export function summarize(env: BackupEnvelope): BackupSummary {
  const data = env.data;
  const keys = Object.keys(data);
  const statsDays = keys.filter((k) => k.startsWith(K.STATS_DAILY_PREFIX)).map((k) => k.slice(K.STATS_DAILY_PREFIX.length)).sort();
  const totals = data[K.STATS_TOTALS] as StatsTotals | undefined;

  return {
    mangaWithProgress: keys.filter((k) => k.startsWith(K.READING_STATE_PREFIX)).length,
    linkedManga: keys.filter((k) => k.startsWith(K.SOURCE_MAPPING_PREFIX)).length,
    userSources: extractUserSpecs(data).map((s) => s.name || s.id),
    statsDays: statsDays.length,
    statsRange: statsDays.length ? { from: statsDays[0], to: statsDays[statsDays.length - 1] } : null,
    chaptersRead: totals?.chaptersRead ?? 0,
    hasSettings: K.GLOBAL_SETTINGS in data,
    exportedAt: env.exportedAt ?? null,
    extensionVersion: env.extensionVersion ?? null,
  };
}

// ── Merge ────────────────────────────────────────────────────────────────────

export function mergeData(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  opts: MergeOptions
): MergeResult {
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];
  const changes = { newManga: 0, updatedManga: 0, userSources: 0, statsDaysAdded: 0 };

  if (opts.mode === 'replace') {
    // Drop current eligible keys the incoming set doesn't carry (keep
    // settings/config when the toggle is off)
    for (const key of Object.keys(current)) {
      if (!isBackupKey(key)) continue;
      if (isSettingsKey(key) && !opts.includeSettings) continue;
      if (!(key in incoming)) removes.push(key);
    }
    for (const [key, value] of Object.entries(incoming)) {
      if (!isBackupKey(key)) continue;
      if (isSettingsKey(key) && !opts.includeSettings) continue;
      writes[key] = value;
      if (key.startsWith(K.READING_STATE_PREFIX)) changes.newManga++;
      if (key.startsWith(K.USER_SOURCE_PREFIX)) changes.userSources++;
      if (key.startsWith(K.STATS_DAILY_PREFIX)) changes.statsDaysAdded++;
    }
    return { writes, removes, changes };
  }

  // Merge mode: never removes; per-category union rules
  for (const [key, incVal] of Object.entries(incoming)) {
    if (!isBackupKey(key)) continue;
    const cur = current[key];
    switch (categorize(key)) {
      case 'settings':
      case 'sourceConfig':
        if (opts.includeSettings) writes[key] = incVal;
        break;
      case 'statsTotals':
        writes[key] = cur ? mergeTotals(cur as StatsTotals, incVal as StatsTotals) : incVal;
        break;
      case 'statsDaily':
        if (cur === undefined) { writes[key] = incVal; changes.statsDaysAdded++; }
        break; // fill-missing only; existing days kept to avoid double counting
      case 'reading':
        if (cur === undefined) { writes[key] = incVal; changes.newManga++; }
        else { writes[key] = mergeReadingState(cur as MangaReadingState, incVal as MangaReadingState); changes.updatedManga++; }
        break;
      case 'mapping':
        writes[key] = cur ? mergeMapping(cur as MangaSourceMapping, incVal as MangaSourceMapping) : incVal;
        break;
      case 'userSource':
        if (cur === undefined) { writes[key] = incVal; changes.userSources++; }
        break; // keep locally edited source if the id already exists
      case 'sourceCatalog': {
        // Union of enabled ids; learned facts merge per source (local wins,
        // imageHosts unioned). NOTE: restoring on a fresh install does not
        // re-grant host permissions; such sources register but their requests
        // fail until the user re-enables them from the catalog (re-prompt).
        type Learned = { mangaPath?: string; imageHosts?: string[]; loadMore?: boolean };
        type CatalogVal = { v: 1; enabled: string[]; learned?: Record<string, Learned> };
        const c = (cur ?? { v: 1, enabled: [] }) as CatalogVal;
        const i = (incVal ?? { v: 1, enabled: [] }) as CatalogVal;
        const learned: Record<string, Learned> = { ...(i.learned ?? {}) };
        for (const [id, loc] of Object.entries(c.learned ?? {})) {
          const inc = learned[id];
          learned[id] = { ...inc, ...loc };
          const hosts = [...new Set([...(inc?.imageHosts ?? []), ...(loc.imageHosts ?? [])])];
          if (hosts.length) learned[id].imageHosts = hosts;
        }
        writes[key] = {
          v: 1,
          enabled: [...new Set([...(c.enabled ?? []), ...(i.enabled ?? [])])],
          ...(Object.keys(learned).length ? { learned } : {}),
        };
        break;
      }
      case 'libraryMeta':
        writes[key] = cur ? mergeLibraryMeta(cur as LibraryMetaMap, incVal as LibraryMetaMap) : incVal;
        break;
      case 'history':
        writes[key] = cur ? mergeHistory(cur as HistoryStore, incVal as HistoryStore) : incVal;
        break;
    }
  }
  return { writes, removes, changes };
}

// Shapes mirrored from core/Library.ts and core/History.ts (kept loose here;
// backup merging must tolerate fields from other versions)
type LibraryMetaMap = Record<string, Record<string, unknown>>;
interface HistoryStore { v: 1; seededFromStats: boolean; entries: Array<{ slug: string; chapter: number; at: number; seeded?: boolean }> }

/** Per-slug fill-missing; existing slugs keep local values (manual statuses win). */
function mergeLibraryMeta(cur: LibraryMetaMap, inc: LibraryMetaMap): LibraryMetaMap {
  const out: LibraryMetaMap = { ...cur };
  for (const [slug, meta] of Object.entries(inc ?? {})) {
    out[slug] = slug in out ? { ...meta, ...out[slug] } : meta;
  }
  return out;
}

/** Union of entries deduped by slug+chapter+timestamp, time-ordered, capped. */
function mergeHistory(cur: HistoryStore, inc: HistoryStore): HistoryStore {
  const seen = new Set<string>();
  const merged = [...(cur.entries ?? []), ...(inc?.entries ?? [])]
    .filter((e) => {
      const id = `${e.slug}|${e.chapter}|${e.at}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => a.at - b.at)
    .slice(-1500);
  return { v: 1, seededFromStats: !!(cur.seededFromStats || inc?.seededFromStats), entries: merged };
}

function mergeReadingState(cur: MangaReadingState, inc: MangaReadingState): MangaReadingState {
  const newer = (inc.lastRead || 0) >= (cur.lastRead || 0) ? inc : cur;
  const older = newer === inc ? cur : inc;
  return {
    ...older,
    ...newer, // newer scalar fields (currentChapter, display prefs, lastRead) win
    readChapters: unionNumbers(cur.readChapters, inc.readChapters),
    chapterPositions: mergeTwoLevel(newer.chapterPositions, older.chapterPositions),
    chapterPageCounts: mergeTwoLevel(newer.chapterPageCounts, older.chapterPageCounts),
  };
}

function mergeMapping(cur: MangaSourceMapping, inc: MangaSourceMapping): MangaSourceMapping {
  const sources: MangaSourceMapping['sources'] = {};
  for (const id of new Set([...Object.keys(cur.sources ?? {}), ...Object.keys(inc.sources ?? {})])) {
    const a = cur.sources?.[id];
    const b = inc.sources?.[id];
    sources[id] = a && b ? ((b.lastChecked || 0) > (a.lastChecked || 0) ? b : a) : (a ?? b)!;
  }
  return {
    ...inc,
    ...cur, // current wins for user-chosen fields below
    comickTitle: cur.comickTitle || inc.comickTitle,
    customTitle: cur.customTitle ?? inc.customTitle,
    selectedSource: cur.selectedSource || inc.selectedSource,
    alternateTitles: cur.alternateTitles?.length ? cur.alternateTitles : inc.alternateTitles,
    sources,
  };
}

/**
 * Lifetime totals merge by max per field (min for firstTrackedAt). Max is the
 * safe choice: re-importing the same backup never inflates counts. Without
 * per-event data, cross-device sums can't be computed exactly, so max is a
 * deliberate, honest under-count rather than a double-count.
 */
function mergeTotals(cur: StatsTotals, inc: StatsTotals): StatsTotals {
  return {
    chaptersOpened: Math.max(cur.chaptersOpened || 0, inc.chaptersOpened || 0),
    chaptersRead: Math.max(cur.chaptersRead || 0, inc.chaptersRead || 0),
    activeSec: Math.max(cur.activeSec || 0, inc.activeSec || 0),
    firstTrackedAt: minPositive(cur.firstTrackedAt, inc.firstTrackedAt),
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

function unionNumbers(a?: number[], b?: number[]): number[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])].sort((x, y) => x - y);
}

/** Two-level record merge; `primary` inner entries win over `secondary`. */
function mergeTwoLevel<T>(
  primary: Record<string, Record<string, T>> = {},
  secondary: Record<string, Record<string, T>> = {}
): Record<string, Record<string, T>> {
  const out: Record<string, Record<string, T>> = {};
  for (const key of new Set([...Object.keys(secondary), ...Object.keys(primary)])) {
    out[key] = { ...(secondary[key] ?? {}), ...(primary[key] ?? {}) };
  }
  return out;
}

function minPositive(a?: number, b?: number): number {
  const vals = [a, b].filter((n): n is number => typeof n === 'number' && n > 0);
  return vals.length ? Math.min(...vals) : (a || b || 0);
}
