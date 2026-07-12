# Adding sources

ComicK Revive can read from any site it has a *source* for. There are three ways to add one, easiest first:

| | Way | Effort | For |
|--|-----|--------|-----|
| 1 | [Source catalog](#1-the-source-catalog) | One click | 70+ sites that ship built in |
| 2 | [JSON source spec](#2-json-source-specs) | Write (or AI-generate) one JSON file | Most HTML/JSON manga sites |
| 3 | [Built-in TypeScript source](#3-built-in-typescript-sources) | Code + rebuild | Sites needing tokens, descrambling, or custom logic |

---

## 1. The source catalog

**Dashboard → Sources → Browse catalog.**

The catalog ships 70+ curated sites (scanlators and aggregators running the Madara engine), each validated end to end. Enabling one asks for permission to **that site only**; the extension never requests blanket host access. Removing a source revokes its permission again.

Useful things in the catalog modal:

- **Test all** runs the full pipeline (search → chapters → pages → first image) against every listed site from *your* network, with a live pass/fail bar. **Copy report** produces a paste-ready diagnostic for bug reports.
- Status chips are honest: `works` / `partial` (readable, but the image CDN needs a one-click grant; click the chip) / `blocked` (the site runs a bot check; passing it once in a normal tab often clears it) / `failed`.
- Availability differs by country and network. A site that fails on your ISP may work over a VPN, and vice versa; the chips reflect your reality, not a promise.
- 18+ sites are hidden by default; flip **Show 18+ sources** (in the modal, or Settings → Behavior).

---

## 2. JSON source specs

A **source spec** is a single JSON object that teaches the reader how to search a site and read chapters from it. No rebuild, no code: import it and it runs.

**Import:** Dashboard → Sources → **Add source** → paste the JSON, load a file, or fetch from a URL.
**Generate:** the same dialog has a **copy AI prompt** button: paste that prompt into any capable AI assistant along with the site's URL, and it writes the spec for you.
**Test:** every source row has a flask icon that checks search, details, chapters, and pages against the live site and tells you exactly which step failed. Iterate with the AI by pasting it the error.

### Start from an example

Two known-working specs ship in [`specs/`](../specs):

- [**`mangapill.json`**](../specs/mangapill.json): the clean starter. A typical HTML site: search page, lazy-loaded `data-src` images, a status `map`, chapter list on the manga page. Copy this shape.
- [**`weebcentral.json`**](../specs/weebcentral.json): the advanced one. Offset-based pagination (`pageSize` + `{offset}`), query preprocessing (`queryReplace`), deeply scoped selectors with `containsText` + `then` chains, `srcset` parsing with `regex`, and a `fallback` rule.

### Top-level fields

| Field | Required | Meaning |
|-------|:--:|---------|
| `spec` | ✅ | Always `1` |
| `id` | ✅ | Unique lowercase identifier, letters/digits/dashes (2–41 chars) |
| `name` | ✅ | Display name |
| `baseUrl` | ✅ | The site's `https://` URL, no trailing slash |
| `iconUrl` | | Site logo URL |
| `lang` | | e.g. `"en"` |
| `referer` | | Sent as the `Referer` header (via a DNR rule). Set to `baseUrl + "/"` if the site rejects referer-less requests |
| `headers` | | Extra request headers (best effort) |
| `imageHosts` | | Match patterns for image CDN origins **when they differ from baseUrl** (e.g. `"https://*.lowee.us/*"`). Access is requested at import; without it, image fetches are CORS-blocked. Unsure or rotating CDNs → `["https://*/*"]` |
| `requestDelayMs` | | Politeness gap between requests, e.g. `1000`–`2000` for rate-limited sites |

### The four operations

Each of `search`, `details`, `chapters`, `pages` is a `url` template plus extraction rules.

**URL template placeholders:** `{base}` `{query}` `{page}` `{offset}` `{slug}` `{chapterSlug}`
`{offset}` = `(page − 1) × search.pageSize`. The `slug` is derived from each search result's URL via `slugRegex` (first capture group); chapter slugs likewise via `chapterSlugRegex`. Slug regex and URL templates must round-trip: whatever the regex captures gets substituted back into the details/chapters/pages URLs.

| Operation | Extraction | Extra keys |
|-----------|-----------|------------|
| `search` | `list.rows` + `list.fields`: `title`✅ `url`✅ `thumbnail` | `pageSize`, `queryReplace: [pattern, replacement]`, `slugRegex` |
| `details` | `fields`: `title`✅ `description` `author` `artist` `status` `genres` `thumbnail` | `genresJoin` (default `", "`) |
| `chapters` | `list.rows` + `list.fields`: `url`✅ `title` `number` `date` | `chapterSlugRegex`, `dateFormat` (`"iso"`, `"epoch"`, or a pattern like `"MMM dd, yyyy"`) |
| `pages` | `list.rows` + `list.fields`: `url`✅ | |

**Response types:** `"response": "html"` (default), `"json"` (use `path` in field rules), or `"json-html"` (a JSON field contains an HTML string; point `htmlPath` at it, then use CSS selectors as usual).

### Field rules

Every field is an object combining any of:

| Key | Meaning |
|-----|---------|
| `sel` | CSS selector relative to the row/scope. Omit to use the scope itself |
| `attr` | Attribute to read (`href`, `src`, `data-src`, `srcset`, `datetime`…). Omit for text content |
| `index` | Pick the Nth match of `sel` (default 0) |
| `containsText` | Among `sel` matches, keep the first whose text contains this string |
| `then` | Nest another rule to keep selecting *inside* the matched element |
| `ownText` | `true` = only the element's own text, not its children |
| `path` | JSON path for `json` responses, e.g. `"result.items[0].name"` |
| `regex` | Post-process: first capture group wins (e.g. `"^\\S+"` strips srcset width descriptors) |
| `replace` | Ordered `[pattern, replacement]` regex pairs |
| `map` | Exact-match lookup table (great for status normalization) |
| `fallback` | A whole alternative rule tried when this one yields nothing |

### The rules that break most specs

1. **Selectors are browser CSS, not Jsoup.** `:contains()` does not exist; use `containsText` + `then`. `[attr~=x]` means whitespace-separated word in CSS; for substring matching use `[attr*=x]`.
2. **Scope your details selectors.** Bare `img` or `h1` on the whole page grabs the site logo or a random heading. Anchor to the content section first, then select inside it with `then`.
3. **Lazy-loaded images** usually keep the real URL in `data-src` or `data-lazy-src`, not `src`. Check search thumbnails and chapter pages.
4. **Relative URLs are fine**; the extension resolves them against `baseUrl`.
5. **Some sites can't work as specs.** Anything needing JavaScript-computed tokens, image descrambling, POST bodies, or multi-step request chains is out of scope for the JSON format; those need a built-in TypeScript source.

### Workflow that works

1. Import a rough spec (yours or AI-written).
2. Run the flask **test**; it stops at the first broken step with details.
3. Fix (or paste the error back to the AI), re-import, re-test.
4. When all four steps pass, link a manga and read a chapter to confirm images load. If pages parse but images fail, it's usually `imageHosts` (grant the CDN) or `referer`.

---

## 3. Built-in TypeScript sources

For contributors, when a site needs real logic:

1. Implement the `MangaSource` interface (`src/sources/Source.interface.ts`) in `src/sources/YourSource.ts`.
2. Register it in `src/sources/index.ts`; it gets wrapped in the caching layer automatically.
3. Add the site's domains to `host_permissions` in `manifest.json` (and a DNR rule in `rules/` if the CDN needs a `Referer`).
4. Add its domain config to `src/utils/sourceDomains.ts` if it needs special headers.

**Shortcut for Madara sites:** if the site runs the Madara WordPress theme (a huge share of scanlator sites; the telltale is `/manga/` URLs and `wp-manga` markup), you don't need code at all. Add a one-line preset in `src/sources/catalog/presets.ts` and run `node scripts/test-catalog.mjs --deep <id>` to validate it. `scripts/harvest-icons.mjs` pulls its icon.

The Kotlin implementations in the [keiyoushi extensions repo](https://github.com/keiyoushi/extensions-source) are the best reference for how each site actually behaves.
