import { historyManager, sourceMappingManager, readingStateManager, dayKey } from '@/core';
import type { HistoryEntry } from '@/core';
import type { MangaSourceMapping, MangaReadingState } from '@/types';
import { sourceRegistry } from '@/sources';
import { getCoverDataUrl } from '@/shared/covers';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { openReader } from '../reader';
import { entryTitle, selectedSourceOf, confirmModal } from './libraryCommon';

const PAGE_SIZE = 100;

/** Consecutive entries of the same manga within this gap render as one session row */
const GROUP_GAP_MS = 60 * 60_000;

const SEARCH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>`;
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const CHEVRON_DOWN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

/**
 * History — chronological timeline of chapter opens, grouped by day.
 * Consecutive chapters of the same manga (gaps under an hour) collapse into
 * one session row that expands to its individual chapters. Entries are
 * written by the reader from the day this feature shipped; older activity is
 * seeded once from the stats daily aggregates as coarse "session" rows.
 */
export class HistoryTab implements DashboardTab {
  id = 'history';
  label = 'History';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;

  private entries: HistoryEntry[] = [];
  private mappingBySlug = new Map<string, MangaSourceMapping>();
  private stateBySlug = new Map<string, MangaReadingState>();
  private query = '';
  private shown = PAGE_SIZE;
  private listEl: HTMLElement | null = null;
  private coverCache = new Map<string, string | null>();
  /** Expanded session rows, keyed by slug + oldest entry timestamp */
  private expanded = new Set<string>();

  async mount(host: HTMLElement): Promise<void> {
    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">History</h1>
        <p class="crd-tab-sub">Every chapter you've opened, newest first. Click a row to pick up where it happened.</p>
        <div class="crd-lib-toolbar">
          <div class="crd-search-box crd-lib-search">
            ${SEARCH_SVG}
            <input id="crd-hist-q" type="text" placeholder="Search history" spellcheck="false" autocomplete="off">
          </div>
          <button class="crd-btn danger" id="crd-hist-clear">Clear history</button>
        </div>
        <div id="crd-hist-list"></div>
      </div>
    `;
    this.listEl = host.querySelector<HTMLElement>('#crd-hist-list');
    this.query = '';
    this.shown = PAGE_SIZE;

    const q = host.querySelector<HTMLInputElement>('#crd-hist-q')!;
    let qTimer: ReturnType<typeof setTimeout> | null = null;
    q.addEventListener('input', () => {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        this.query = q.value.trim().toLowerCase();
        this.shown = PAGE_SIZE;
        this.renderList();
      }, 140);
    });

    host.querySelector('#crd-hist-clear')?.addEventListener('click', () => {
      confirmModal({
        title: 'Clear history',
        body: 'Wipes the whole reading timeline. Your library and reading positions are not affected.',
        confirmLabel: 'Clear history',
        danger: true,
        onConfirm: () => void (async () => {
          await historyManager.clear();
          this.entries = [];
          this.renderList();
          showDashToast('History cleared');
        })(),
      });
    });

    await historyManager.seedFromStatsIfNeeded();
    const [entries, mappings, withProgress] = await Promise.all([
      historyManager.getAll(),
      sourceMappingManager.getAll(),
      readingStateManager.getAllWithProgress(),
    ]);
    this.mappingBySlug = new Map(mappings.map((m) => [m.comickSlug, m]));
    this.stateBySlug = new Map(withProgress.map((s) => [s.slug, s.state]));

    // Hide orphans: entries for manga removed before removal started
    // purging history (no source link, no progress, so no readable title)
    const known = new Set(withProgress.map((s) => s.slug));
    this.entries = entries.filter((e) => known.has(e.slug) || this.mappingBySlug.has(e.slug));
    this.renderList();
  }

  unmount(): void {
    this.listEl = null;
  }

  private titleFor(slug: string): string {
    return entryTitle(this.mappingBySlug.get(slug) ?? null, slug);
  }

  private filtered(): HistoryEntry[] {
    if (!this.query) return this.entries;
    return this.entries.filter((e) => this.titleFor(e.slug).toLowerCase().includes(this.query));
  }

  /**
   * Collapse the newest-first entry list into session runs: consecutive
   * entries of the same manga on the same day with no break over an hour.
   * A refresh or a quick close and reopen never splits a session; switching
   * manga or taking a real break does.
   */
  private groupEntries(list: HistoryEntry[]): HistoryEntry[][] {
    const groups: HistoryEntry[][] = [];
    for (const e of list) {
      const cur = groups[groups.length - 1];
      if (cur) {
        const prev = cur[cur.length - 1]; // oldest so far; newer than e
        const sameRun =
          !e.seeded && !prev.seeded &&
          e.chapter >= 0 && prev.chapter >= 0 &&
          e.slug === prev.slug &&
          dayKey(new Date(e.at)) === dayKey(new Date(prev.at)) &&
          prev.at - e.at <= GROUP_GAP_MS;
        if (sameRun) {
          cur.push(e);
          continue;
        }
      }
      groups.push([e]);
    }
    return groups;
  }

  private renderList(): void {
    const listEl = this.listEl;
    if (!listEl) return;
    listEl.innerHTML = '';

    const list = this.filtered();
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'crd-empty';
      empty.innerHTML = `<h3></h3><p></p>`;
      empty.querySelector('h3')!.textContent = this.query ? 'Nothing found' : 'No history yet';
      empty.querySelector('p')!.textContent = this.query
        ? 'No titles match that search.'
        : 'Open a chapter and it shows up here.';
      listEl.appendChild(empty);
      return;
    }

    // Per-day stats over the whole filtered list (not just the visible page)
    const dayStats = new Map<string, { chapters: number; series: Set<string> }>();
    for (const e of list) {
      const day = dayKey(new Date(e.at));
      const s = dayStats.get(day) ?? { chapters: 0, series: new Set<string>() };
      if (e.chapter >= 0) s.chapters++;
      s.series.add(e.slug);
      dayStats.set(day, s);
    }

    const groups = this.groupEntries(list);
    const visible = groups.slice(0, this.shown);
    let currentDay = '';
    const frag = document.createDocumentFragment();

    for (const group of visible) {
      const newest = group[0];
      const day = dayKey(new Date(newest.at));
      if (day !== currentDay) {
        currentDay = day;
        const label = document.createElement('div');
        label.className = 'crd-section-label';
        const stats = dayStats.get(day)!;
        const bits = [this.dayLabel(newest.at)];
        if (stats.chapters > 0) bits.push(`${stats.chapters} ${stats.chapters === 1 ? 'chapter' : 'chapters'}`);
        bits.push(`${stats.series.size} series`);
        label.textContent = bits.join(' · ');
        frag.appendChild(label);
      }
      frag.appendChild(group.length === 1 ? this.buildRow(group[0]) : this.buildGroupRow(group));
    }

    listEl.appendChild(frag);

    if (groups.length > this.shown) {
      const more = document.createElement('button');
      more.className = 'crd-btn crd-hist-more';
      more.textContent = `Show more (${groups.length - this.shown} left)`;
      more.addEventListener('click', () => {
        this.shown += PAGE_SIZE;
        this.renderList();
      });
      listEl.appendChild(more);
    }
  }

  private dayLabel(at: number): string {
    const d = new Date(at);
    const key = dayKey(d);
    if (key === dayKey()) return 'Today';
    if (key === dayKey(new Date(Date.now() - 86_400_000))) return 'Yesterday';
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  private timeLabel(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Finished per this session's own data: an explicit finish event from the
   * reader or the recorded page reaching the total. Never the library read
   * list, which under "Read on Open" flags every chapter the moment it loads.
   */
  private isFinished(e: HistoryEntry): boolean {
    if (e.fin === true) return true;
    const p = this.progressOf(e);
    return !!p && p.page >= p.pages;
  }

  /** Session progress: recorded on the entry, saved position as fallback */
  private progressOf(e: HistoryEntry): { page: number; pages: number } | null {
    let page = e.page;
    let pages = e.pages;
    if (page === undefined) {
      const sourceId = this.mappingBySlug.get(e.slug)?.selectedSource;
      const state = this.stateBySlug.get(e.slug);
      if (sourceId) {
        const pos = state?.chapterPositions?.[sourceId]?.[e.chapter];
        if (pos) page = pos.anchorImageIndex + 1;
        pages = pages ?? state?.chapterPageCounts?.[sourceId]?.[e.chapter];
      }
    }
    return page !== undefined && pages ? { page, pages } : null;
  }

  private chip(text: string, variant?: 'accent' | 'done'): HTMLElement {
    const el = document.createElement('span');
    el.className = `crd-hist-chip${variant ? ` ${variant}` : ''}`;
    el.textContent = text;
    return el;
  }

  /** Quiet text element for the info cluster (no box) */
  private txt(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'crd-hist-txt';
    el.textContent = text;
    return el;
  }

  private readChip(): HTMLElement {
    const done = this.chip('Read', 'done');
    done.insertAdjacentHTML('afterbegin', CHECK_SVG);
    done.title = 'Chapter finished';
    return done;
  }

  private progNode(page: number, pages: number): HTMLElement {
    const prog = document.createElement('span');
    prog.className = 'crd-hist-prog';
    prog.title = `Reached page ${page} of ${pages}`;
    const bar = document.createElement('span');
    bar.className = 'crd-hist-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.round((page / pages) * 100))}%`;
    bar.appendChild(fill);
    const label = document.createElement('span');
    label.textContent = `${page}/${pages}`;
    prog.append(bar, label);
    return prog;
  }

  private sourceNameOf(slug: string): string | null {
    const sourceId = this.mappingBySlug.get(slug)?.selectedSource;
    return sourceId ? (sourceRegistry.get(sourceId)?.name ?? sourceId) : null;
  }

  /**
   * Fixed-width fact columns so every row lines up vertically: source,
   * active minutes, progress-or-read state, chapter tag. Empty slots keep
   * their width instead of collapsing.
   */
  private factsCluster(opts: {
    source: string | null;
    sec: number;
    finished: boolean;
    prog: { page: number; pages: number } | null;
    chapterLabel: string;
    durTitle: string;
  }): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'crd-hist-chips';

    const src = this.txt(opts.source ?? '');
    src.classList.add('crd-hist-src');
    if (opts.source) src.title = opts.source;
    wrap.appendChild(src);

    const dur = this.txt(opts.sec >= 60 ? `${Math.round(opts.sec / 60)}m` : '');
    dur.classList.add('crd-hist-dur');
    if (opts.sec >= 60) dur.title = opts.durTitle;
    wrap.appendChild(dur);

    // One shared slot for either the page bar or the Read state, so the
    // chapter tag never shifts between finished and unfinished rows
    const state = document.createElement('span');
    state.className = 'crd-hist-state';
    if (opts.finished) state.appendChild(this.readChip());
    else if (opts.prog) state.appendChild(this.progNode(opts.prog.page, opts.prog.pages));
    wrap.appendChild(state);

    const ch = this.chip(opts.chapterLabel, 'accent');
    ch.classList.add('crd-hist-ch');
    wrap.appendChild(ch);

    return wrap;
  }

  /** Session facts for a single-chapter row */
  private buildChips(entry: HistoryEntry): HTMLElement {
    if (entry.chapter < 0) {
      // Seeded from stats: the day is known, the chapter is not; show where
      // the manga picks up instead
      const wrap = document.createElement('div');
      wrap.className = 'crd-hist-chips';
      const sourceName = this.sourceNameOf(entry.slug);
      if (sourceName) wrap.appendChild(this.txt(sourceName));
      const state = this.stateBySlug.get(entry.slug);
      if (state) wrap.appendChild(this.chip(`resumes at Ch. ${state.currentChapter}`, 'accent'));
      return wrap;
    }
    const finished = this.isFinished(entry);
    return this.factsCluster({
      source: this.sourceNameOf(entry.slug),
      sec: entry.sec ?? 0,
      finished,
      prog: finished ? null : this.progressOf(entry),
      chapterLabel: `Ch. ${entry.chapter}`,
      durTitle: 'Active reading time in this chapter that day',
    });
  }

  /** Session facts rolled up over a run of chapters */
  private buildGroupChips(group: HistoryEntry[]): HTMLElement {
    const totalSec = group.reduce((sum, e) => sum + (e.sec ?? 0), 0);
    // Bar of the newest unfinished chapter; a fully finished run gets the
    // Read state for the whole session instead
    const unfinished = group.find((e) => !this.isFinished(e));
    const numbers = group.map((e) => e.chapter);
    const lo = Math.min(...numbers);
    const hi = Math.max(...numbers);
    return this.factsCluster({
      source: this.sourceNameOf(group[0].slug),
      sec: totalSec,
      finished: !unfinished,
      prog: unfinished ? this.progressOf(unfinished) : null,
      chapterLabel: `Ch. ${lo}-${hi}`,
      durTitle: 'Active reading time in this session',
    });
  }

  private makeThumb(title: string): HTMLElement {
    const thumb = document.createElement('div');
    thumb.className = 'crd-hist-thumb';
    const letter = document.createElement('span');
    letter.textContent = title.slice(0, 1).toUpperCase();
    thumb.appendChild(letter);
    return thumb;
  }

  private buildRow(entry: HistoryEntry): HTMLElement {
    const title = this.titleFor(entry.slug);

    const row = document.createElement('button');
    row.className = 'crd-hist-row';
    row.title = entry.seeded
      ? 'From before per-chapter history existed. Click to resume from your saved position.'
      : entry.chapter >= 0 ? `Open chapter ${entry.chapter}` : 'Resume from last position';

    const thumb = this.makeThumb(title);

    const main = document.createElement('div');
    main.className = 'crd-hist-main';
    const t = document.createElement('div');
    t.className = 'crd-hist-title';
    t.textContent = title;
    main.appendChild(t);
    if (entry.seeded) {
      const under = document.createElement('div');
      under.className = 'crd-hist-under';
      under.textContent = 'session';
      main.appendChild(under);
    }

    const chips = this.buildChips(entry);

    const side = document.createElement('div');
    side.className = 'crd-hist-side';
    const time = document.createElement('span');
    time.className = 'crd-hist-time';
    time.textContent = entry.seeded ? '' : this.timeLabel(entry.at);
    const play = document.createElement('span');
    play.className = 'crd-hist-play';
    play.innerHTML = PLAY_SVG;
    side.append(time, play);

    row.append(thumb, main, chips, side);
    row.addEventListener('click', () => {
      if (entry.chapter >= 0) {
        openReader({ slug: entry.slug, title, pageType: 'manga', overrideChapter: entry.chapter });
      } else {
        openReader({ slug: entry.slug, title, pageType: 'manga', forceResume: true });
      }
    });

    void this.hydrateThumb(thumb, entry.slug);
    return row;
  }

  /** A session run: one row for the whole binge, expandable to its chapters */
  private buildGroupRow(group: HistoryEntry[]): HTMLElement {
    const newest = group[0];
    const oldest = group[group.length - 1];
    const title = this.titleFor(newest.slug);
    const key = `${newest.slug}|${oldest.at}`;

    const wrap = document.createElement('div');
    wrap.className = 'crd-hist-group';

    const row = document.createElement('button');
    row.className = 'crd-hist-row';
    row.title = `Continue with chapter ${newest.chapter}`;

    const thumb = this.makeThumb(title);

    const main = document.createElement('div');
    main.className = 'crd-hist-main';
    const t = document.createElement('div');
    t.className = 'crd-hist-title';
    t.textContent = title;
    main.appendChild(t);
    // The chapter-count subtitle doubles as the expand toggle: it names
    // exactly what unfolds, and keeps the right edge identical to single rows
    const under = document.createElement('span');
    under.className = 'crd-hist-under crd-hist-toggle';
    const underLabel = document.createElement('span');
    underLabel.textContent = `${group.length} chapters this session`;
    under.appendChild(underLabel);
    under.insertAdjacentHTML('beforeend', CHEVRON_DOWN_SVG);
    under.title = 'Show chapters';
    main.appendChild(under);

    const chips = this.buildGroupChips(group);

    const side = document.createElement('div');
    side.className = 'crd-hist-side';
    const time = document.createElement('span');
    time.className = 'crd-hist-time';
    time.textContent = this.timeLabel(newest.at);
    time.title = `Session from ${this.timeLabel(oldest.at)} to ${this.timeLabel(newest.at)}`;
    const play = document.createElement('span');
    play.className = 'crd-hist-play';
    play.innerHTML = PLAY_SVG;
    side.append(time, play);

    row.append(thumb, main, chips, side);
    row.addEventListener('click', () => {
      openReader({ slug: newest.slug, title, pageType: 'manga', overrideChapter: newest.chapter });
    });

    const subs = document.createElement('div');
    subs.className = 'crd-hist-subs';
    for (const e of group) subs.appendChild(this.buildSubRow(e, title));

    const setOpen = (open: boolean) => {
      under.classList.toggle('open', open);
      under.title = open ? 'Hide chapters' : 'Show chapters';
      subs.classList.toggle('open', open);
    };
    under.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = !this.expanded.has(key);
      if (open) this.expanded.add(key);
      else this.expanded.delete(key);
      setOpen(open);
    });
    if (this.expanded.has(key)) setOpen(true);

    wrap.append(row, subs);
    void this.hydrateThumb(thumb, newest.slug);
    return wrap;
  }

  private buildSubRow(entry: HistoryEntry, title: string): HTMLElement {
    const row = document.createElement('button');
    row.className = 'crd-hist-sub';
    row.title = `Open chapter ${entry.chapter}`;

    const ch = this.chip(`Ch. ${entry.chapter}`, 'accent');
    ch.classList.add('crd-hist-ch');
    row.appendChild(ch);

    const state = document.createElement('span');
    state.className = 'crd-hist-state';
    if (this.isFinished(entry)) {
      state.appendChild(this.readChip());
    } else {
      const p = this.progressOf(entry);
      if (p) state.appendChild(this.progNode(p.page, p.pages));
    }
    row.appendChild(state);

    const spacer = document.createElement('span');
    spacer.className = 'crd-hist-spacer';
    row.appendChild(spacer);

    if (entry.sec && entry.sec >= 60) {
      const t = this.txt(`${Math.round(entry.sec / 60)}m`);
      t.title = 'Active reading time in this chapter that day';
      row.appendChild(t);
    }

    const time = document.createElement('span');
    time.className = 'crd-hist-time';
    time.textContent = this.timeLabel(entry.at);
    row.appendChild(time);

    row.addEventListener('click', () => {
      openReader({ slug: entry.slug, title, pageType: 'manga', overrideChapter: entry.chapter });
    });
    return row;
  }

  private async hydrateThumb(thumb: HTMLElement, slug: string): Promise<void> {
    let dataUrl = this.coverCache.get(slug);
    if (dataUrl === undefined) {
      const sel = selectedSourceOf(this.mappingBySlug.get(slug) ?? null);
      dataUrl = sel ? await getCoverDataUrl(sel.sourceId, sel.sourceSlug) : null;
      this.coverCache.set(slug, dataUrl);
    }
    // No isConnected guard: cache hits run synchronously before the row is
    // appended, so the element is never connected yet at this point
    if (!dataUrl) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = dataUrl;
    img.addEventListener('load', () => {
      thumb.textContent = '';
      thumb.appendChild(img);
    }, { once: true });
  }
}
