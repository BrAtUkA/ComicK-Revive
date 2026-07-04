import { SearchResult, MangaDetails, Chapter, PageInfo } from '@/types';
import { MangaSource, SourceError } from '../Source.interface';
import { fetchWithCors } from '@/utils/fetchWithCors';
import { bridgeEnsureRefererRules } from '@/utils/bridge';
import type { SourceSpecV1, FieldRule, ListRule, OperationSpec } from './SourceSpec';

/**
 * DeclarativeSource - Interprets a SourceSpecV1 as a working MangaSource.
 *
 * Runs in viewer/dashboard contexts (needs DOMParser). Fetches route through
 * the background like every other source, so CORS, host permissions, and
 * DNR referer rules apply normally. Registered instances get wrapped in
 * CachedSource by the registry, so caching comes for free.
 */
export class DeclarativeSource implements MangaSource {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly iconUrl?: string;

  private lastRequestAt = 0;
  private ensuredHosts = new Set<string>();

  constructor(private spec: SourceSpecV1) {
    this.id = spec.id;
    this.name = spec.name;
    this.baseUrl = spec.baseUrl.replace(/\/+$/, '');
    this.iconUrl = spec.iconUrl;
  }

  getSpec(): SourceSpecV1 {
    return this.spec;
  }

  async search(query: string, page = 1): Promise<SearchResult[]> {
    const op = this.spec.search;
    let q = query;
    if (op.queryReplace) {
      q = q.replace(new RegExp(op.queryReplace[0], 'g'), op.queryReplace[1]).trim();
    }
    const url = this.buildUrl(op.url, { query: q, page });
    const root = await this.fetchParsed(op, url);

    const rows = this.selectRows(op, root);
    const results: SearchResult[] = [];
    for (const row of rows) {
      const title = this.extractField(row, op.list.fields.title, op);
      const rawUrl = this.extractField(row, op.list.fields.url, op);
      if (!title || !rawUrl) continue;
      const absUrl = this.absolutize(rawUrl);
      const slug = this.deriveSlug(absUrl, op.slugRegex);
      results.push({
        slug,
        title,
        url: absUrl,
        thumbnailUrl: this.absolutize(this.extractField(row, op.list.fields.thumbnail, op) ?? ''),
        sourceId: this.id,
      });
    }
    await this.ensureReferer(results.map((r) => r.thumbnailUrl));
    return results;
  }

  async getMangaDetails(slug: string): Promise<MangaDetails> {
    const op = this.spec.details;
    const root = await this.fetchParsed(op, this.buildUrl(op.url, { slug }));
    const field = (name: string) => this.extractField(root, op.fields[name], op) ?? '';

    const genresRaw = op.fields.genres
      ? this.extractAll(root, op.fields.genres, op)
      : [];

    const details: MangaDetails = {
      slug,
      title: field('title') || slug,
      description: field('description'),
      author: field('author'),
      artist: field('artist'),
      status: field('status'),
      genres: genresRaw.filter(Boolean),
      thumbnailUrl: this.absolutize(field('thumbnail')),
    };
    await this.ensureReferer([details.thumbnailUrl]);
    return details;
  }

  async getChapterList(slug: string): Promise<Chapter[]> {
    const op = this.spec.chapters;
    const root = await this.fetchParsed(op, this.buildUrl(op.url, { slug }));

    const chapters: Chapter[] = [];
    for (const row of this.selectRows(op, root)) {
      const rawUrl = this.extractField(row, op.list.fields.url, op);
      if (!rawUrl) continue;
      const absUrl = this.absolutize(rawUrl);
      const chapterSlug = this.deriveSlug(absUrl, op.chapterSlugRegex);
      const title = this.extractField(row, op.list.fields.title, op) ?? '';
      const numberText = this.extractField(row, op.list.fields.number, op)
        ?? title
        ?? chapterSlug;
      const number = this.parseChapterNumber(numberText, chapterSlug);
      const dateText = this.extractField(row, op.list.fields.date, op);
      chapters.push({
        slug: chapterSlug,
        number,
        title,
        dateUpload: dateText ? this.parseDate(dateText, op.dateFormat) : 0,
        isPremium: false,
      });
    }
    return chapters;
  }

  async getChapterPages(mangaSlug: string, chapterSlug: string): Promise<PageInfo[]> {
    const op = this.spec.pages;
    const root = await this.fetchParsed(op, this.buildUrl(op.url, { slug: mangaSlug, chapterSlug }));

    const pages: PageInfo[] = [];
    for (const row of this.selectRows(op, root)) {
      const url = this.extractField(row, op.list.fields.url, op);
      if (url) pages.push({ url: this.absolutize(url) });
    }
    if (pages.length === 0) {
      throw new SourceError('No pages found (selector matched nothing)', this.id, 'PARSE');
    }
    await this.ensureReferer(pages.map((p) => p.url));
    return pages;
  }

  async checkAvailability(title: string): Promise<boolean> {
    try {
      return (await this.search(title)).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Report the hostnames of discovered content URLs (thumbnails, covers,
   * page images) so the background extends this source's Referer rule to
   * them. Required for sites serving images from CDN domains that can't be
   * known at install time (e.g. MangaPill's rotating CDNs). Awaited so the
   * rule is live before the caller fetches the URLs; never throws.
   */
  private async ensureReferer(urls: Array<string | undefined>): Promise<void> {
    if (!this.spec.referer) return;
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
      await bridgeEnsureRefererRules(this.id, this.spec.referer, fresh);
    } catch (error) {
      // Allow a retry on the next call
      for (const host of fresh) this.ensuredHosts.delete(host);
      console.warn(`[DeclarativeSource:${this.id}] Failed to extend referer rule:`, error);
    }
  }

  // ── Request plumbing ──────────────────────────────────────────────────────

  private buildUrl(template: string, vars: { query?: string; page?: number; slug?: string; chapterSlug?: string }): string {
    const page = vars.page ?? 1;
    const offset = (page - 1) * (this.spec.search.pageSize ?? 0);
    return template
      .replace(/\{base\}/g, this.baseUrl)
      .replace(/\{query\}/g, encodeURIComponent(vars.query ?? ''))
      .replace(/\{page\}/g, String(page))
      .replace(/\{offset\}/g, String(offset))
      .replace(/\{slug\}/g, vars.slug ?? '')
      .replace(/\{chapterSlug\}/g, vars.chapterSlug ?? '');
  }

  private async fetchParsed(op: OperationSpec, url: string): Promise<Document | Element | unknown> {
    await this.politenessDelay();
    let response: Response;
    try {
      response = await fetchWithCors(url, this.spec.headers ?? {});
    } catch (error) {
      throw new SourceError(`Request failed: ${(error as Error).message}`, this.id, 'NETWORK');
    }
    if (!response.ok) {
      throw new SourceError(`HTTP ${response.status} for ${url}`, this.id, response.status === 404 ? 'NOT_FOUND' : 'NETWORK');
    }
    const text = await response.text();

    const mode = op.response ?? 'html';
    if (mode === 'html') return this.parseHtml(text);
    const json = this.parseJson(text);
    if (mode === 'json') return json;
    // json-html: a JSON field carries an HTML fragment
    const fragment = jsonPath(json, op.htmlPath!);
    if (typeof fragment !== 'string') {
      throw new SourceError(`htmlPath ${op.htmlPath} did not yield a string`, this.id, 'PARSE');
    }
    return this.parseHtml(fragment);
  }

  private parseHtml(text: string): Document {
    return new DOMParser().parseFromString(text, 'text/html');
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new SourceError('Response was not valid JSON', this.id, 'PARSE');
    }
  }

  private async politenessDelay(): Promise<void> {
    const gap = this.spec.requestDelayMs ?? 0;
    if (gap <= 0) return;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  // ── Extraction ────────────────────────────────────────────────────────────

  private selectRows(op: OperationSpec & { list: ListRule }, root: Document | Element | unknown): Array<Element | unknown> {
    if ((op.response ?? 'html') === 'json') {
      const arr = jsonPath(root, op.list.rows);
      return Array.isArray(arr) ? arr : [];
    }
    return Array.from((root as Document).querySelectorAll(op.list.rows));
  }

  /**
   * All values a rule yields (for list-ish fields like genres). Non-leaf
   * levels of a then-chain each pick ONE container; the leaf selector
   * collects EVERY match inside it.
   */
  private extractAll(scope: Document | Element | unknown, rule: FieldRule | undefined, op: OperationSpec): string[] {
    if (!rule) return [];
    if ((op.response ?? 'html') === 'json' || rule.path) {
      const value = this.extractField(scope, rule, op);
      return value ? value.split(/\s*,\s*/) : [];
    }

    let container: Element | null = scope as Element;
    let leaf: FieldRule = rule;
    while (leaf.then && container) {
      container = this.pickOne(container, leaf);
      leaf = leaf.then;
    }
    if (!container) {
      return rule.fallback ? this.extractAll(scope, rule.fallback, op) : [];
    }

    let matches = leaf.sel ? Array.from(container.querySelectorAll(leaf.sel)) : [container];
    if (leaf.containsText) {
      matches = matches.filter((m) => (m.textContent ?? '').includes(leaf.containsText!));
    }
    const values = matches
      .map((m) => this.finishValue(this.readElement(m, leaf), rule))
      .filter((v): v is string => !!v);
    if (!values.length && rule.fallback) {
      return this.extractAll(scope, rule.fallback, op);
    }
    return values;
  }

  private extractField(scope: Document | Element | unknown, rule: FieldRule | undefined, op: OperationSpec): string | null {
    if (!rule) return null;
    const value = this.extractFieldInner(scope, rule, op);
    if (value == null && rule.fallback) {
      return this.extractField(scope, rule.fallback, op);
    }
    return value;
  }

  private extractFieldInner(scope: Document | Element | unknown, rule: FieldRule, op: OperationSpec): string | null {
    // JSON mode (or explicit path on a mixed row object)
    if (rule.path !== undefined) {
      const value = jsonPath(scope, rule.path);
      return this.finishValue(value == null ? null : String(value), rule);
    }
    if ((op.response ?? 'html') === 'json') return null;

    const element = this.resolveElement(scope as Element, rule);
    if (!element) return null;
    return this.finishValue(this.readElement(element, rule), rule);
  }

  /** One element per level: sel + containsText filter + index (no then-follow). */
  private pickOne(scope: Element, rule: FieldRule): Element | null {
    let candidates = rule.sel ? Array.from(scope.querySelectorAll(rule.sel)) : [scope];
    if (rule.containsText) {
      candidates = candidates.filter((c) => (c.textContent ?? '').includes(rule.containsText!));
    }
    return candidates[rule.index ?? 0] ?? null;
  }

  /** Apply sel/index/containsText/then chains to land on the target element. */
  private resolveElement(scope: Element, rule: FieldRule): Element | null {
    const picked = this.pickOne(scope, rule);
    if (!picked) return null;
    return rule.then ? this.resolveElement(picked, rule.then) : picked;
  }

  private readElement(element: Element, rule: FieldRule): string | null {
    // then-chains carry the leaf read config
    let leaf: FieldRule = rule;
    while (leaf.then) leaf = leaf.then;
    if (leaf.attr) return element.getAttribute(leaf.attr);
    if (leaf.ownText) {
      return Array.from(element.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
    }
    return element.textContent?.trim() ?? null;
  }

  /** Post-processing may live on the leaf (next to attr) or the outer rule; apply leaf first, then outer. */
  private finishValue(value: string | null, rule: FieldRule): string | null {
    let leaf: FieldRule = rule;
    while (leaf.then) leaf = leaf.then;
    let out = this.applyPost(value, leaf);
    if (leaf !== rule) out = this.applyPost(out, rule);
    return out;
  }

  private applyPost(value: string | null, rule: FieldRule): string | null {
    if (value == null) return null;
    let out = value.trim();
    if (rule.regex) {
      const match = out.match(new RegExp(rule.regex));
      if (!match) return null;
      out = match[1] ?? match[0];
    }
    for (const [pattern, replacement] of rule.replace ?? []) {
      out = out.replace(new RegExp(pattern, 'g'), replacement);
    }
    if (rule.map && rule.map[out] !== undefined) out = rule.map[out];
    return out;
  }

  // ── Value helpers ─────────────────────────────────────────────────────────

  private absolutize(url: string): string {
    if (!url) return '';
    try {
      return new URL(url, this.baseUrl + '/').href;
    } catch {
      return url;
    }
  }

  /** Slug = capture group of slugRegex against the absolute URL, else the path. */
  private deriveSlug(absUrl: string, slugRegex?: string): string {
    if (slugRegex) {
      const match = absUrl.match(new RegExp(slugRegex));
      if (match) return match[1] ?? match[0];
    }
    try {
      return new URL(absUrl).pathname.replace(/^\/+|\/+$/g, '');
    } catch {
      return absUrl;
    }
  }

  private parseChapterNumber(text: string, fallbackSource: string): number {
    const fromText = text.match(/(\d+(?:\.\d+)?)/);
    if (fromText) return parseFloat(fromText[1]);
    const fromSlug = fallbackSource.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
    return fromSlug ? parseFloat(fromSlug[1]) : -1;
  }

  /** 'iso'/'epoch'/undefined use native parsing; else a token pattern (yyyy MM MMM dd d). */
  private parseDate(text: string, format?: string): number {
    const t = text.trim();
    if (!format || format === 'iso') {
      const native = Date.parse(t);
      return Number.isNaN(native) ? 0 : native;
    }
    if (format === 'epoch') {
      const n = parseInt(t, 10);
      return Number.isNaN(n) ? 0 : (t.length <= 10 ? n * 1000 : n);
    }
    return parsePatternDate(t, format);
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Minimal date-pattern parser for tokens yyyy, MM, MMM, dd, d (e.g. "MMM dd, yyyy"). */
function parsePatternDate(text: string, format: string): number {
  const tokenRegex: Record<string, string> = {
    yyyy: '(\\d{4})',
    MMM: '([A-Za-z]{3,})',
    MM: '(\\d{1,2})',
    dd: '(\\d{1,2})',
    d: '(\\d{1,2})',
  };
  const order: string[] = [];
  const pattern = format.replace(/yyyy|MMM|MM|dd|d/g, (token) => {
    order.push(token);
    return tokenRegex[token];
  }).replace(/\s+/g, '\\s+');

  const match = text.match(new RegExp(pattern, 'i'));
  if (!match) return 0;

  let year = 1970;
  let month = 0;
  let day = 1;
  order.forEach((token, i) => {
    const value = match[i + 1];
    if (token === 'yyyy') year = parseInt(value, 10);
    else if (token === 'MMM') month = Math.max(0, MONTHS.indexOf(value.slice(0, 3).toLowerCase()));
    else if (token === 'MM') month = parseInt(value, 10) - 1;
    else day = parseInt(value, 10);
  });
  return new Date(year, month, day).getTime();
}

/** Resolve "a.b[0].c" against a JSON value. */
export function jsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('.')) {
    for (const token of part.replace(/\[(\d+)\]/g, '.$1').split('.')) {
      if (token === '') continue;
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}
