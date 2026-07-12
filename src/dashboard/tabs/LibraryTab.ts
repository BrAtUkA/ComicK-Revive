import { sourceMappingManager, readingStateManager, libraryManager, historyManager, effectiveStatus } from '@/core';
import type { LibraryStatus } from '@/core';
import { getCoverDataUrl } from '@/shared/covers';
import { timeAgo } from '@/shared/fmt';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { showMenu, closeMenu } from '../menu';
import { buildDropdown } from '../dropdown';
import {
  loadLibraryEntries, backfillTotal, resumeEntry, detailsHash, selectedSourceOf,
  promptEditTitle, confirmModal, checkForUpdates, entryTitle,
  STATUS_LABELS, STATUS_ORDER, type LibraryEntry,
} from './libraryCommon';
import { renderLibraryDetails } from './LibraryDetails';

const COMICK_ORIGIN = 'https://comick.dev';
const SORT_KEY = 'crd_lib_sort';
const STATUS_KEY = 'crd_lib_status';

type SortMode = 'lastread' | 'updated' | 'title' | 'progress';
type StatusFilter = 'all' | LibraryStatus;

const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const DOTS_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>`;
const INFO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8.2v.1"/></svg>`;
const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`;
const SHELF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

/**
 * Library — every manga with reading progress.
 *
 * Structure (decided 2026-07-06): toolbar (search / sort / update check),
 * status shelf chips, a "Jump back in" resume row, and the full cover grid.
 * Card click opens the in-dashboard details view (#library/<slug>); the
 * hover play button and the resume row jump straight into the reader.
 */
export class LibraryTab implements DashboardTab {
  id = 'library';
  label = 'Library';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`;

  private onCount?: (n: number) => void;
  private entries: LibraryEntry[] = [];
  private body: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private query = '';
  private sort: SortMode = (localStorage.getItem(SORT_KEY) as SortMode) || 'lastread';
  private statusFilter: StatusFilter = (localStorage.getItem(STATUS_KEY) as StatusFilter) || 'all';
  private checking = false;
  /** Covers already resolved this dashboard session (slug → data URL) */
  private coverCache = new Map<string, string | null>();

  constructor(onCount?: (n: number) => void) {
    this.onCount = onCount;
  }

  async mount(host: HTMLElement, sub?: string): Promise<void> {
    if (sub) {
      await renderLibraryDetails(host, sub);
      return;
    }

    this.host = host;
    this.query = '';
    host.innerHTML = `
      <h1 class="crd-tab-head">Library</h1>
      <p class="crd-tab-sub">Everything you've been reading. Click a cover for details, hit play to keep reading.</p>
      <div class="crd-lib-toolbar">
        <div class="crd-search-box crd-lib-search">
          ${SEARCH_SVG}
          <input id="crd-lib-q" type="text" placeholder="Search your library" spellcheck="false" autocomplete="off">
        </div>
        <span id="crd-lib-sort-slot"></span>
        <button class="crd-btn" id="crd-lib-check" title="Refresh chapter lists from the sources">${REFRESH_SVG}<span>Check for updates</span></button>
      </div>
      <div class="crd-search-pills crd-lib-chips" id="crd-lib-chips"></div>
      <div id="crd-lib-body"></div>
    `;
    this.body = host.querySelector<HTMLElement>('#crd-lib-body');

    const q = host.querySelector<HTMLInputElement>('#crd-lib-q')!;
    let qTimer: ReturnType<typeof setTimeout> | null = null;
    q.addEventListener('input', () => {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        this.query = q.value.trim().toLowerCase();
        this.renderChips();
        this.renderBody();
      }, 140);
    });

    const sortDd = buildDropdown({
      options: [
        { value: 'lastread', label: 'Last read' },
        { value: 'updated', label: 'Recently updated' },
        { value: 'title', label: 'Title A to Z' },
        { value: 'progress', label: 'Progress' },
      ],
      value: this.sort,
      title: 'Sort order',
      onChange: (value) => {
        this.sort = value as SortMode;
        localStorage.setItem(SORT_KEY, this.sort);
        this.renderBody();
      },
    });
    host.querySelector('#crd-lib-sort-slot')?.replaceWith(sortDd.el);

    host.querySelector<HTMLButtonElement>('#crd-lib-check')?.addEventListener('click', () => void this.runUpdateCheck());

    this.entries = await loadLibraryEntries();
    this.onCount?.(this.entries.length);

    if (this.entries.length === 0) {
      host.querySelector('.crd-lib-toolbar')?.remove();
      host.querySelector('.crd-lib-chips')?.remove();
      this.renderEmptyLibrary();
      return;
    }

    this.renderChips();
    this.renderBody();
  }

  unmount(): void {
    closeMenu();
    this.body = null;
    this.host = null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private renderEmptyLibrary(): void {
    if (!this.body) return;
    this.body.innerHTML = `
      <div class="crd-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>
        <h3>Nothing here yet</h3>
        <p>Your library builds itself as you read.<br>Find something in <a href="#search">Search</a>, or open a manga on <a href="${COMICK_ORIGIN}" target="_blank" rel="noopener">comick.dev</a> and hit Start Reading.</p>
        <p class="crd-empty-restore">Restoring after an update or reinstall? <a href="#settings">Import a backup</a> in Settings &gt; Data.</p>
      </div>
    `;
  }

  private renderChips(): void {
    const hostEl = this.host?.querySelector<HTMLElement>('#crd-lib-chips');
    if (!hostEl) return;

    const matching = this.matchingQuery();
    const counts = new Map<StatusFilter, number>([['all', matching.length]]);
    for (const s of STATUS_ORDER) {
      counts.set(s, matching.filter((e) => e.status === s).length);
    }

    hostEl.innerHTML = '';
    const filters: StatusFilter[] = ['all', ...STATUS_ORDER];
    for (const f of filters) {
      const btn = document.createElement('button');
      btn.className = `crd-pill${this.statusFilter === f ? ' active' : ''}`;
      const label = document.createElement('span');
      label.textContent = f === 'all' ? 'All' : STATUS_LABELS[f];
      const count = document.createElement('span');
      count.className = 'crd-pill-count';
      count.textContent = String(counts.get(f) ?? 0);
      btn.append(label, count);
      btn.addEventListener('click', () => {
        this.statusFilter = f;
        localStorage.setItem(STATUS_KEY, f);
        this.renderChips();
        this.renderBody();
      });
      hostEl.appendChild(btn);
    }
  }

  private matchingQuery(): LibraryEntry[] {
    if (!this.query) return this.entries;
    return this.entries.filter((e) => {
      const haystack = [
        e.title,
        e.mapping?.comickTitle ?? '',
        e.mapping?.customTitle ?? '',
        ...(e.mapping?.alternateTitles ?? []),
        e.slug,
      ].join('\n').toLowerCase();
      return haystack.includes(this.query);
    });
  }

  private filtered(): LibraryEntry[] {
    const matching = this.matchingQuery();
    const shelved = this.statusFilter === 'all' ? matching : matching.filter((e) => e.status === this.statusFilter);
    const byLastRead = (a: LibraryEntry, b: LibraryEntry) => (b.state.lastRead || 0) - (a.state.lastRead || 0);
    switch (this.sort) {
      case 'title':
        return [...shelved].sort((a, b) => a.title.localeCompare(b.title));
      case 'updated':
        return [...shelved].sort((a, b) => ((b.meta.lastNewAt ?? 0) - (a.meta.lastNewAt ?? 0)) || byLastRead(a, b));
      case 'progress': {
        const pct = (e: LibraryEntry) => (e.total ? e.readCount / e.total : -1);
        return [...shelved].sort((a, b) => (pct(b) - pct(a)) || byLastRead(a, b));
      }
      default:
        return [...shelved].sort(byLastRead);
    }
  }

  private renderBody(): void {
    if (!this.body) return;
    this.body.innerHTML = '';

    const list = this.filtered();

    // Resume row: only on the unfiltered view, where "jump back in" makes sense
    if (!this.query && this.statusFilter === 'all') {
      const inProgress = this.entries
        .filter((e) => e.status === 'reading' && e.state.lastRead)
        .sort((a, b) => (b.state.lastRead || 0) - (a.state.lastRead || 0))
        .slice(0, 4);
      if (inProgress.length > 0) {
        const label = document.createElement('div');
        label.className = 'crd-section-label';
        label.textContent = 'Jump back in';
        const row = document.createElement('div');
        row.className = 'crd-lib-resume';
        for (const entry of inProgress) row.appendChild(this.buildResumeCard(entry));
        this.body.append(label, row);
      }
    }

    const label = document.createElement('div');
    label.className = 'crd-section-label';
    label.textContent = this.query
      ? `Matches (${list.length})`
      : this.statusFilter === 'all' ? 'All manga' : STATUS_LABELS[this.statusFilter];
    this.body.appendChild(label);

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'crd-empty';
      empty.innerHTML = `<h3>Nothing here</h3><p></p>`;
      empty.querySelector('p')!.textContent = this.query
        ? 'No titles match that search.'
        : `Nothing on the ${STATUS_LABELS[this.statusFilter as LibraryStatus]} shelf yet. Set a status from a card's menu.`;
      this.body.appendChild(empty);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'crd-lib-grid';
    for (const entry of list) {
      grid.appendChild(this.buildCard(entry));
    }
    this.body.appendChild(grid);
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  private buildResumeCard(entry: LibraryEntry): HTMLElement {
    const card = document.createElement('button');
    card.className = 'crd-resume-card';
    card.title = `Continue chapter ${entry.state.currentChapter}`;

    const cover = document.createElement('div');
    cover.className = 'crd-resume-cover';
    const letter = document.createElement('span');
    letter.className = 'crd-resume-letter';
    letter.textContent = entry.title.slice(0, 1).toUpperCase();
    cover.appendChild(letter);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'crd-resume-body';
    const title = document.createElement('div');
    title.className = 'crd-resume-title';
    title.textContent = entry.title;
    const meta = document.createElement('div');
    meta.className = 'crd-resume-meta';
    meta.textContent = `Ch. ${entry.state.currentChapter}${entry.state.lastRead ? ` · ${timeAgo(entry.state.lastRead)}` : ''}`;
    bodyEl.append(title, meta);

    const play = document.createElement('span');
    play.className = 'crd-resume-play';
    play.innerHTML = PLAY_SVG;

    card.append(cover, bodyEl, play);
    card.addEventListener('click', () => resumeEntry(entry.slug, entry.title));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openEntryMenu(entry, e.clientX, e.clientY);
    });

    void this.hydrateCover(cover, entry);
    return card;
  }

  private buildCard(entry: LibraryEntry): HTMLElement {
    const card = document.createElement('a');
    card.className = 'crd-card';
    card.href = detailsHash(entry.slug);
    card.title = entry.title;

    const cover = document.createElement('div');
    cover.className = 'crd-card-cover';
    const letter = document.createElement('div');
    letter.className = 'crd-card-letter';
    letter.textContent = entry.title.slice(0, 1).toUpperCase();
    cover.appendChild(letter);

    if ((entry.meta.newCount ?? 0) > 0) {
      const badge = document.createElement('span');
      badge.className = 'crd-card-new';
      badge.textContent = `+${entry.meta.newCount}`;
      badge.title = `${entry.meta.newCount} new ${entry.meta.newCount === 1 ? 'chapter' : 'chapters'}`;
      cover.appendChild(badge);
    }

    const play = document.createElement('button');
    play.className = 'crd-card-play';
    play.title = `Continue chapter ${entry.state.currentChapter}`;
    play.innerHTML = PLAY_SVG;
    play.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resumeEntry(entry.slug, entry.title);
    });
    cover.appendChild(play);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'crd-card-menu';
    menuBtn.title = 'More actions';
    menuBtn.innerHTML = DOTS_SVG;
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      this.openEntryMenu(entry, r.left, r.bottom + 4);
    });
    cover.appendChild(menuBtn);

    const progress = document.createElement('div');
    progress.className = 'crd-card-progress';
    progress.hidden = true;
    progress.appendChild(document.createElement('span'));

    // Title lives below the cover: readable on any artwork
    const title = document.createElement('div');
    title.className = 'crd-card-title';
    title.textContent = entry.title;

    const meta = document.createElement('div');
    meta.className = 'crd-card-meta';
    const chip = document.createElement('span');
    chip.className = 'crd-chip';
    chip.textContent = `Ch. ${entry.state.currentChapter}`;
    const when = document.createElement('span');
    when.className = 'crd-card-when';
    if (entry.status !== 'reading') {
      const dot = document.createElement('span');
      dot.className = `crd-card-dot ${entry.status}`;
      dot.title = STATUS_LABELS[entry.status];
      when.appendChild(dot);
    }
    when.appendChild(document.createTextNode(entry.state.lastRead ? timeAgo(entry.state.lastRead) : ''));
    meta.append(chip, when);

    card.append(cover, progress, title, meta);

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openEntryMenu(entry, e.clientX, e.clientY);
    });

    this.applyProgress(progress, entry);
    void this.hydrateCard(card, cover, progress, entry);
    return card;
  }

  private applyProgress(bar: HTMLElement, entry: LibraryEntry): void {
    if (!entry.total || entry.total <= 0) return;
    const pct = Math.min(100, Math.round((entry.readCount / entry.total) * 100));
    bar.hidden = false;
    bar.querySelector('span')!.style.width = `${pct}%`;
  }

  private async hydrateCard(card: HTMLElement, cover: HTMLElement, progress: HTMLElement, entry: LibraryEntry): Promise<void> {
    if (entry.total === undefined) {
      await backfillTotal(entry);
      if (card.isConnected) this.applyProgress(progress, entry);
    }
    await this.hydrateCover(cover, entry);
  }

  /** Cover image with letter fallback; resolved data URLs cached per session */
  private async hydrateCover(cover: HTMLElement, entry: LibraryEntry): Promise<void> {
    let dataUrl = this.coverCache.get(entry.slug);
    if (dataUrl === undefined) {
      const sel = selectedSourceOf(entry.mapping);
      dataUrl = sel ? await getCoverDataUrl(sel.sourceId, sel.sourceSlug) : null;
      this.coverCache.set(entry.slug, dataUrl);
    }
    // No isConnected guard here: on a cache hit this runs synchronously,
    // before the card is appended to the grid, so the element is never
    // connected yet. Hydrating a card that ends up discarded is harmless.
    if (!dataUrl) return;

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = dataUrl;
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      // The letter placeholder paints above the in-flow img; drop it once
      // the cover is showing
      cover.querySelector('.crd-card-letter, .crd-resume-letter')?.remove();
    }, { once: true });
    cover.prepend(img);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private openEntryMenu(entry: LibraryEntry, x: number, y: number): void {
    showMenu(x, y, [
      { label: 'Continue reading', icon: PLAY_SVG, action: () => resumeEntry(entry.slug, entry.title) },
      { label: 'Details', icon: INFO_SVG, action: () => { window.location.hash = detailsHash(entry.slug); } },
      { label: 'Set status', icon: SHELF_SVG, separator: true, action: () => this.openStatusMenu(entry, x, y) },
      ...(entry.mapping ? [{ label: 'Edit title', icon: PENCIL_SVG, action: () => this.editTitle(entry) }] : []),
      { label: 'Remove from library', icon: TRASH_SVG, danger: true, separator: true, action: () => this.removeEntry(entry) },
    ]);
  }

  private openStatusMenu(entry: LibraryEntry, x: number, y: number): void {
    showMenu(x, y, STATUS_ORDER.map((s) => ({
      label: STATUS_LABELS[s],
      icon: entry.status === s ? CHECK_SVG : undefined,
      action: () => void this.setStatus(entry, s),
    })));
  }

  private async setStatus(entry: LibraryEntry, status: LibraryStatus): Promise<void> {
    await libraryManager.setStatus(entry.slug, status);
    entry.meta.status = status;
    entry.status = effectiveStatus(entry.meta, entry.readCount, entry.total);
    this.renderChips();
    this.renderBody();
    showDashToast(`Moved to ${STATUS_LABELS[status]}`);
  }

  private editTitle(entry: LibraryEntry): void {
    promptEditTitle(entry.title, (title) => {
      void (async () => {
        await sourceMappingManager.setCustomTitle(entry.slug, title);
        entry.mapping = await sourceMappingManager.get(entry.slug);
        entry.title = entryTitle(entry.mapping, entry.slug);
        this.renderBody();
        showDashToast('Title updated');
      })();
    });
  }

  private removeEntry(entry: LibraryEntry): void {
    confirmModal({
      title: 'Remove from library',
      body: `"${entry.title}" will lose its reading progress, shelf status, and history entries.`,
      confirmLabel: 'Remove',
      danger: true,
      checkboxLabel: 'Also unlink the source (forgets which site it reads from)',
      onConfirm: (alsoUnlink) => {
        void (async () => {
          await readingStateManager.clear(entry.slug);
          await libraryManager.remove(entry.slug);
          await historyManager.removeForSlug(entry.slug);
          if (alsoUnlink) await sourceMappingManager.remove(entry.slug);
          this.entries = this.entries.filter((e) => e.slug !== entry.slug);
          this.onCount?.(this.entries.length);
          if (this.entries.length === 0 && this.host) {
            await this.mount(this.host);
          } else {
            this.renderChips();
            this.renderBody();
          }
          showDashToast('Removed from library');
        })();
      },
    });
  }

  private async runUpdateCheck(): Promise<void> {
    if (this.checking || !this.host) return;
    this.checking = true;
    const btn = this.host.querySelector<HTMLButtonElement>('#crd-lib-check');
    const labelEl = btn?.querySelector('span');
    if (btn) btn.disabled = true;

    try {
      const result = await checkForUpdates(this.entries, (done, total) => {
        if (labelEl) labelEl.textContent = `Checking ${done}/${total}`;
      });
      this.entries = await loadLibraryEntries();
      this.renderChips();
      this.renderBody();

      let message = result.withNew > 0
        ? `New chapters in ${result.withNew} series`
        : 'Everything is up to date';
      if (result.failed > 0) message += ` (${result.failed} failed)`;
      showDashToast(message);
    } finally {
      this.checking = false;
      if (btn) btn.disabled = false;
      if (labelEl) labelEl.textContent = 'Check for updates';
    }
  }
}
