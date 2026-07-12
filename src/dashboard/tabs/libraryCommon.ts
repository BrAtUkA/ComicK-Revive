import { readingStateManager, sourceMappingManager, libraryManager, effectiveStatus } from '@/core';
import type { LibraryMeta, LibraryStatus } from '@/core';
import type { MangaReadingState, MangaSourceMapping } from '@/types';
import { bridgeGetCachedChapters, bridgeInvalidateChapters } from '@/utils/bridge';
import { sourceRegistry } from '@/sources';
import { titleFromSlug } from '@/shared/fmt';
import { parseStandaloneSlug } from '@/shared/standalone';
import { buildModal } from '../modal';
import { openReader } from '../reader';

/**
 * Shared data assembly + actions for the Library tab and its details view.
 */

export interface LibraryEntry {
  slug: string;
  state: MangaReadingState;
  mapping: MangaSourceMapping | null;
  meta: LibraryMeta;
  title: string;
  readCount: number;
  /** Known chapter total; undefined until a list was ever fetched */
  total: number | undefined;
  status: LibraryStatus;
}

export const STATUS_LABELS: Record<LibraryStatus, string> = {
  reading: 'Reading',
  completed: 'Completed',
  onhold: 'On hold',
  dropped: 'Dropped',
};

export const STATUS_ORDER: LibraryStatus[] = ['reading', 'completed', 'onhold', 'dropped'];

export function entryTitle(mapping: MangaSourceMapping | null, slug: string): string {
  if (mapping?.customTitle || mapping?.comickTitle) {
    return mapping.customTitle || mapping.comickTitle;
  }
  // Unmapped standalone slug: prettify the source's own slug, not the
  // whole ~sourceId~slug synthetic form
  const parsed = parseStandaloneSlug(slug);
  return titleFromSlug(parsed?.sourceSlug ?? slug);
}

export function selectedSourceOf(mapping: MangaSourceMapping | null): { sourceId: string; sourceSlug: string } | null {
  const sourceId = mapping?.selectedSource;
  const sourceSlug = sourceId ? mapping?.sources[sourceId]?.slug : undefined;
  return sourceId && sourceSlug ? { sourceId, sourceSlug } : null;
}

/** Everything with reading progress, joined with mappings and library meta. */
export async function loadLibraryEntries(): Promise<LibraryEntry[]> {
  // Meta may have been written from the reader on comick.dev since our last
  // read; the map is one key, so re-reading is cheap
  libraryManager.invalidateCache();

  const [withProgress, mappings, metaMap] = await Promise.all([
    readingStateManager.getAllWithProgress(),
    sourceMappingManager.getAll(),
    libraryManager.getAll(),
  ]);
  const mappingBySlug = new Map(mappings.map((m) => [m.comickSlug, m]));

  return withProgress.map(({ slug, state }) => {
    const mapping = mappingBySlug.get(slug) ?? null;
    const meta = metaMap[slug] ?? {};
    const readCount = state.readChapters?.length ?? 0;
    const total = meta.totalChapters;
    return {
      slug,
      state,
      mapping,
      meta,
      title: entryTitle(mapping, slug),
      readCount,
      total,
      status: effectiveStatus(meta, readCount, total),
    };
  });
}

/**
 * Fill in a missing chapter total from the (background) source-data cache.
 * Persists the number so the next library render has it synchronously.
 * Returns undefined when no list is cached.
 */
export async function backfillTotal(entry: LibraryEntry): Promise<number | undefined> {
  if (entry.total !== undefined) return entry.total;
  const sel = selectedSourceOf(entry.mapping);
  if (!sel) return undefined;
  try {
    const chapters = await bridgeGetCachedChapters(sel.sourceId, sel.sourceSlug);
    if (!chapters || chapters.length === 0) return undefined;
    const latest = Math.max(...chapters.map((c) => c.number ?? 0));
    entry.total = chapters.length;
    entry.status = effectiveStatus(entry.meta, entry.readCount, entry.total);
    void libraryManager.update(entry.slug, { totalChapters: chapters.length, latestChapter: latest });
    return chapters.length;
  } catch {
    return undefined;
  }
}

/** Resume reading in the dashboard reader at the saved position. */
export function resumeEntry(slug: string, title: string): void {
  openReader({ slug, title, pageType: 'manga', forceResume: true });
}

export function detailsHash(slug: string): string {
  return `#library/${encodeURIComponent(slug)}`;
}

/** Modal with a single text input, used for editing the display title. */
export function promptEditTitle(current: string, onSave: (title: string | null) => void): void {
  const { overlay, close } = buildModal('Edit title', `
    <p class="crd-panel-desc">Shown everywhere in the extension. Leave empty to go back to the original title.</p>
    <div class="crd-modal-row">
      <input type="text" class="crd-num crd-modal-url" id="crd-title-input" spellcheck="false">
      <button class="crd-btn crd-btn-primary" id="crd-title-save">Save</button>
    </div>
  `);
  const input = overlay.querySelector<HTMLInputElement>('#crd-title-input')!;
  input.value = current;
  input.focus();
  input.select();

  const save = () => {
    const value = input.value.trim();
    close();
    onSave(value || null);
  };
  overlay.querySelector('#crd-title-save')?.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
}

export interface UpdateCheckResult {
  checked: number;
  failed: number;
  /** Manga that gained chapters above what the user had seen */
  withNew: number;
}

/**
 * Manual update check: refetch chapter lists fresh (cache invalidated
 * first) and record new-chapter counts in library meta. Batched with low
 * concurrency and a pause between starts so sources aren't hammered.
 */
export async function checkForUpdates(
  entries: LibraryEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<UpdateCheckResult> {
  await sourceRegistry.loadUserSources();

  const jobs = entries
    .map((entry) => ({ entry, sel: selectedSourceOf(entry.mapping) }))
    .filter((j): j is { entry: LibraryEntry; sel: { sourceId: string; sourceSlug: string } } => j.sel !== null);

  const result: UpdateCheckResult = { checked: 0, failed: 0, withNew: 0 };
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < jobs.length) {
      const { entry, sel } = jobs[next++];
      try {
        const source = sourceRegistry.get(sel.sourceId);
        if (!source) throw new Error('source not installed');
        await bridgeInvalidateChapters(sel.sourceId, sel.sourceSlug);
        const chapters = await source.getChapterList(sel.sourceSlug);
        if (chapters.length === 0) throw new Error('empty chapter list');
        const latest = Math.max(...chapters.map((c) => c.number));
        const newAbove = entry.meta.knownLatest !== undefined
          ? chapters.filter((c) => c.number > entry.meta.knownLatest!).length
          : 0;
        const newCount = await libraryManager.recordCheck(entry.slug, latest, chapters.length, newAbove);
        result.checked++;
        if (newCount > 0) result.withNew++;
      } catch (error) {
        console.warn(`[Library] update check failed for ${entry.slug}:`, error);
        result.failed++;
      }
      done++;
      onProgress?.(done, jobs.length);
      // Small pause keeps burst rate polite even with cache-fast sources
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return result;
}

/** Confirmation modal; runs onConfirm only on the explicit confirm button. */
export function confirmModal(opts: {
  title: string;
  body: string;           // plain text
  confirmLabel: string;
  danger?: boolean;
  checkboxLabel?: string; // optional opt-in checkbox
  onConfirm: (checked: boolean) => void;
}): void {
  const { overlay, close } = buildModal(opts.title, `
    <p class="crd-panel-desc" id="crd-confirm-body"></p>
    ${opts.checkboxLabel ? `
      <label class="crd-confirm-check">
        <input type="checkbox" id="crd-confirm-check">
        <span id="crd-confirm-check-label"></span>
      </label>` : ''}
    <div class="crd-btn-row">
      <button class="crd-btn${opts.danger ? ' danger' : ' crd-btn-primary'}" id="crd-confirm-yes"></button>
      <button class="crd-btn" id="crd-confirm-no">Cancel</button>
    </div>
  `);
  overlay.querySelector<HTMLElement>('#crd-confirm-body')!.textContent = opts.body;
  overlay.querySelector<HTMLElement>('#crd-confirm-yes')!.textContent = opts.confirmLabel;
  if (opts.checkboxLabel) {
    overlay.querySelector<HTMLElement>('#crd-confirm-check-label')!.textContent = opts.checkboxLabel;
  }
  overlay.querySelector('#crd-confirm-no')?.addEventListener('click', close);
  overlay.querySelector('#crd-confirm-yes')?.addEventListener('click', () => {
    const checked = overlay.querySelector<HTMLInputElement>('#crd-confirm-check')?.checked ?? false;
    close();
    opts.onConfirm(checked);
  });
}
