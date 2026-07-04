/**
 * The copyable prompt users paste into an AI assistant to generate a
 * SourceSpecV1 for a site. It encodes the full format plus every hard-won
 * lesson from building the interpreter (Jsoup vs CSS, CDN rotation, scoped
 * selectors), so a non-technical user can get a working spec by iterating
 * with the AI and the built-in test harness.
 */

export const SPEC_AI_PROMPT = `You are helping me create a "source spec" for ComicK Revive, a manga reader browser extension. A source spec is a single JSON object that teaches the reader how to search a manga website and read chapters from it. You write the JSON; I will paste it into the extension and report back what its test tool says.

THE SITE I WANT: <PUT THE SITE'S URL HERE, e.g. https://example-scans.com>

Ask me for the site URL if I forgot to replace the placeholder. If you can browse the web, inspect the site's HTML yourself; otherwise ask me to paste the HTML of a search results page, a manga page, and a chapter page.

=== FORMAT: SourceSpecV1 ===
Top-level fields:
- "spec": always 1
- "id": short lowercase identifier, letters/digits/dashes (e.g. "examplescans")
- "name": display name
- "baseUrl": the site's https URL, no trailing slash
- "iconUrl" (optional): site logo URL
- "lang" (optional): e.g. "en"
- "referer" (optional): set to baseUrl + "/" if the site rejects requests without a Referer
- "imageHosts" (optional): array of URL match patterns for the domains chapter images are served from, WHEN they differ from baseUrl. If the site rotates image CDNs or you are unsure, use ["https://*/*"]
- "requestDelayMs" (optional): politeness delay between requests, e.g. 1000-2000 for rate-limited sites

Four operations, each with a "url" template and extraction rules:
- "search": finding manga by title
- "details": one manga's info (title, cover, description...)
- "chapters": the chapter list
- "pages": the image URLs of one chapter

URL templates may use: {base} {query} {page} {offset} {slug} {chapterSlug}
- {offset} = (page - 1) * search.pageSize (set "pageSize" if the site paginates by offset)
- "slug" is derived from each search result's URL via "slugRegex" (first capture group). Same idea for chapters via "chapterSlugRegex". The slug is later substituted into the details/chapters/pages URLs, so make sure regex + templates round-trip correctly.

Response types per operation: "response": "html" (default), "json", or "json-html" (a JSON field contains an HTML string; point "htmlPath" at it).

List extraction ("search", "chapters", "pages"): { "rows": "<CSS selector or JSON path to array>", "fields": { ... } }
- search fields: title, url (required), thumbnail
- chapters fields: url (required), title, number, date (+ "dateFormat": "iso", "epoch", or a pattern like "MMM dd, yyyy")
- pages fields: url (required)

Details extraction: "fields" with title (required), description, author, artist, status, genres, thumbnail.

FIELD RULES (each field is an object):
- "sel": CSS selector relative to the row/scope. Omit to use the scope itself
- "attr": attribute to read (href, src, data-src, srcset, datetime...); omit for text content
- "index": pick the Nth match of sel (default 0)
- "containsText": among sel matches, keep the first whose text contains this string
- "then": nest another rule to keep selecting INSIDE the matched element
- "regex": post-process, first capture group wins (e.g. "^\\\\S+" strips srcset width descriptors)
- "replace": array of [pattern, replacement] regex pairs
- "map": exact-match lookup table (great for status normalization)
- "fallback": a whole alternative rule tried when this one yields nothing
- "path": JSON path like "result.items[0].name" for json responses
- "ownText": true to read only the element's own text, not children

CRITICAL RULES (violating these is the #1 cause of broken specs):
1. Selectors are standard browser CSS, NOT Jsoup. ":contains()" DOES NOT EXIST: use "containsText" + "then" instead. "[attr~=x]" means whitespace-word in CSS; for substring matching use "[attr*=x]".
2. Scope details fields to the content area (e.g. a specific section), never use bare "img" or "h1" on the whole page: you will grab the site logo or a random heading.
3. Lazy-loaded images often keep the real URL in "data-src" or "data-lazy-src", not "src". Check for this on search thumbnails and chapter pages.
4. Relative URLs are fine; the extension resolves them against baseUrl.
5. Sites that require running JavaScript to get tokens, or that scramble/encrypt images, CANNOT work with this format. Say so honestly instead of guessing.

=== COMPLETE WORKING EXAMPLE (WeebCentral) ===
{
  "spec": 1,
  "id": "weebcentral",
  "name": "WeebCentral",
  "baseUrl": "https://weebcentral.com",
  "lang": "en",
  "referer": "https://weebcentral.com/",
  "imageHosts": ["https://*/*"],
  "requestDelayMs": 2000,
  "search": {
    "url": "{base}/search/data?text={query}&limit=32&offset={offset}&sort=Best+Match&order=Descending&display_mode=Full+Display",
    "pageSize": 32,
    "queryReplace": ["[!#:(),\\\\-]", " "],
    "list": {
      "rows": "article > section > a",
      "fields": {
        "title": { "sel": "div:not([class])" },
        "url": { "attr": "href" },
        "thumbnail": { "sel": "img", "attr": "src" }
      }
    },
    "slugRegex": "/series/([^/]+)"
  },
  "details": {
    "url": "{base}/series/{slug}",
    "fields": {
      "title": { "sel": "section[x-data] > section", "index": 1, "then": { "sel": "h1" } },
      "description": { "sel": "section[x-data] > section", "index": 1, "then": { "sel": "li", "containsText": "Description", "then": { "sel": "p" } } },
      "author": { "sel": "section[x-data] > section", "index": 0, "then": { "sel": "ul > li", "containsText": "Author", "then": { "sel": "span > a" } } },
      "status": {
        "sel": "section[x-data] > section", "index": 0,
        "then": { "sel": "ul > li", "containsText": "Status", "then": { "sel": "a" } },
        "map": { "Ongoing": "Ongoing", "Complete": "Completed", "Hiatus": "Hiatus", "Canceled": "Cancelled" }
      },
      "genres": { "sel": "section[x-data] > section", "index": 0, "then": { "sel": "ul > li", "containsText": "Tag", "then": { "sel": "a" } } },
      "thumbnail": {
        "sel": "section[x-data] > section", "index": 0,
        "then": { "sel": "source", "attr": "srcset", "regex": "^\\\\S+", "replace": [["small", "normal"]] },
        "fallback": { "sel": "section[x-data] > section", "index": 0, "then": { "sel": "img", "attr": "src" } }
      }
    }
  },
  "chapters": {
    "url": "{base}/series/{slug}/full-chapter-list",
    "list": {
      "rows": "div[x-data] > a",
      "fields": {
        "url": { "attr": "href" },
        "title": { "sel": "span.flex > span" },
        "date": { "sel": "time[datetime]", "attr": "datetime" }
      }
    },
    "chapterSlugRegex": "/chapters/([^/?#]+)",
    "dateFormat": "iso"
  },
  "pages": {
    "url": "{base}/chapters/{chapterSlug}/images?is_prev=False&reading_style=long_strip",
    "list": {
      "rows": "section[x-data*=scroll] > img",
      "fields": { "url": { "attr": "src" } }
    }
  }
}

=== YOUR TASK ===
1. Figure out the site's URL patterns for search, manga pages, chapter lists, and chapter images (browse or ask me for page HTML).
2. Produce the complete spec as ONE JSON code block, nothing else around it.
3. Tell me in one short sentence anything you were unsure about.
I will paste the JSON into the extension and run its test tool (it checks search, details, chapters, and pages). If a step fails I will paste you the exact error and we iterate.`;
