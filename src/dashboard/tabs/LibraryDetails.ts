import { readingStateManager, sourceMappingManager, libraryManager, historyManager, effectiveStatus } from '@/core';
import type { LibraryStatus } from '@/core';
import type { Chapter, MangaSourceMapping } from '@/types';
import { bridgeInvalidateChapters, bridgeCacheClearManga } from '@/utils/bridge';
import { sourceRegistry } from '@/sources';
import { getCoverDataUrl } from '@/shared/covers';
import { isStandaloneSlug } from '@/shared/standalone';
import { timeAgo } from '@/shared/fmt';
import { showDashToast } from '../Dashboard';
import { showMenu } from '../menu';
import { buildDropdown } from '../dropdown';
import { openReader } from '../reader';
import {
  entryTitle, promptEditTitle, confirmModal, STATUS_LABELS, STATUS_ORDER,
} from './libraryCommon';

const COMICK_ORIGIN = 'https://comick.dev';
const CHAPTER_ORDER_KEY = 'crd_det_chapter_order';

const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const ORDER_ASC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10M11 9h7M11 13h4M5 5v14M5 19l-3-3M5 19l3-3"/></svg>`;
const ORDER_DESC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h4M11 9h7M11 13h10M5 19V5M5 5L2 8M5 5l3 3"/></svg>`;
const DOTS_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>`;
const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const BACK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const EXTERNAL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>`;

/**
 * Per-manga details view, routed as #library/<encoded slug>.
 * Header (cover, title, status, source, progress, actions) + full chapter
 * list with read tracking. Opening this view counts as having "seen" the
 * current chapter list, so it clears the library's new-chapters badge.
 */
export async function renderLibraryDetails(host: HTMLElement, slug: string): Promise<void> {
  host.innerHTML = `
    <a class="crd-details-back" href="#library">${BACK_SVG}<span>Library</span></a>
    <div id="crd-det-root"></div>
  `;
  const root = host.querySelector<HTMLElement>('#crd-det-root')!;

  libraryManager.invalidateCache();
  readingStateManager.invalidateCache(slug);
  const [state, mapping, meta] = await Promise.all([
    readingStateManager.get(slug),
    sourceMappingManager.get(slug),
    libraryManager.get(slug),
  ]);

  if (!state && !mapping) {
    root.innerHTML = `
      <div class="crd-empty">
        <h3>Not in your library</h3>
        <p>This manga has no saved progress or source link. It may have been removed.</p>
      </div>
    `;
    return;
  }

  const title = entryTitle(mapping, slug);
  const readSet = new Set(state?.readChapters ?? []);
  const sourceId = mapping?.selectedSource;
  const sourceSlug = sourceId ? mapping?.sources[sourceId]?.slug : undefined;

  // ── Header ────────────────────────────────────────────────────────────────

  const header = document.createElement('div');
  header.className = 'crd-det-header';

  const coverBox = document.createElement('div');
  coverBox.className = 'crd-det-cover';
  const coverLetter = document.createElement('span');
  coverLetter.className = 'crd-card-letter';
  coverLetter.textContent = title.slice(0, 1).toUpperCase();
  coverBox.appendChild(coverLetter);

  const info = document.createElement('div');
  info.className = 'crd-det-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'crd-det-title-row';
  const h1 = document.createElement('h1');
  h1.className = 'crd-det-title';
  h1.textContent = title;
  titleRow.appendChild(h1);
  if (mapping) {
    const editBtn = document.createElement('button');
    editBtn.className = 'crd-icon-btn';
    editBtn.title = 'Edit title';
    editBtn.innerHTML = PENCIL_SVG;
    editBtn.addEventListener('click', () => {
      promptEditTitle(h1.textContent ?? '', (t) => {
        void (async () => {
          await sourceMappingManager.setCustomTitle(slug, t);
          const fresh = await sourceMappingManager.get(slug);
          h1.textContent = entryTitle(fresh, slug);
          showDashToast('Title updated');
        })();
      });
    });
    titleRow.appendChild(editBtn);
  }
  info.appendChild(titleRow);

  // Author + description filled in lazily from cached source details
  const byline = document.createElement('div');
  byline.className = 'crd-det-byline';
  info.appendChild(byline);

  const metaRow = document.createElement('div');
  metaRow.className = 'crd-det-meta';
  info.appendChild(metaRow);

  const statusDd = buildDropdown({
    options: STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    value: effectiveStatus(meta, readSet.size, meta.totalChapters),
    title: 'Shelf status',
    onChange: (value) => {
      void libraryManager.setStatus(slug, value as LibraryStatus);
      showDashToast(`Moved to ${STATUS_LABELS[value as LibraryStatus]}`);
    },
  });
  metaRow.appendChild(statusDd.el);

  if (mapping && Object.keys(mapping.sources).length > 0) {
    metaRow.appendChild(buildSourceSelect(slug, mapping));
  }

  if (!isStandaloneSlug(slug)) {
    const link = document.createElement('a');
    link.className = 'crd-det-comick';
    link.href = `${COMICK_ORIGIN}/comic/${encodeURIComponent(slug)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.innerHTML = `${EXTERNAL_SVG}<span>Open on ComicK</span>`;
    metaRow.appendChild(link);
  }

  const progressLine = document.createElement('div');
  progressLine.className = 'crd-det-progress';
  info.appendChild(progressLine);

  const actions = document.createElement('div');
  actions.className = 'crd-btn-row crd-det-actions';
  info.appendChild(actions);

  const continueBtn = document.createElement('button');
  continueBtn.className = 'crd-btn crd-btn-primary crd-det-continue';
  continueBtn.innerHTML = `${PLAY_SVG}<span></span>`;
  continueBtn.querySelector('span')!.textContent = state
    ? `Continue · Ch. ${state.currentChapter}`
    : 'Start reading';
  continueBtn.addEventListener('click', () => {
    openReader({ slug, title: h1.textContent ?? title, pageType: 'manga', forceResume: true });
  });
  actions.appendChild(continueBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'crd-btn';
  refreshBtn.innerHTML = `${REFRESH_SVG}<span>Refresh chapters</span>`;
  actions.appendChild(refreshBtn);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'crd-btn';
  moreBtn.innerHTML = `${DOTS_SVG}<span>More</span>`;
  actions.appendChild(moreBtn);

  header.append(coverBox, info);
  root.appendChild(header);

  // ── Chapters ──────────────────────────────────────────────────────────────

  const chaptersBox = document.createElement('div');
  chaptersBox.className = 'crd-det-chapters';
  const chaptersHead = document.createElement('div');
  chaptersHead.className = 'crd-det-chapters-head';
  const chaptersTitle = document.createElement('h3');
  chaptersTitle.textContent = 'Chapters';
  const headActions = document.createElement('div');
  headActions.className = 'crd-det-head-actions';
  const orderBtn = document.createElement('button');
  orderBtn.className = 'crd-btn crd-btn-small';
  headActions.appendChild(orderBtn);
  chaptersHead.append(chaptersTitle, headActions);
  const chaptersList = document.createElement('div');
  chaptersList.className = 'crd-det-list';
  chaptersList.innerHTML = `<div class="crd-details-loading">Loading chapter list...</div>`;
  chaptersBox.append(chaptersHead, chaptersList);
  root.appendChild(chaptersBox);

  let chapters: Chapter[] = [];
  let chapterOrder: 'asc' | 'desc' = (localStorage.getItem(CHAPTER_ORDER_KEY) as 'asc' | 'desc') || 'asc';

  const applyOrderLabel = () => {
    orderBtn.innerHTML = `${chapterOrder === 'asc' ? ORDER_ASC_SVG : ORDER_DESC_SVG}<span>${chapterOrder === 'asc' ? 'Oldest first' : 'Newest first'}</span>`;
    orderBtn.title = 'Flip chapter order';
  };
  applyOrderLabel();

  const updateProgressLine = () => {
    const total = chapters.length || meta.totalChapters || 0;
    const read = readSet.size;
    const pct = total > 0 ? Math.min(100, Math.round((read / total) * 100)) : 0;
    progressLine.textContent = total > 0
      ? `${read} of ${total} read · ${pct}%${state?.lastRead ? ` · last read ${timeAgo(state.lastRead)}` : ''}`
      : (state?.lastRead ? `Last read ${timeAgo(state.lastRead)}` : '');
    chaptersTitle.textContent = total > 0 ? `Chapters (${total})` : 'Chapters';
  };
  updateProgressLine();

  const allNumbers = () => chapters.map((c) => c.number);

  const setRowRead = (row: HTMLElement, read: boolean) => {
    row.classList.toggle('read', read);
    const toggle = row.querySelector<HTMLElement>('.crd-det-check');
    if (toggle) toggle.title = read ? 'Mark unread' : 'Mark read';
  };

  const buildChapterRow = (ch: Chapter): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'crd-det-row';
    if (readSet.has(ch.number)) row.classList.add('read');
    if (state && ch.number === state.currentChapter) row.classList.add('current');

    const toggle = document.createElement('button');
    toggle.className = 'crd-det-check';
    toggle.innerHTML = CHECK_SVG;
    toggle.title = readSet.has(ch.number) ? 'Mark unread' : 'Mark read';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      void (async () => {
        if (readSet.has(ch.number)) {
          readSet.delete(ch.number);
          await readingStateManager.markChapterUnread(slug, ch.number);
        } else {
          readSet.add(ch.number);
          await readingStateManager.markChapterRead(slug, ch.number);
        }
        setRowRead(row, readSet.has(ch.number));
        updateProgressLine();
      })();
    });

    const main = document.createElement('div');
    main.className = 'crd-det-row-main';
    const num = document.createElement('span');
    num.className = 'crd-det-row-num';
    num.textContent = `Chapter ${ch.number}`;
    main.appendChild(num);
    if (ch.title && !/^chapter\s*[\d.]+$/i.test(ch.title.trim())) {
      const t = document.createElement('span');
      t.className = 'crd-det-row-title';
      t.textContent = ch.title;
      main.appendChild(t);
    }

    const side = document.createElement('div');
    side.className = 'crd-det-row-side';
    if (state && ch.number === state.currentChapter) {
      const chip = document.createElement('span');
      chip.className = 'crd-chip current';
      chip.textContent = 'Current';
      side.appendChild(chip);
    }
    if (ch.dateUpload > 0) {
      const date = document.createElement('span');
      date.className = 'crd-det-row-date';
      date.textContent = new Date(ch.dateUpload).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      side.appendChild(date);
    }

    row.append(toggle, main, side);
    row.addEventListener('click', () => {
      openReader({ slug, title: h1.textContent ?? title, pageType: 'manga', overrideChapter: ch.number });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Read this chapter', icon: PLAY_SVG, action: () => openReader({ slug, title: h1.textContent ?? title, pageType: 'manga', overrideChapter: ch.number }) },
        {
          label: 'Mark read up to here',
          separator: true,
          action: () => void (async () => {
            await readingStateManager.markChaptersUpToRead(slug, ch.number, allNumbers());
            await readingStateManager.markChapterRead(slug, ch.number);
            for (const n of allNumbers()) if (n <= ch.number) readSet.add(n);
            renderChapterRows();
            updateProgressLine();
          })(),
        },
        {
          label: 'Mark unread up to here',
          action: () => void (async () => {
            // Manager clears strictly-below; unread the chapter itself too
            await readingStateManager.markChaptersUpToUnread(slug, ch.number);
            await readingStateManager.markChapterUnread(slug, ch.number);
            for (const n of [...readSet]) if (n <= ch.number) readSet.delete(n);
            renderChapterRows();
            updateProgressLine();
          })(),
        },
      ]);
    });
    return row;
  };

  const renderChapterRows = () => {
    chaptersList.innerHTML = '';
    if (chapters.length === 0) {
      chaptersList.innerHTML = `<div class="crd-details-loading">No chapters found.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    const sorted = [...chapters].sort((a, b) => (chapterOrder === 'asc' ? a.number - b.number : b.number - a.number));
    for (const ch of sorted) {
      frag.appendChild(buildChapterRow(ch));
    }
    chaptersList.appendChild(frag);
  };

  orderBtn.addEventListener('click', () => {
    chapterOrder = chapterOrder === 'asc' ? 'desc' : 'asc';
    localStorage.setItem(CHAPTER_ORDER_KEY, chapterOrder);
    applyOrderLabel();
    renderChapterRows();
  });

  const loadChapters = async (fresh: boolean) => {
    if (!sourceId || !sourceSlug) {
      chaptersList.innerHTML = `
        <div class="crd-empty">
          <h3>No source linked</h3>
          <p>Open this manga on comick.dev and pick a source to load chapters.</p>
        </div>
      `;
      return;
    }
    try {
      await sourceRegistry.loadUserSources();
      const source = sourceRegistry.get(sourceId);
      if (!source) throw new Error(`Source "${sourceId}" is not installed`);
      if (fresh) await bridgeInvalidateChapters(sourceId, sourceSlug);
      chapters = await source.getChapterList(sourceSlug);

      // Viewing the list counts as seeing it: clears the new-chapters badge
      if (chapters.length > 0) {
        const latest = Math.max(...chapters.map((c) => c.number));
        const newAbove = meta.knownLatest !== undefined
          ? chapters.filter((c) => c.number > meta.knownLatest!).length
          : 0;
        if (fresh) await libraryManager.recordCheck(slug, latest, chapters.length, newAbove);
        await libraryManager.markSeen(slug, latest, chapters.length);
      }

      renderChapterRows();
      updateProgressLine();
      if (fresh) showDashToast('Chapter list refreshed');
    } catch (error) {
      chaptersList.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'crd-empty';
      const h = document.createElement('h3');
      h.textContent = 'Could not load chapters';
      const p = document.createElement('p');
      p.textContent = (error as Error).message;
      err.append(h, p);
      chaptersList.appendChild(err);
    }
  };

  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true;
    void loadChapters(true).finally(() => { refreshBtn.disabled = false; });
  });

  moreBtn.addEventListener('click', () => {
    const r = moreBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      {
        label: 'Mark all read',
        action: () => void (async () => {
          if (chapters.length === 0) return;
          // Finite bound: Infinity would not survive storage serialization
          await readingStateManager.markChaptersUpToRead(slug, Math.max(...allNumbers()) + 1, allNumbers());
          for (const n of allNumbers()) readSet.add(n);
          renderChapterRows();
          updateProgressLine();
        })(),
      },
      {
        label: 'Mark all unread',
        action: () => void (async () => {
          await readingStateManager.markAllUnread(slug);
          readSet.clear();
          renderChapterRows();
          updateProgressLine();
        })(),
      },
      {
        label: 'Clear cached images',
        separator: true,
        action: () => {
          if (!sourceId || !sourceSlug) return;
          confirmModal({
            title: 'Clear cached images',
            body: 'Removes this manga\'s downloaded pages and cover from the image cache. They re-download as you read.',
            confirmLabel: 'Clear',
            onConfirm: () => void (async () => {
              const removed = await bridgeCacheClearManga(sourceId, sourceSlug);
              showDashToast(`Cleared ${removed} cached ${removed === 1 ? 'image' : 'images'}`);
            })(),
          });
        },
      },
      {
        label: 'Remove from library',
        danger: true,
        separator: true,
        action: () => {
          confirmModal({
            title: 'Remove from library',
            body: `"${h1.textContent}" will lose its reading progress, shelf status, and history entries.`,
            confirmLabel: 'Remove',
            danger: true,
            checkboxLabel: 'Also unlink the source (forgets which site it reads from)',
            onConfirm: (alsoUnlink) => void (async () => {
              await readingStateManager.clear(slug);
              await libraryManager.remove(slug);
              await historyManager.removeForSlug(slug);
              if (alsoUnlink) await sourceMappingManager.remove(slug);
              showDashToast('Removed from library');
              window.location.hash = 'library';
            })(),
          });
        },
      },
    ]);
  });

  // Cover, byline, and chapter list resolve in parallel after first paint
  void loadChapters(false);
  void hydrateCover(coverBox, sourceId, sourceSlug);
  void hydrateByline(byline, sourceId, sourceSlug);
}

function buildSourceSelect(slug: string, mapping: MangaSourceMapping): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'crd-det-source';
  const caption = document.createElement('span');
  caption.textContent = 'Source';
  const dd = buildDropdown({
    options: Object.keys(mapping.sources).map((id) => ({
      value: id,
      label: sourceRegistry.get(id)?.name ?? id,
    })),
    value: mapping.selectedSource,
    title: 'Reading source',
    onChange: (value) => {
      void (async () => {
        await sourceMappingManager.setSelectedSource(slug, value);
        showDashToast('Source switched');
        // Chapter numbering and totals can differ per source; reload the view
        window.location.reload();
      })();
    },
  });
  wrap.append(caption, dd.el);
  return wrap;
}

async function hydrateCover(coverBox: HTMLElement, sourceId?: string, sourceSlug?: string): Promise<void> {
  if (!sourceId || !sourceSlug) return;
  const dataUrl = await getCoverDataUrl(sourceId, sourceSlug);
  if (!dataUrl) return;
  const img = document.createElement('img');
  img.alt = '';
  img.src = dataUrl;
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    coverBox.querySelector('.crd-card-letter')?.remove();
  }, { once: true });
  coverBox.prepend(img);
}

async function hydrateByline(byline: HTMLElement, sourceId?: string, sourceSlug?: string): Promise<void> {
  if (!sourceId || !sourceSlug) return;
  try {
    const source = sourceRegistry.get(sourceId);
    if (!source) return;
    const details = await source.getMangaDetails(sourceSlug);
    const bits: string[] = [];
    if (details.author) bits.push(details.author);
    if (details.status) bits.push(details.status);
    byline.textContent = bits.join(' · ');
    if (details.description) {
      const desc = document.createElement('p');
      desc.className = 'crd-det-desc';
      desc.textContent = details.description;
      byline.insertAdjacentElement('afterend', desc);
      if (details.description.length > 220) {
        desc.classList.add('clamped');
        desc.addEventListener('click', () => desc.classList.toggle('clamped'));
        desc.title = 'Click to expand';
      }
    }
  } catch { /* byline stays empty */ }
}
