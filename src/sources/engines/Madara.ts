import { MangaSource, SourceError } from '../Source.interface';
import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import { fetchWithCors } from '@/utils/fetchWithCors';
import { bridgeEnsureRefererRules } from '@/utils/bridge';
import { looksChallenged } from '@/shared/botwall';
import { decryptOpenSslAes, base64ToBytes } from '@/utils/cryptoAes';
import { sourceCatalogManager } from '@/core/SourceCatalog';
import type { CatalogPreset } from '../catalog/presets';

/**
 * Madara engine - one implementation for the WordPress theme behind
 * hundreds of manga sites (Toonily, ManhuaUS, MadaraDex, ...). Ported from
 * the Tachiyomi multisrc Madara base. Each site is a small CatalogPreset;
 * site quirks that Tachiyomi handles with per-site flags are absorbed by
 * cascades here (chapter endpoint variants, image attr fallbacks, tolerant
 * date parsing) or learned at runtime and persisted per source (the manga
 * path segment, whether listings paginate via the admin-ajax load-more
 * POST), so presets stay data-only.
 *
 * Slug model: manga slug = last path segment of the manga URL
 * ({base}/{mangaPath}/{slug}/). Chapter slug = the href path relative to
 * the manga URL (usually "chapter-N"), or an absolute URL when a site
 * links off-pattern. Slugs are user-data identity (mappings, reading
 * state, caches key on them) — the path between base and slug is NOT part
 * of the slug; it's seeded by the preset, learned from real result URLs,
 * and self-healed via search when a stored slug 404s.
 */
export class MadaraSource implements MangaSource {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly iconUrl?: string;

  private mangaPath: string;
  private loadMore: boolean | undefined;
  private referer: string;
  private lastRequestAt = 0;
  private ensuredHosts = new Set<string>();
  /** Resolves once persisted learned facts (mangaPath, loadMore) are loaded. */
  private learnedReady: Promise<void>;

  constructor(private preset: CatalogPreset) {
    this.id = preset.id;
    this.name = preset.name;
    this.baseUrl = preset.baseUrl.replace(/\/+$/, '');
    this.iconUrl = preset.iconUrl;
    this.mangaPath = preset.overrides?.mangaPath ?? 'manga';
    this.loadMore = preset.overrides?.loadMore;
    this.referer = preset.overrides?.referer ?? this.baseUrl + '/';
    this.learnedReady = this.loadLearned();
  }

  private mangaUrl(slug: string): string {
    return `${this.baseUrl}/${this.mangaPath}/${slug}/`;
  }

  // ── Learned facts (persisted per source id) ──────────────────────────────

  private async loadLearned(): Promise<void> {
    try {
      const learned = await sourceCatalogManager.getLearned(this.id);
      // Learned values win over preset seeds: they come from the site's own
      // URLs/behavior and survive site reorganizations the preset predates.
      if (learned.mangaPath) this.mangaPath = learned.mangaPath;
      if (typeof learned.loadMore === 'boolean') this.loadMore = learned.loadMore;
    } catch { /* seeds/defaults stay */ }
  }

  /** Manga directory ("serie", "read-1", ...) of a same-site manga URL, or null. */
  private mangaDirOf(url: string): string | null {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      const baseHost = new URL(this.baseUrl).hostname.replace(/^www\./, '');
      if (host !== baseHost) return null;
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length < 2) return null; // need at least dir + slug
      const dir = segments.slice(0, -1);
      if (dir.length > 2 || dir.includes('page')) return null;
      return dir.join('/');
    } catch {
      return null;
    }
  }

  /** Majority-vote the manga path from real result URLs; persist on change. */
  private learnMangaPathFrom(urls: string[]): void {
    const votes = new Map<string, number>();
    for (const url of urls) {
      const dir = this.mangaDirOf(url);
      if (dir) votes.set(dir, (votes.get(dir) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [dir, count] of votes) {
      if (count > bestCount) { best = dir; bestCount = count; }
    }
    if (best && best !== this.mangaPath) {
      console.log(`[Madara:${this.id}] Learned manga path "${best}" (was "${this.mangaPath}")`);
      this.mangaPath = best;
      void sourceCatalogManager.patchLearned(this.id, { mangaPath: best }).catch(() => {});
    }
  }

  private setLoadMore(value: boolean): void {
    if (this.loadMore === value) return;
    this.loadMore = value;
    void sourceCatalogManager.patchLearned(this.id, { loadMore: value }).catch(() => {});
  }

  /**
   * A stored slug 404'd: quietly search for it and re-learn the manga path
   * from the matching result. Keeps old mappings alive across site moves.
   */
  private async recoverMangaPath(slug: string): Promise<boolean> {
    const before = this.mangaPath;
    try {
      const results = await this.search(slug.replace(/-/g, ' '));
      const match = results.find((r) => r.slug === slug);
      if (match) {
        const dir = this.mangaDirOf(match.url);
        if (dir && dir !== before) {
          this.mangaPath = dir;
          void sourceCatalogManager.patchLearned(this.id, { mangaPath: dir }).catch(() => {});
          return true;
        }
      }
    } catch { /* recovery is best effort */ }
    return this.mangaPath !== before; // search() itself may have re-learned it
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async search(query: string, page = 1): Promise<SearchResult[]> {
    const q = encodeURIComponent(query.trim());
    const pagePart = page > 1 ? `page/${page}/` : '';
    const url = `${this.baseUrl}/${pagePart}?s=${q}&post_type=wp-manga`;
    const doc = await this.fetchHtml(url);

    // Standard results page; some skins render the archive grid instead
    let rows = Array.from(doc.querySelectorAll('div.c-tabs-item__content, .manga__item'));
    if (rows.length === 0) rows = Array.from(doc.querySelectorAll('div.page-item-detail'));

    const results = this.resultsFromRows(rows);
    await this.ensureReferer(results.map((r) => r.thumbnailUrl));
    return results;
  }

  async checkAvailability(title: string): Promise<boolean> {
    try {
      return (await this.search(title)).length > 0;
    } catch {
      return false;
    }
  }

  // ── Popular / Latest listings ────────────────────────────────────────────

  async getPopular(page = 1): Promise<SearchResult[]> {
    const results = await this.fetchListing(page, 'views');
    await this.ensureReferer(results.map((r) => r.thumbnailUrl));
    return results;
  }

  async getLatest(page = 1): Promise<SearchResult[]> {
    const results = await this.fetchListing(page, 'latest');
    await this.ensureReferer(results.map((r) => r.thumbnailUrl));
    return results;
  }

  /**
   * Madara paginates listings one of two ways (Tachiyomi's LoadMoreStrategy):
   * GET archive pages ({mangaPath}/page/N/?m_orderby=...) or an admin-ajax
   * "madara_load_more" POST. Try the remembered mechanism first, fall back to
   * the other, and persist what worked.
   */
  private async fetchListing(page: number, orderBy: 'views' | 'latest'): Promise<SearchResult[]> {
    await this.learnedReady;
    const attempts: Array<'get' | 'post'> = this.loadMore === true ? ['post', 'get'] : ['get', 'post'];
    for (const mode of attempts) {
      const results = mode === 'get'
        ? await this.listingViaArchive(page, orderBy)
        : await this.listingViaLoadMore(page, orderBy);
      if (results.length > 0) {
        if (mode === 'post') this.setLoadMore(true);
        return results;
      }
    }
    return [];
  }

  private async listingViaArchive(page: number, orderBy: 'views' | 'latest'): Promise<SearchResult[]> {
    const pagePart = page > 1 ? `page/${page}/` : '';
    const url = `${this.baseUrl}/${this.mangaPath}/${pagePart}?m_orderby=${orderBy}`;
    let doc: Document;
    try {
      doc = await this.fetchHtml(url);
    } catch (error) {
      if (error instanceof SourceError && error.code === 'BLOCKED') throw error;
      return []; // 404s here just mean "this site paginates via load-more"
    }
    const results = this.resultsFromRows(this.listingRows(doc));
    if (results.length > 0) {
      // nav.navigation-ajax marks sites whose later pages only exist via the
      // load-more POST (Tachiyomi's AutoDetect sniffs exactly this)
      this.setLoadMore(!!doc.querySelector('nav.navigation-ajax'));
    }
    return results;
  }

  private async listingViaLoadMore(page: number, orderBy: 'views' | 'latest'): Promise<SearchResult[]> {
    // First body matches the reference default (non-manga items filtered);
    // some sites tag entries differently and only answer the unfiltered form.
    for (const filterManga of [true, false]) {
      let doc: Document;
      try {
        doc = await this.fetchHtml(
          `${this.baseUrl}/wp-admin/admin-ajax.php`, 'POST',
          this.loadMoreBody(page, orderBy, filterManga)
        );
      } catch (error) {
        if (error instanceof SourceError && error.code === 'BLOCKED') throw error;
        return []; // network-level failure; a different body won't help
      }
      const results = this.resultsFromRows(this.listingRows(doc));
      if (results.length > 0) return results;
    }
    return [];
  }

  /** Reference madara_load_more archive form body; page is 0-indexed. */
  private loadMoreBody(page: number, orderBy: 'views' | 'latest', filterManga: boolean): string {
    const form = new URLSearchParams();
    form.set('action', 'madara_load_more');
    form.set('page', String(page - 1));
    form.set('template', 'madara-core/content/content-archive');
    form.set('vars[orderby]', 'meta_value_num');
    form.set('vars[paged]', '1');
    if (filterManga) {
      form.set('vars[meta_query][0][key]', '_wp_manga_chapter_type');
      form.set('vars[meta_query][0][value]', 'manga');
    }
    form.set('vars[post_type]', 'wp-manga');
    form.set('vars[post_status]', 'publish');
    form.set('vars[meta_key]', orderBy === 'views' ? '_wp_manga_views' : '_latest_update');
    form.set('vars[order]', 'desc');
    form.set('vars[sidebar]', 'right');
    form.set('vars[manga_archives_item_layout]', 'big_thumbnail');
    return form.toString();
  }

  private listingRows(doc: Document): Element[] {
    return Array.from(doc.querySelectorAll('div.page-item-detail, .manga__item'));
  }

  /**
   * Shared row → SearchResult mapping for search and listing grids. Dedupes
   * by URL (latest-updates grids repeat entries), skips the bilibili promo
   * cards some skins inject, and feeds manga-path learning.
   */
  private resultsFromRows(rows: Element[]): SearchResult[] {
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const link = row.querySelector<HTMLAnchorElement>('.post-title a, h3 a, h4 a, h5 a');
      const href = link?.getAttribute('href');
      const title = link?.textContent?.trim();
      if (!href || !title || href.includes('bilibilicomics.com')) continue;
      const abs = this.absolutize(href);
      if (seen.has(abs)) continue;
      seen.add(abs);
      results.push({
        slug: this.slugFromUrl(abs),
        title,
        url: abs,
        thumbnailUrl: this.imageSrc(row.querySelector('img')) ?? '',
        sourceId: this.id,
      });
    }
    this.learnMangaPathFrom(results.map((r) => r.url));
    return results;
  }

  // ── Details ──────────────────────────────────────────────────────────────

  async getMangaDetails(slug: string): Promise<MangaDetails> {
    await this.learnedReady;
    const doc = await this.fetchMangaPage(slug);

    const text = (sel: string) => doc.querySelector(sel)?.textContent?.trim() ?? '';
    const title = text('div.post-title h1') || text('div.post-title h3') || text('#manga-title h1') || slug;

    // Description can be paragraphs or a plain excerpt div
    const descEl = doc.querySelector('div.description-summary div.summary__content')
      ?? doc.querySelector('div.summary_content div.manga-excerpt');
    const paragraphs = descEl ? Array.from(descEl.querySelectorAll('p')).map((p) => p.textContent?.trim() ?? '') : [];
    const description = (paragraphs.filter(Boolean).join('\n\n') || descEl?.textContent?.trim() ) ?? '';

    // Status lives in a labeled content item; label text varies by skin
    let status = '';
    for (const item of Array.from(doc.querySelectorAll('div.post-status div.post-content_item'))) {
      const heading = item.querySelector('h5, .summary-heading')?.textContent ?? '';
      if (/status/i.test(heading)) {
        status = item.querySelector('.summary-content')?.textContent?.trim() ?? '';
        break;
      }
    }
    if (!status) status = text('div.post-status div.summary-content');

    const details: MangaDetails = {
      slug,
      title,
      description,
      author: text('div.author-content > a'),
      artist: text('div.artist-content > a'),
      status: this.normalizeStatus(status),
      genres: Array.from(doc.querySelectorAll('div.genres-content a'))
        .map((a) => a.textContent?.trim() ?? '')
        .filter(Boolean),
      thumbnailUrl: this.imageSrc(doc.querySelector('div.summary_image img')) ?? '',
    };
    await this.ensureReferer([details.thumbnailUrl]);
    return details;
  }

  /** Fetch the manga page, re-learning the manga path once via search on 404. */
  private async fetchMangaPage(slug: string): Promise<Document> {
    try {
      return await this.fetchHtml(this.mangaUrl(slug));
    } catch (error) {
      if (error instanceof SourceError && error.code === 'NOT_FOUND' && await this.recoverMangaPath(slug)) {
        return await this.fetchHtml(this.mangaUrl(slug));
      }
      throw error;
    }
  }

  // ── Chapters ─────────────────────────────────────────────────────────────

  /**
   * Cascade over the three ways Madara sites deliver chapter lists:
   * embedded in the manga page, XHR POST to {mangaUrl}ajax/chapters/, or
   * legacy admin-ajax.php with the post id. No per-site flags needed.
   */
  async getChapterList(slug: string): Promise<Chapter[]> {
    await this.learnedReady;
    const doc = await this.fetchMangaPage(slug);
    const mangaUrl = this.mangaUrl(slug); // after fetchMangaPage: reflects any path recovery

    let chapters = this.parseChapterRows(doc, mangaUrl);
    if (chapters.length === 0) {
      const xhr = await this.tryFetchHtml(`${mangaUrl}ajax/chapters/`, 'POST');
      if (xhr) chapters = this.parseChapterRows(xhr, mangaUrl);
    }
    if (chapters.length === 0) {
      const postId = doc.querySelector('#manga-chapters-holder')?.getAttribute('data-id')
        ?? doc.querySelector('.wp-manga-action-button[data-post]')?.getAttribute('data-post');
      if (postId) {
        const legacy = await this.tryFetchHtml(
          `${this.baseUrl}/wp-admin/admin-ajax.php`, 'POST',
          `action=manga_get_chapters&manga=${encodeURIComponent(postId)}`
        );
        if (legacy) chapters = this.parseChapterRows(legacy, mangaUrl);
      }
    }

    // Madara lists newest first; the app's convention is ascending
    if (chapters.length > 1 && chapters[0].number > chapters[chapters.length - 1].number) {
      chapters.reverse();
    }
    return chapters;
  }

  private parseChapterRows(root: Document, mangaUrl: string): Chapter[] {
    const chapters: Chapter[] = [];
    for (const li of Array.from(root.querySelectorAll('li.wp-manga-chapter'))) {
      const link = li.querySelector('a');
      const href = link?.getAttribute('href');
      if (!href) continue;
      const title = link?.textContent?.trim() ?? '';

      const dateText = li.querySelector('span.chapter-release-date i')?.textContent?.trim()
        || li.querySelector('span.chapter-release-date a')?.getAttribute('title')
        || li.querySelector('img:not(.thumb)')?.getAttribute('alt')
        || '';

      chapters.push({
        slug: this.chapterSlugFromUrl(this.absolutize(href), mangaUrl),
        number: this.parseChapterNumber(title, href),
        title,
        dateUpload: this.parseDate(dateText),
        isPremium: li.classList.contains('premium-block'),
      });
    }
    return chapters;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  async getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    await this.learnedReady;
    const absolute = /^https?:\/\//.test(chapterSlug);
    try {
      return await this.fetchPages(this.chapterUrl(mangaSlug, chapterSlug));
    } catch (error) {
      if (!absolute && error instanceof SourceError && error.code === 'NOT_FOUND'
          && await this.recoverMangaPath(mangaSlug)) {
        return await this.fetchPages(this.chapterUrl(mangaSlug, chapterSlug));
      }
      throw error;
    }
  }

  private chapterUrl(mangaSlug: string, chapterSlug: string): string {
    if (/^https?:\/\//.test(chapterSlug)) return chapterSlug;
    const sep = chapterSlug.includes('?') ? '' : '/';
    return `${this.mangaUrl(mangaSlug)}${chapterSlug}${sep}`;
  }

  private async fetchPages(chapterUrl: string): Promise<PageInfo[]> {
    // The reference appends ?style=list to every chapter URL: paged-mode
    // skins only render the whole strip that way, and list-mode skins ignore
    // it. A few sites choke on it, so the plain URL stays as fallback.
    const listDoc = await this.tryFetchHtml(this.withStyleList(chapterUrl), 'GET');
    let doc = listDoc;
    let pages = listDoc ? this.parsePages(listDoc) : [];
    if (pages.length === 0) {
      doc = await this.fetchHtml(chapterUrl);
      pages = this.parsePages(doc);
    }
    if (pages.length === 0) {
      // Encrypted "chapter protector" payload instead of <img> tags
      pages = await this.parseProtectedPages(doc)
        ?? (listDoc && listDoc !== doc ? await this.parseProtectedPages(listDoc) : null)
        ?? [];
    }
    if (pages.length === 0) {
      throw new SourceError('No pages found for this chapter', this.id, 'PARSE');
    }
    await this.ensureReferer(pages.map((p) => p.url));
    return pages;
  }

  private withStyleList(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.set('style', 'list'); // also replaces any style=paged
      return u.href;
    } catch {
      return url;
    }
  }

  private parsePages(doc: Document): PageInfo[] {
    const imgs = Array.from(doc.querySelectorAll(
      'div.page-break img, li.blocks-gallery-item img, .reading-content img'
    ));
    const seen = new Set<string>();
    const pages: PageInfo[] = [];
    for (const img of imgs) {
      const src = this.imageSrc(img);
      if (!src || src.startsWith('data:') || seen.has(src)) continue;
      seen.add(src);
      pages.push({ url: src });
    }
    return pages;
  }

  /**
   * Madara's "chapter protector" ships the page list AES-encrypted in a
   * script tag instead of rendering <img> tags. Password and payload sit in
   * the script body; encryption is CryptoJS/OpenSSL-style AES-256-CBC.
   * Returns null when the document has no protector (or decryption fails).
   */
  private async parseProtectedPages(doc: Document | null): Promise<PageInfo[] | null> {
    const el = doc?.querySelector('#chapter-protector-data');
    if (!el) return null;
    try {
      const src = el.getAttribute('src') ?? '';
      const prefix = 'data:text/javascript;base64,';
      const script = src.startsWith(prefix)
        ? new TextDecoder().decode(base64ToBytes(src.slice(prefix.length)))
        : (el.textContent ?? '');

      const password = script.split("wpmangaprotectornonce='")[1]?.split("';")[0];
      const dataJson = script.split("chapter_data='")[1]?.split("';")[0]?.replace(/\\\//g, '/');
      if (!password || !dataJson) return null;

      const data = JSON.parse(dataJson) as { ct: string; s: string };
      const decrypted = await decryptOpenSslAes(data.ct, data.s, password);
      // Plaintext is usually a JSON string literal wrapping the array
      let parsed: unknown = JSON.parse(decrypted);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      if (!Array.isArray(parsed)) return null;

      return parsed
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
        .map((u) => ({ url: this.absolutize(u.trim()) }));
    } catch (error) {
      console.warn(`[Madara:${this.id}] Chapter protector decryption failed:`, error);
      return null;
    }
  }

  // ── Shared parsing helpers ───────────────────────────────────────────────

  /** Lazy-load attr cascade used across Madara skins (reference imageFromElement order). */
  private imageSrc(img: Element | null): string | null {
    if (!img) return null;
    const attr = (name: string): string | null => {
      const value = img.getAttribute(name)?.trim();
      return value ? value : null; // blank lazy-load attrs count as absent
    };
    const fromSrcset = (() => {
      const srcset = attr('srcset') ?? attr('data-srcset');
      if (!srcset) return null;
      const candidates = srcset.split(',').map((s) => s.trim()).filter(Boolean);
      // last candidate = densest (reference picks the highest-res variant)
      return candidates[candidates.length - 1]?.split(/\s+/)[0] ?? null;
    })();
    const raw = attr('data-src')
      ?? attr('data-lazy-src')
      ?? fromSrcset
      ?? attr('data-cfsrc')
      ?? attr('data-manga-src')
      ?? attr('src');
    return raw ? this.absolutize(raw) : null;
  }

  private slugFromUrl(url: string): string {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path.slice(path.lastIndexOf('/') + 1);
  }

  private chapterSlugFromUrl(absUrl: string, mangaUrl: string): string {
    const noQuery = absUrl.split('?')[0]; // drop ?style=paged and friends
    if (noQuery.startsWith(mangaUrl)) {
      return noQuery.slice(mangaUrl.length).replace(/\/+$/, '');
    }
    return noQuery; // off-pattern link: keep the full URL, getChapterPages handles it
  }

  private parseChapterNumber(title: string, href: string): number {
    const fromTitle = title.match(/ch(?:apter)?[\s._-]*([0-9]+(?:\.[0-9]+)?)/i)
      ?? title.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (fromTitle) return parseFloat(fromTitle[1]);
    const fromHref = href.match(/chapter[_-]?([0-9]+(?:[._-][0-9]+)?)/i);
    if (fromHref) return parseFloat(fromHref[1].replace(/[_-]/, '.'));
    return 0;
  }

  /** Map the site's status text onto canonical values; unknown text passes through. */
  private normalizeStatus(raw: string): string {
    const norm = raw.replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm) return raw.trim();
    const table: Array<[string[], string]> = [
      [['completed', 'complete', 'completo', 'finished', 'end', 'ended'], 'Completed'],
      [['ongoing', 'on going', 'updating', 'releasing', 'publishing'], 'Ongoing'],
      [['on hold', 'onhold', 'hiatus', 'on hiatus', 'paused'], 'Hiatus'],
      [['canceled', 'cancelled', 'dropped', 'discontinued'], 'Cancelled'],
    ];
    for (const [words, canonical] of table) {
      if (words.includes(norm)) return canonical;
    }
    return raw.trim();
  }

  /** Tolerant date parsing: absolute formats via Date.parse, dd/MM/yyyy, then relative ("2 days ago"). */
  private parseDate(text: string): number {
    const t = text.trim();
    if (!t) return 0;

    const lower = t.toLowerCase();
    if (/^(up|new|hot)$/i.test(t) || lower.includes('just now') || lower === 'today') return Date.now();
    if (lower === 'yesterday') return Date.now() - 86_400_000;

    if (lower.includes('ago')) {
      const m = lower.match(/(\d+)\s*(second|sec|min|hour|day|week|month|year)/);
      if (m) {
        const n = parseInt(m[1], 10);
        const unit: Record<string, number> = {
          second: 1_000, sec: 1_000, min: 60_000, hour: 3_600_000,
          day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000,
        };
        return Date.now() - n * (unit[m[2]] ?? 0);
      }
      return Date.now();
    }

    const parsed = Date.parse(t);
    if (!Number.isNaN(parsed)) return parsed;

    const dmy = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (dmy) {
      const year = dmy[3].length === 2 ? 2000 + parseInt(dmy[3], 10) : parseInt(dmy[3], 10);
      return new Date(year, parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10)).getTime();
    }
    return 0;
  }

  private absolutize(url: string): string {
    try {
      return new URL(url, this.baseUrl + '/').href;
    } catch {
      return url;
    }
  }

  // ── Request plumbing ─────────────────────────────────────────────────────

  /** Origin hiccups worth ONE retry: plain 5xx and Cloudflare's 52x "origin
   *  unreachable/erroring" family (manhuaplus drops random 520s). 503 is
   *  deliberately absent — it's the bot-wall path below, and retrying a
   *  challenge is pointless. */
  private static readonly TRANSIENT_STATUS = new Set([500, 502, 504, 520, 521, 522, 523, 524]);

  private async fetchHtml(url: string, method: 'GET' | 'POST' = 'GET', body?: string): Promise<Document> {
    let response!: Response;
    for (let attempt = 0; ; attempt++) {
      await this.politenessDelay();
      try {
        // credentials: the user's cookies for this site ride along, so a bot
        // wall passed once in a normal tab stays passed here
        response = await fetchWithCors(url, this.requestHeaders(method), {
          credentials: 'include',
          ...(method === 'POST' ? { method, body: body ?? '' } : {}),
        });
      } catch (error) {
        throw new SourceError(`Request failed: ${(error as Error).message}`, this.id, 'NETWORK');
      }
      if (!response.ok && attempt === 0 && MadaraSource.TRANSIENT_STATUS.has(response.status)) {
        console.warn(`[Madara] ${this.id}: HTTP ${response.status} for ${url}, retrying once`);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      break;
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 503) {
        // Bot wall (Cloudflare et al.): cf-mitigated is CF's explicit
        // challenge marker; cf-ray / challenge body cover older setups.
        // Solvable: pass the check once in a real tab and the clearance
        // cookie rides along on retries.
        const cfMitigated = response.headers.get('cf-mitigated') === 'challenge';
        const cfRay = response.headers.get('cf-ray');
        const body = await response.text().catch(() => '');
        if (cfMitigated || cfRay || looksChallenged(body)) {
          throw new SourceError(
            `${this.baseUrl} is checking for humans (HTTP ${response.status}). Pass the check once in a normal tab and retry.`,
            this.id, 'BLOCKED'
          );
        }
        throw new SourceError(
          `The site refused this request (HTTP ${response.status}).`,
          this.id, 'NETWORK'
        );
      }
      throw new SourceError(
        `HTTP ${response.status} for ${url}`, this.id,
        response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : 'NETWORK'
      );
    }
    const html = await response.text();
    // Cloudflare sometimes serves the challenge interstitial with HTTP 200 —
    // without this sniff it parses as "zero results" and the unlock flow is
    // never offered. cf-mitigated is CF's explicit marker; the body regex
    // covers non-CF walls.
    if (response.headers.get('cf-mitigated') === 'challenge' || looksChallenged(html)) {
      throw new SourceError(
        `${this.baseUrl} is checking for humans. Pass the check once in a normal tab and retry.`,
        this.id, 'BLOCKED'
      );
    }
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /** Like fetchHtml but returns null on any failure (cascade steps). */
  private async tryFetchHtml(url: string, method: 'GET' | 'POST', body?: string): Promise<Document | null> {
    try {
      return await this.fetchHtml(url, method, body);
    } catch {
      return null;
    }
  }

  private requestHeaders(method: 'GET' | 'POST'): Record<string, string> {
    const headers: Record<string, string> = {
      'Referer': this.referer,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    return headers;
  }

  private async politenessDelay(): Promise<void> {
    const gap = this.preset.overrides?.requestDelayMs ?? 350;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /**
   * Report discovered content hostnames so the background extends this
   * source's Referer rule to them (Madara CDNs often require it).
   */
  private async ensureReferer(urls: Array<string | undefined>): Promise<void> {
    const fresh: string[] = [];
    for (const url of urls) {
      if (!url) continue;
      try {
        const host = new URL(url).hostname;
        if (host && !this.ensuredHosts.has(host)) {
          this.ensuredHosts.add(host);
          fresh.push(host);
        }
      } catch { /* relative or invalid, skip */ }
    }
    if (fresh.length === 0) return;
    try {
      await bridgeEnsureRefererRules(this.id, this.referer, fresh);
    } catch (error) {
      for (const host of fresh) this.ensuredHosts.delete(host);
      console.warn(`[Madara:${this.id}] Failed to extend referer rule:`, error);
    }
  }
}
