/**
 * SourceSpecV1 - Declarative manga source definition (pure data, no code).
 *
 * A spec describes each operation (search, details, chapters, pages) as a
 * URL template plus extraction rules. DeclarativeSource interprets specs at
 * runtime, so users add sources by importing JSON: no rebuild, no code.
 *
 * Deliberately out of scope (needs the future sandboxed-JS tier): dynamic
 * anti-bot tokens, image descrambling, multi-step request chains, POST
 * bodies. Sites needing those stay built-in TS sources (see MangaFire notes
 * in tasks/todo.md).
 *
 * URL template placeholders: {base} {query} {page} {offset} {slug} {chapterSlug}
 */

export interface FieldRule {
  /** CSS selector relative to the row/document. Omit to use the row itself. */
  sel?: string;
  /** Among sel matches, keep the Nth (default 0). */
  index?: number;
  /** Among sel matches, keep the first whose text contains this string. */
  containsText?: string;
  /** Continue selecting inside the matched element (composes with containsText). */
  then?: FieldRule;
  /** Attribute to read; omit for text content. */
  attr?: string;
  /** Use only the element's own text (not descendants). */
  ownText?: boolean;
  /** JSON path for json responses, dot/bracket notation (e.g. "result.items[0].title"). */
  path?: string;
  /** Regex post-process: first capture group if present, else whole match. */
  regex?: string;
  /** Ordered [pattern, replacement] pairs applied as global regexes. */
  replace?: Array<[string, string]>;
  /** Lookup table applied to the final value (exact match, else value kept). */
  map?: Record<string, string>;
  /** Tried when this rule yields nothing (e.g. source[srcset] else img[src]). */
  fallback?: FieldRule;
}

export interface ListRule {
  /** CSS selector for row elements (html) or JSON path to an array (json). */
  rows: string;
  fields: Record<string, FieldRule>;
}

export interface OperationSpec {
  /** URL template. */
  url: string;
  /** Response body type. json-html: JSON path (htmlPath) yields an HTML string to parse. */
  response?: 'html' | 'json' | 'json-html';
  htmlPath?: string;
}

export interface SourceSpecV1 {
  spec: 1;
  /** Unique id, lowercase [a-z0-9_-]. Must not collide with built-in ids. */
  id: string;
  name: string;
  baseUrl: string;
  iconUrl?: string;
  lang?: string;
  /** Sent as Referer via a dynamic DNR rule (fetch cannot set it directly). */
  referer?: string;
  /** Extra request headers (best effort; forbidden headers are ignored by fetch). */
  headers?: Record<string, string>;
  /**
   * Origins page images are served from when they differ from baseUrl
   * (CDN domains). Match patterns allowed (e.g. "https://*.lowee.us/*").
   * Access is requested when the source is added; without it, image
   * fetches are CORS-blocked.
   */
  imageHosts?: string[];
  /** Politeness gap between requests to this source, ms. */
  requestDelayMs?: number;

  search: OperationSpec & {
    /** For {offset} = (page - 1) * pageSize. */
    pageSize?: number;
    /** Preprocess the query: [pattern, replacement] regex applied globally. */
    queryReplace?: [string, string];
    /** Fields: title, url, thumbnail. */
    list: ListRule;
    /** Derive the slug from the extracted url field (capture group 1). */
    slugRegex?: string;
  };

  details: OperationSpec & {
    /** Fields: title, description, author, artist, status, genres, thumbnail. */
    fields: Record<string, FieldRule>;
    /** genres field: selector matches are joined with this (default ", "). */
    genresJoin?: string;
  };

  chapters: OperationSpec & {
    /** Fields: url, title, number, date. */
    list: ListRule;
    /** Derive chapter slug from the extracted url field (capture group 1). */
    chapterSlugRegex?: string;
    /** 'iso' | 'epoch' | pattern with tokens yyyy MM MMM dd d (e.g. "MMM dd, yyyy"). */
    dateFormat?: string;
  };

  pages: OperationSpec & {
    /** Fields: url (required; relative URLs resolve against baseUrl). */
    list: ListRule;
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,40}$/;

/** Validate untrusted JSON as a SourceSpecV1. Returns error strings (empty = valid). */
export function validateSourceSpec(raw: unknown): string[] {
  const errors: string[] = [];
  const spec = raw as Partial<SourceSpecV1>;

  if (!spec || typeof spec !== 'object') return ['Spec must be a JSON object'];
  if (spec.spec !== 1) errors.push('`spec` must be 1 (only SourceSpecV1 is supported)');
  if (!spec.id || !ID_PATTERN.test(spec.id)) errors.push('`id` must be lowercase letters/digits/dashes (2-41 chars)');
  if (!spec.name || typeof spec.name !== 'string') errors.push('`name` is required');
  if (!spec.baseUrl || !/^https?:\/\//.test(spec.baseUrl)) errors.push('`baseUrl` must be an http(s) URL');

  const requireOp = (key: 'search' | 'details' | 'chapters' | 'pages') => {
    const op = spec[key] as (OperationSpec & { list?: ListRule; fields?: Record<string, FieldRule> }) | undefined;
    if (!op || typeof op !== 'object' || typeof op.url !== 'string' || !op.url) {
      errors.push(`\`${key}.url\` is required`);
      return;
    }
    if (op.response === 'json-html' && !op.htmlPath) {
      errors.push(`\`${key}.htmlPath\` is required when response is json-html`);
    }
    if (key === 'details') {
      if (!op.fields?.title) errors.push('`details.fields.title` is required');
    } else if (!op.list?.rows || !op.list.fields) {
      errors.push(`\`${key}.list.rows\` and \`${key}.list.fields\` are required`);
    }
  };
  requireOp('search');
  requireOp('details');
  requireOp('chapters');
  requireOp('pages');

  if (!errors.length) {
    if (!spec.search!.list.fields.title) errors.push('`search.list.fields.title` is required');
    if (!spec.search!.list.fields.url) errors.push('`search.list.fields.url` is required');
    if (!spec.chapters!.list.fields.url) errors.push('`chapters.list.fields.url` is required');
    if (!spec.pages!.list.fields.url) errors.push('`pages.list.fields.url` is required');
  }

  return errors;
}
