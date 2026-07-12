import { sourceRegistry } from '@/sources';
import type { MangaSource } from '@/sources';
import { SourceError } from '@/sources/Source.interface';
import type { SearchResult, MangaDetails } from '@/types';
import { sourceMappingManager, readingStateManager, settingsManager } from '@/core';
import { bridgeGetCachedChapters } from '@/utils/bridge';
import { findBestMatchesMultiRef } from '@/utils/fuzzy-match';
import type { DashboardTab } from '../Dashboard';
import { showDashToast } from '../Dashboard';
import { buildModal } from '../modal';
import { openSearchResult, ensureSearchMapping } from '../reader';
import { standaloneSlug } from '@/shared/standalone';
import { getImageDataUrl, COVER_CHAPTER_KEY } from '@/shared/covers';
import { escapeHtml, timeAgo } from '@/shared/fmt';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 450;
const INFO_CONCURRENCY = 3;
/** Sources queried at once; the rest wait in priority order */
const SEARCH_CONCURRENCY = 6;
/** Cover-outcome memo bound (entries are promises; data URLs can be large) */
const COVER_MEMO_CAP = 400;

type SourceStatus = 'loading' | 'done' | 'error';
/** 'all' or a source id */
type Filter = string;

/** How a cover URL resolved: direct hotlink, proxied data URL, or neither. */
type CoverOutcome =
  | { kind: 'direct' }
  | { kind: 'data'; dataUrl: string }
  | { kind: 'failed' };

interface ResultInfo {
  count?: number | null;   // chapter count; null = fetch failed
  status?: string | null;  // publication status; null = unavailable
}

/**
 * Search — one continuous results page (decided 2026-07-06): a "Best
 * matches" hero strip on top (top result per source, ranked by similarity),
 * then every source's results as sections below. Pills filter to one
 * source. Cards carry their info below the artwork, never over it; chapter
 * counts load lazily as cards scroll into view (cache first, then live,
 * three at a time) which also pre-warms the cache for reading.
 */
export class SearchTab implements DashboardTab {
  id = 'search';
  label = 'Search';
  icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>`;

  private session = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private knownSlugs: Set<string> = new Set();

  private query = '';
  private sources: MangaSource[] = [];
  private results: Map<string, SearchResult[]> = new Map();
  private statuses: Map<string, SourceStatus> = new Map();
  private errors: Map<string, string> = new Map();
  /** Sources whose last search hit a bot wall; their section offers "Solve the check" */
  private blockedSources = new Set<string>();
  private filter: Filter = 'all';
  private pillsEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;

  // Lazy per-result info (chapter count, status), fetched politely
  private infoCache = new Map<string, ResultInfo>();
  private infoQueue: Array<() => Promise<void>> = [];
  private infoActive = 0;
  private io: IntersectionObserver | null = null;
  private visHandlers = new WeakMap<Element, () => void>();

  // Cover outcomes memoized per mount, keyed by image URL. Storing promises
  // gives in-flight dedup (the hero card and its grid card share the same
  // thumbnailUrl), and DOM rebuilds repaint from here instead of refetching.
  private coverMemo = new Map<string, Promise<CoverOutcome>>();

  // Incremental rendering: section/hero DOM keyed by source id, so one
  // source's completion repaints only its own piece instead of nuking the
  // whole results tree (which used to refire every eager cover fetch)
  private sectionEls = new Map<string, HTMLElement>();
  private heroSection: HTMLElement | null = null;
  private heroGrid: HTMLElement | null = null;
  private heroDivider: HTMLElement | null = null;
  private heroCards = new Map<string, { slug: string; el: HTMLElement }>();

  async mount(host: HTMLElement): Promise<void> {
    await sourceRegistry.refreshConfig();
    await sourceRegistry.loadUserSources();

    host.innerHTML = `
      <div class="crd-content">
        <h1 class="crd-tab-head">Search</h1>
        <p class="crd-tab-sub">Search your sources directly and read right here.</p>
        <div class="crd-search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>
          <input type="text" id="crd-search-input" placeholder="Search manga across your sources" autocomplete="off" spellcheck="false">
        </div>
        <div class="crd-search-pills" id="crd-search-pills" hidden></div>
        <div id="crd-search-results"></div>
      </div>
    `;

    const mappings = await sourceMappingManager.getAll();
    this.knownSlugs = new Set(mappings.map((m) => m.comickSlug));
    this.pillsEl = host.querySelector('#crd-search-pills');
    this.resultsEl = host.querySelector('#crd-search-results');

    const input = host.querySelector<HTMLInputElement>('#crd-search-input')!;
    input.focus();
    input.addEventListener('input', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.runSearch(input.value), DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        void this.runSearch(input.value);
      }
    });
  }

  unmount(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.session++;
    this.infoQueue = [];
    this.io?.disconnect();
    this.io = null;
    this.pillsEl = null;
    this.resultsEl = null;
    this.coverMemo.clear();
    this.resetLayoutRefs();
  }

  private resetLayoutRefs(): void {
    this.sectionEls.clear();
    this.heroCards.clear();
    this.heroSection = null;
    this.heroGrid = null;
    this.heroDivider = null;
  }

  private async runSearch(rawQuery: string): Promise<void> {
    const query = rawQuery.trim();
    const session = ++this.session;

    this.query = query;
    this.results.clear();
    this.statuses.clear();
    this.errors.clear();
    this.blockedSources.clear();
    this.infoQueue = [];
    this.filter = 'all';

    if (query.length < MIN_QUERY) {
      if (this.pillsEl) this.pillsEl.hidden = true;
      if (this.resultsEl) this.resultsEl.innerHTML = '';
      this.resetLayoutRefs();
      return;
    }

    this.sources = sourceRegistry.getAll();
    if (this.sources.length === 0) {
      if (this.resultsEl) {
        this.resultsEl.innerHTML = `<div class="crd-empty"><h3>No sources enabled</h3><p>Enable or add sources in the Sources tab.</p></div>`;
      }
      return;
    }

    for (const source of this.sources) this.statuses.set(source.id, 'loading');
    if (this.pillsEl) this.pillsEl.hidden = false;
    this.renderPills();
    this.renderLayout();

    // Staggered fanout: query in priority order, a few at a time. A new
    // keystroke bumps the session, so queued sources simply never start;
    // in-flight ones are neutralized by querySource's session guards.
    const pending = [...this.sources];
    let active = 0;
    const pump = () => {
      if (session !== this.session) return;
      while (active < SEARCH_CONCURRENCY && pending.length > 0) {
        const source = pending.shift()!;
        active++;
        void this.querySource(source, query, session).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  }

  /** Query one source and paint its outcome; shared by runSearch and the unlock retry. */
  private async querySource(source: MangaSource, query: string, session: number): Promise<void> {
    try {
      const items = await source.search(query);
      if (session !== this.session) return;
      this.results.set(source.id, items);
      this.statuses.set(source.id, 'done');
      this.blockedSources.delete(source.id);
    } catch (error) {
      if (session !== this.session) return;
      this.statuses.set(source.id, 'error');
      this.errors.set(source.id, (error as Error).message);
      if (error instanceof SourceError && error.code === 'BLOCKED') {
        this.blockedSources.add(source.id);
      } else {
        this.blockedSources.delete(source.id);
      }
    }
    this.renderPills();
    this.updateHero();
    this.updateSourceSection(source);
    const total = [...this.results.values()].reduce((n, r) => n + r.length, 0);
    if (!this.anyLoading() && total === 0) this.renderLayout(); // collapse to the empty state
  }

  private anyLoading(): boolean {
    return [...this.statuses.values()].some((s) => s === 'loading');
  }

  // ── Pills ─────────────────────────────────────────────────────────────────

  private renderPills(): void {
    if (!this.pillsEl) return;
    const total = [...this.results.values()].reduce((n, r) => n + r.length, 0);
    const loading = this.anyLoading();

    const pill = (id: string, label: string, count: string, extraClass = '') => `
      <button class="crd-pill${this.filter === id ? ' active' : ''}${extraClass}" data-filter="${escapeHtml(id)}">
        ${escapeHtml(label)}<span class="crd-pill-count">${count}</span>
      </button>
    `;

    let html = pill('all', 'All', loading ? `${total}…` : String(total));
    for (const source of this.sources) {
      const status = this.statuses.get(source.id);
      const count = status === 'loading' ? '…' : status === 'error' ? '!' : String(this.results.get(source.id)?.length ?? 0);
      html += pill(source.id, source.name, count, status === 'error' ? ' error' : '');
    }
    this.pillsEl.innerHTML = html;

    this.pillsEl.querySelectorAll<HTMLButtonElement>('.crd-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filter = btn.dataset.filter!;
        this.renderPills();
        this.renderLayout();
      });
    });
  }

  // ── Lazy result info (chapter counts, status) ─────────────────────────────

  private infoKey(sourceId: string, slug: string): string {
    return `${sourceId}/${slug}`;
  }

  /**
   * Fetch chapter count (and optionally status) for one result: source-data
   * cache first, live fetch otherwise. `apply` re-renders the target text
   * and is also called immediately when everything is already cached.
   */
  private requestInfo(source: MangaSource, item: SearchResult, wantStatus: boolean, apply: () => void): void {
    const key = this.infoKey(source.id, item.slug);
    const cached = this.infoCache.get(key);
    if (cached && cached.count !== undefined && (!wantStatus || cached.status !== undefined)) {
      apply();
      return;
    }

    const session = this.session;
    this.schedule(async () => {
      if (session !== this.session) return;
      const info: ResultInfo = this.infoCache.get(key) ?? {};
      if (info.count === undefined) {
        try {
          const cachedList = await bridgeGetCachedChapters(source.id, item.slug);
          if (cachedList && cachedList.length > 0) {
            info.count = cachedList.length;
          } else {
            info.count = (await source.getChapterList(item.slug)).length;
          }
        } catch {
          info.count = null;
        }
      }
      if (wantStatus && info.status === undefined) {
        try {
          info.status = (await source.getMangaDetails(item.slug)).status || null;
        } catch {
          info.status = null;
        }
      }
      this.infoCache.set(key, info);
      if (session === this.session) apply();
    });
  }

  private schedule(task: () => Promise<void>): void {
    this.infoQueue.push(task);
    this.drainInfoQueue();
  }

  private drainInfoQueue(): void {
    while (this.infoActive < INFO_CONCURRENCY) {
      const task = this.infoQueue.shift();
      if (!task) return;
      this.infoActive++;
      void task().finally(() => {
        this.infoActive--;
        this.drainInfoQueue();
      });
    }
  }

  /** Defer until the element scrolls near the viewport */
  private whenVisible(el: HTMLElement, onVisible: () => void): void {
    if (!this.io) {
      this.io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.io?.unobserve(entry.target);
            this.visHandlers.get(entry.target)?.();
            this.visHandlers.delete(entry.target);
          }
        }
      }, { rootMargin: '300px' });
    }
    this.visHandlers.set(el, onVisible);
    this.io.observe(el);
  }

  // ── Results ───────────────────────────────────────────────────────────────

  /**
   * The single highest-scoring result per source, ranked by similarity to
   * the query (mirrors GridView's "Most Relevant" tab on comick).
   */
  private bestMatches(): Array<{ result: SearchResult; source: MangaSource; score: number }> {
    const all: Array<SearchResult & { __sourceId: string }> = [];
    for (const source of this.sources) {
      for (const item of this.results.get(source.id) ?? []) {
        all.push({ ...item, __sourceId: source.id });
      }
    }
    if (all.length === 0) return [];

    const scored = findBestMatchesMultiRef([this.query], all, (r) => r.title, all.length, 0);

    const bestBySource = new Map<string, { result: SearchResult; score: number }>();
    for (const { item, score } of scored) {
      const existing = bestBySource.get(item.__sourceId);
      if (!existing || score > existing.score) {
        bestBySource.set(item.__sourceId, { result: item, score });
      }
    }

    return [...bestBySource.entries()]
      .map(([sourceId, { result, score }]) => ({
        result,
        source: this.sources.find((s) => s.id === sourceId)!,
        score,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Full (re)build of the results tree — the RARE path: new-search scaffold,
   * pill clicks, library adds, and the all-done-zero-results collapse.
   * Per-source completions go through updateSourceSection/updateHero, which
   * repaint in place so already-loaded covers and info survive.
   */
  private renderLayout(): void {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = '';
    this.io?.disconnect();
    this.io = null;
    this.resetLayoutRefs();

    const total = [...this.results.values()].reduce((n, r) => n + r.length, 0);
    if (!this.anyLoading() && total === 0) {
      this.resultsEl.innerHTML = `<div class="crd-empty"><h3>No results</h3><p>Try a different title or spelling.</p></div>`;
      return;
    }

    if (this.filter === 'all') {
      this.ensureHero(this.resultsEl);
      // All sections mount upfront in priority order, so later per-source
      // updates land in a stable position instead of reflowing the page
      for (const source of this.sources) {
        this.mountSourceSection(this.resultsEl, source);
      }
      this.updateHero();
    } else {
      const source = this.sources.find((s) => s.id === this.filter);
      if (source) this.mountSourceSection(this.resultsEl, source);
    }
  }

  /** Build the hero shell + divider (content painted by updateHero). */
  private ensureHero(container: HTMLElement): void {
    const section = document.createElement('section');
    section.className = 'crd-hero';
    section.innerHTML = `
      <div class="crd-search-section-head">
        <span class="crd-search-section-name">Best matches</span>
        <span class="crd-search-section-status"></span>
      </div>
      <div class="crd-hero-grid"></div>
    `;
    container.appendChild(section);
    const divider = document.createElement('div');
    divider.className = 'crd-search-divider';
    container.appendChild(divider);
    this.heroSection = section;
    this.heroGrid = section.querySelector<HTMLElement>('.crd-hero-grid');
    this.heroDivider = divider;
  }

  /**
   * Keyed reconciliation of the hero strip: a source's best-match card is
   * reused (moved into rank position) unless its slug changed, so covers and
   * fetched info never reload when other sources finish.
   */
  private updateHero(): void {
    if (!this.heroSection || !this.heroGrid) return; // filtered view
    const entries = this.bestMatches();
    const loading = this.anyLoading();

    const statusEl = this.heroSection.querySelector<HTMLElement>('.crd-search-section-status');
    if (statusEl) statusEl.textContent = loading ? 'searching…' : 'top result from each source';

    const wanted = new Set(entries.map((e) => e.source.id));
    for (const { result, source, score } of entries) {
      const existing = this.heroCards.get(source.id);
      if (existing && existing.slug === result.slug) {
        this.heroGrid.appendChild(existing.el); // moves the node into rank order
      } else {
        existing?.el.remove();
        const el = this.renderHeroCard(result, source, score);
        this.heroCards.set(source.id, { slug: result.slug, el });
        this.heroGrid.appendChild(el);
      }
    }
    for (const [sourceId, { el }] of this.heroCards) {
      if (!wanted.has(sourceId)) {
        el.remove();
        this.heroCards.delete(sourceId);
      }
    }

    // Skeletons trail the real cards, one per still-loading source
    this.heroGrid.querySelectorAll('.crd-hero-card.skeleton').forEach((el) => el.remove());
    if (loading) {
      const loadingCount = [...this.statuses.values()].filter((s) => s === 'loading').length;
      for (let i = 0; i < Math.max(1, loadingCount); i++) {
        this.heroGrid.insertAdjacentHTML('beforeend', `<div class="crd-hero-card skeleton"><div class="crd-hero-cover"></div><div class="crd-hero-body"><div class="crd-search-title-sk"></div><div class="crd-search-title-sk" style="width:55%"></div></div></div>`);
      }
    }

    const empty = !loading && entries.length === 0;
    this.heroSection.hidden = empty;
    this.heroDivider!.hidden = empty;
  }

  private renderHeroCard(item: SearchResult, source: MangaSource, score: number): HTMLElement {
    const card = document.createElement('button');
    card.className = 'crd-hero-card';
    card.title = item.title;

    const cover = document.createElement('div');
    cover.className = 'crd-hero-cover';
    const letter = document.createElement('span');
    letter.className = 'crd-search-letter';
    letter.textContent = item.title.slice(0, 1).toUpperCase();
    cover.appendChild(letter);
    this.attachCover(cover, item.thumbnailUrl, source, item);
    this.attachOwnedBadge(cover, source, item);

    const body = document.createElement('div');
    body.className = 'crd-hero-body';
    const title = document.createElement('div');
    title.className = 'crd-hero-title';
    title.textContent = item.title;
    const src = document.createElement('div');
    src.className = 'crd-hero-src';
    src.textContent = source.name;
    const stats = document.createElement('div');
    stats.className = 'crd-hero-stats';
    stats.textContent = 'loading info…';
    const match = document.createElement('div');
    match.className = 'crd-hero-match';
    match.textContent = `${Math.round(score * 100)}% match`;
    body.append(title, src, stats, match);

    card.append(cover, body);
    card.addEventListener('click', () => this.openDetails(item, source));

    const owned = this.knownSlugs.has(standaloneSlug(source.id, item.slug));
    if (owned) {
      card.classList.add('owned');
      stats.innerHTML = `<span class="crd-search-lib">in library</span>`;
      return card;
    }

    // Hero cards are few: enrich them eagerly
    this.requestInfo(source, item, true, () => {
      const info = this.infoCache.get(this.infoKey(source.id, item.slug));
      if (info?.count === 0) {
        card.classList.add('no-chapters');
        stats.textContent = 'no chapters on this source';
        return;
      }
      const bits: string[] = [];
      if (typeof info?.count === 'number') bits.push(`${info.count} ${info.count === 1 ? 'chapter' : 'chapters'}`);
      if (info?.status) bits.push(info.status);
      stats.textContent = bits.join(' · ') || 'info unavailable';
    });

    return card;
  }

  /** Create one source's section shell, keyed by source id, then paint it. */
  private mountSourceSection(container: HTMLElement, source: MangaSource): void {
    const section = document.createElement('section');
    section.className = 'crd-search-section';
    section.innerHTML = `
      <div class="crd-search-section-head">
        <span class="crd-search-section-name">${escapeHtml(source.name)}</span>
        <span class="crd-search-section-status"></span>
      </div>
      <div class="crd-search-grid"></div>
    `;
    container.appendChild(section);
    this.sectionEls.set(source.id, section);
    this.updateSourceSection(source);
  }

  /** Repaint one source's head + grid in place; other sections' DOM survives. */
  private updateSourceSection(source: MangaSource): void {
    const section = this.sectionEls.get(source.id);
    if (!section) return; // filtered out of view; pills still track it
    const status = this.statuses.get(source.id);
    const items = this.results.get(source.id) ?? [];

    const errMsg = this.errors.get(source.id) ?? '';
    const isBlocked = this.blockedSources.has(source.id) || /checking for humans|human check/i.test(errMsg);
    // Blocked = a bot wall; the automated unlock flow is shelved
    // (docs/bot-wall-unlock-and-cors.md), so this stays informational
    const statusText = status === 'loading' ? 'searching…'
      : status === 'error' ? (isBlocked ? 'blocked by a bot check' : 'failed, source may be down or rate limiting')
      : `${items.length} result${items.length === 1 ? '' : 's'}`;

    const statusEl = section.querySelector<HTMLElement>('.crd-search-section-status')!;
    statusEl.textContent = statusText;
    statusEl.classList.toggle('fail', status === 'error');
    statusEl.title = errMsg;

    const grid = section.querySelector<HTMLElement>('.crd-search-grid')!;
    if (status === 'loading') {
      grid.innerHTML = this.skeletons(6);
    } else {
      grid.replaceChildren();
      for (const item of items) grid.appendChild(this.renderCard(item, source));
      section.classList.toggle('empty', status === 'done' && items.length === 0);
    }
  }

  private skeletons(count: number): string {
    return Array.from({ length: count }, () => `
      <div class="crd-search-card skeleton">
        <div class="crd-search-cover"></div>
        <div class="crd-search-title-sk"></div>
      </div>
    `).join('');
  }

  /**
   * Covers load img-FIRST: a plain <img> is not CORS-gated (many cover CDNs
   * live on foreign domains with no ACAO and no host grant, where the proxy
   * is doomed), streams straight from the browser's HTTP cache, and DNR
   * referer rules still apply to it. Only when the img errors (hotlink-
   * hostile host) does the background proxy run — that path rides the SW
   * fetch + host grants and warms the shared __cover__ ImageCache. Outcomes
   * memoize per mount so DOM rebuilds never refetch. `lazy` defers until the
   * card nears the viewport.
   */
  private attachCover(cover: HTMLElement, url: string | undefined, source: MangaSource, item: SearchResult, lazy = false): void {
    if (!url) return;
    const load = () => this.loadCover(cover, url, source, item);
    if (lazy) this.whenVisible(cover, load);
    else load();
  }

  private makeCoverImg(): HTMLImageElement {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer'; // DNR rules still set Referer where a rule covers the host
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    return img;
  }

  private loadCover(cover: HTMLElement, url: string, source: MangaSource, item: SearchResult): void {
    const memo = this.coverMemo.get(url);
    if (memo) {
      void memo.then((outcome) => this.applyCover(cover, url, outcome));
      return;
    }
    // First request for this URL: probe direct-in-place so the image streams
    // into the visible card while the outcome memoizes for every later card
    const promise = new Promise<CoverOutcome>((resolve) => {
      const img = this.makeCoverImg();
      img.addEventListener('load', () => resolve({ kind: 'direct' }), { once: true });
      img.addEventListener('error', () => {
        img.remove();
        void this.proxyFallback(cover, url, source, item).then(resolve);
      }, { once: true });
      img.src = url;
      cover.appendChild(img);
    });
    if (this.coverMemo.size >= COVER_MEMO_CAP) {
      const oldest = this.coverMemo.keys().next().value;
      if (oldest !== undefined) this.coverMemo.delete(oldest);
    }
    this.coverMemo.set(url, promise);
  }

  /** Proxy+cache fallback for hotlink-hostile CDNs (SW fetch + DNR + grants). */
  private async proxyFallback(cover: HTMLElement, url: string, source: MangaSource, item: SearchResult): Promise<CoverOutcome> {
    const session = this.session;
    const dataUrl = await getImageDataUrl(url, {
      sourceId: source.id,
      mangaSlug: item.slug,
      chapterSlug: COVER_CHAPTER_KEY,
      pageIndex: 0,
    }, { stillWanted: () => session === this.session && cover.isConnected });
    if (dataUrl) {
      const outcome: CoverOutcome = { kind: 'data', dataUrl };
      this.applyCover(cover, url, outcome);
      return outcome;
    }
    if (session !== this.session || !cover.isConnected) {
      // Skipped (stale), not failed: forget so a future card retries cleanly
      this.coverMemo.delete(url);
    }
    return { kind: 'failed' };
  }

  private applyCover(cover: HTMLElement, url: string, outcome: CoverOutcome): void {
    if (outcome.kind === 'failed') return; // keep the letter placeholder
    // The probe img may already sit in this cover; also guards double-attach
    if (!cover.isConnected || cover.querySelector('img')) return;
    const img = this.makeCoverImg();
    if (outcome.kind === 'direct') {
      // Self-heal: if the CDN turned hostile since memoization, drop the memo
      img.addEventListener('error', () => {
        img.remove();
        this.coverMemo.delete(url);
      }, { once: true });
      img.src = url;
    } else {
      img.src = outcome.dataUrl;
    }
    cover.appendChild(img);
  }

  private attachOwnedBadge(cover: HTMLElement, source: MangaSource, item: SearchResult): void {
    if (!this.knownSlugs.has(standaloneSlug(source.id, item.slug))) return;
    const owned = document.createElement('span');
    owned.className = 'crd-search-owned';
    owned.title = 'In your library';
    owned.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    cover.appendChild(owned);
  }

  private renderCard(item: SearchResult, source: MangaSource): HTMLElement {
    const card = document.createElement('button');
    card.className = 'crd-search-card';
    card.title = item.title;

    const cover = document.createElement('div');
    cover.className = 'crd-search-cover';
    const letter = document.createElement('span');
    letter.className = 'crd-search-letter';
    letter.textContent = item.title.slice(0, 1).toUpperCase();
    cover.appendChild(letter);
    this.attachCover(cover, item.thumbnailUrl, source, item, true);
    this.attachOwnedBadge(cover, source, item);

    const title = document.createElement('div');
    title.className = 'crd-search-title';
    title.textContent = item.title;

    const meta = document.createElement('div');
    meta.className = 'crd-search-meta';
    meta.textContent = source.name;

    card.append(cover, title, meta);
    card.addEventListener('click', () => this.openDetails(item, source));

    // Already saved: softly muted + labeled, and no count fetch needed
    if (this.knownSlugs.has(standaloneSlug(source.id, item.slug))) {
      card.classList.add('owned');
      meta.textContent = `${source.name} · `;
      const lib = document.createElement('span');
      lib.className = 'crd-search-lib';
      lib.textContent = 'in library';
      meta.appendChild(lib);
      return card;
    }

    // Chapter count fills in when the card nears the viewport
    const applyCount = () => {
      const info = this.infoCache.get(this.infoKey(source.id, item.slug));
      if (info?.count === 0) {
        card.classList.add('no-chapters');
        meta.textContent = `${source.name} · no chapters`;
      } else if (typeof info?.count === 'number') {
        meta.textContent = `${source.name} · ${info.count} ch`;
      }
    };
    const cached = this.infoCache.get(this.infoKey(source.id, item.slug));
    if (cached?.count !== undefined) {
      applyCount();
    } else {
      this.whenVisible(card, () => this.requestInfo(source, item, false, applyCount));
    }

    return card;
  }

  // ── Details modal ─────────────────────────────────────────────────────────

  private openDetails(item: SearchResult, source: MangaSource): void {
    const slug = standaloneSlug(source.id, item.slug);
    const inLibrary = this.knownSlugs.has(slug);

    const { overlay, close } = buildModal(escapeHtml(item.title), `
      <div class="crd-details">
        <div class="crd-details-cover">
          <span class="crd-search-letter">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span>
        </div>
        <div class="crd-details-body">
          <div class="crd-details-meta" id="crd-det-meta">
            <span class="crd-chip builtin">${escapeHtml(source.name)}</span>
            <span class="crd-details-loading">loading details…</span>
          </div>
          <div class="crd-details-stats" id="crd-det-stats" hidden></div>
          <div class="crd-details-desc" id="crd-det-desc"></div>
          <div class="crd-btn-row crd-details-actions">
            <button class="crd-btn crd-btn-primary" id="crd-det-read">${inLibrary ? 'Continue' : 'Start reading'}</button>
            <button class="crd-btn" id="crd-det-save" ${inLibrary ? 'hidden' : ''}>Add to library</button>
            <a class="crd-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Open on ${escapeHtml(source.name)}</a>
          </div>
        </div>
      </div>
      <div class="crd-mdl-chapters">
        <div class="crd-mdl-chapters-head">
          <h4>Chapters</h4>
          <span id="crd-det-ch-note">loading…</span>
        </div>
        <div class="crd-mdl-ch-list" id="crd-det-ch-list"></div>
      </div>
    `, { large: true, tall: true });

    this.attachCover(overlay.querySelector<HTMLElement>('.crd-details-cover')!, item.thumbnailUrl, source, item);

    const readBtn = overlay.querySelector<HTMLButtonElement>('#crd-det-read')!;
    const saveBtn = overlay.querySelector<HTMLButtonElement>('#crd-det-save')!;

    // Locked until the chapter list confirms there is something to read;
    // some sources list manga they carry zero chapters for
    readBtn.disabled = true;
    saveBtn.disabled = true;
    readBtn.title = 'Checking chapters…';

    if (inLibrary) {
      void readingStateManager.get(slug).then((state) => {
        if (state) readBtn.textContent = `Continue · Ch. ${state.currentChapter}`;
      });
    }

    let firstChapter: number | null = null;

    readBtn.addEventListener('click', async () => {
      close();
      await openSearchResult(item, source.id, { forceResume: this.knownSlugs.has(slug) });
      this.knownSlugs.add(slug);
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      await this.addToLibrary(item, source, firstChapter);
      this.knownSlugs.add(slug);
      saveBtn.hidden = true;
      readBtn.textContent = `Continue · Ch. ${firstChapter ?? 1}`;
      showDashToast('Added to library');
      this.renderLayout();
    });

    void this.fillDetails(overlay, item, source);
    void this.fillChapters(overlay, item, source, close, (first) => { firstChapter = first; });
  }

  /** Save to the library (Reading shelf) without opening the reader */
  private async addToLibrary(item: SearchResult, source: MangaSource, firstChapter: number | null): Promise<void> {
    const slug = await ensureSearchMapping(item, source.id);
    const existing = await readingStateManager.get(slug);
    if (existing) return;
    const settings = await settingsManager.load();
    await readingStateManager.save(slug, {
      currentChapter: firstChapter ?? 1,
      chapterPositions: {},
      readingMode: settings.defaultReadingMode,
      zoomLevel: 100,
      imageFit: settings.defaultImageFit,
      chapterPageCount: 0,
      lastRead: Date.now(),
    });
  }

  private async fillDetails(overlay: HTMLElement, item: SearchResult, source: MangaSource): Promise<void> {
    const meta = overlay.querySelector<HTMLElement>('#crd-det-meta');
    const desc = overlay.querySelector<HTMLElement>('#crd-det-desc');
    try {
      const details: MangaDetails = await source.getMangaDetails(item.slug);
      if (!meta || !desc || !overlay.isConnected) return;

      // One chip (provenance); the rest is plain text hierarchy
      const line = [details.status, details.author].filter(Boolean).join(' · ');
      meta.innerHTML = `<span class="crd-chip builtin">${escapeHtml(source.name)}</span>${line ? `<span class="crd-details-line">${escapeHtml(line)}</span>` : ''}`;

      const genres = details.genres?.filter(Boolean) ?? [];
      desc.innerHTML = `
        ${genres.length ? `<div class="crd-details-genres">${genres.map((g) => `<span>${escapeHtml(g)}</span>`).join('')}</div>` : ''}
        <p>${escapeHtml(details.description || 'No description available.')}</p>
      `;

      // Better cover from details when the search thumbnail was missing
      if (details.thumbnailUrl && !overlay.querySelector('.crd-details-cover img')) {
        this.attachCover(overlay.querySelector<HTMLElement>('.crd-details-cover')!, details.thumbnailUrl, source, item);
      }
    } catch (error) {
      if (meta) meta.innerHTML = `<span class="crd-chip builtin">${escapeHtml(source.name)}</span><span class="crd-details-loading">details unavailable: ${escapeHtml((error as Error).message.slice(0, 60))}</span>`;
    }
  }

  /** Chapter list with dates; clicking a chapter starts reading right there */
  private async fillChapters(
    overlay: HTMLElement,
    item: SearchResult,
    source: MangaSource,
    closeModal: () => void,
    onFirstChapter: (n: number | null) => void
  ): Promise<void> {
    const note = overlay.querySelector<HTMLElement>('#crd-det-ch-note');
    const list = overlay.querySelector<HTMLElement>('#crd-det-ch-list');
    if (!note || !list) return;

    const readBtn = overlay.querySelector<HTMLButtonElement>('#crd-det-read');
    const saveBtn = overlay.querySelector<HTMLButtonElement>('#crd-det-save');
    const lockButtons = (reason: string) => {
      if (readBtn) {
        readBtn.disabled = true;
        readBtn.title = reason;
      }
      if (saveBtn) saveBtn.disabled = true;
    };

    try {
      const chapters = await source.getChapterList(item.slug);
      if (!overlay.isConnected) return;
      if (chapters.length === 0) {
        note.textContent = 'no chapters on this source';
        lockButtons('This source lists the manga but carries no chapters');
        this.infoCache.set(this.infoKey(source.id, item.slug), {
          ...this.infoCache.get(this.infoKey(source.id, item.slug)),
          count: 0,
        });
        onFirstChapter(null);
        return;
      }

      // Something to read: unlock the actions
      if (readBtn) {
        readBtn.disabled = false;
        readBtn.title = '';
      }
      if (saveBtn) saveBtn.disabled = false;

      const sorted = [...chapters].sort((a, b) => b.number - a.number);
      const latest = sorted[0];
      onFirstChapter(sorted[sorted.length - 1].number);
      note.textContent = `${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'} · click one to start there`;

      // Quiet stats line under the header: count, latest, freshness
      const statsEl = overlay.querySelector<HTMLElement>('#crd-det-stats');
      if (statsEl) {
        const bits = [`${chapters.length} chapters`, `latest Ch. ${latest.number}`];
        if (latest.dateUpload > 0) bits.push(`updated ${timeAgo(latest.dateUpload)}`);
        statsEl.textContent = bits.join(' · ');
        statsEl.hidden = false;
      }

      const frag = document.createDocumentFragment();
      for (const ch of sorted) {
        const row = document.createElement('button');
        row.className = 'crd-mdl-ch';
        const num = document.createElement('span');
        num.className = 'crd-mdl-ch-num';
        num.textContent = `Chapter ${ch.number}`;
        const title = document.createElement('span');
        title.className = 'crd-mdl-ch-title';
        if (ch.title && !/^chapter\s*[\d.]+$/i.test(ch.title.trim())) title.textContent = ch.title;
        const date = document.createElement('span');
        date.className = 'crd-mdl-ch-date';
        if (ch.dateUpload > 0) {
          date.textContent = new Date(ch.dateUpload).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        row.append(num, title, date);
        row.addEventListener('click', async () => {
          closeModal();
          await openSearchResult(item, source.id, { chapter: ch.number });
          this.knownSlugs.add(standaloneSlug(source.id, item.slug));
        });
        frag.appendChild(row);
      }
      list.appendChild(frag);

      // The list doubles as the count cache for the grids
      this.infoCache.set(this.infoKey(source.id, item.slug), {
        ...this.infoCache.get(this.infoKey(source.id, item.slug)),
        count: chapters.length,
      });
    } catch (error) {
      note.textContent = `chapter list unavailable: ${(error as Error).message.slice(0, 50)}`;
      lockButtons('Chapter list could not be loaded; reading would fail the same way');
      onFirstChapter(null);
    }
  }
}
