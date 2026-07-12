/**
 * Catalog live-site probe. Mirrors the engine's discovery order: the popular
 * listing (GET {base}/{mangaPath}/?m_orderby=views, falling back to the
 * admin-ajax madara_load_more POST) is the primary probe, the search page a
 * secondary one; on success the first result's manga page + chapter cascade
 * runs too (--deep). Node's fetch lacks browser TLS/cookies, so treat
 * BLOCKED results as pessimistic (the extension, with the user's cookies,
 * may still pass); DEAD/MOVED/NOROWS results are authoritative.
 *
 * Run: node scripts/test-catalog.mjs [--deep] [--json candidates.json] [id ...]
 * --json probes harvest-madara.mjs output instead of the shipped presets.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
let presets;
if (jsonIdx !== -1) {
  presets = JSON.parse(readFileSync(args[jsonIdx + 1], 'utf8'))
    .map((p) => ({ mangaPath: 'manga', loadMore: false, ...p }));
  args.splice(jsonIdx, 2);
} else {
  const presetsSrc = readFileSync(new URL('../src/sources/catalog/presets.ts', import.meta.url), 'utf8');
  const entryRe = /en\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(true|false)(?:,\s*(\{[^}]*\}))?\)/g;
  presets = [];
  for (const m of presetsSrc.matchAll(entryRe)) {
    let mangaPath = 'manga';
    const pathMatch = m[5]?.match(/mangaPath:\s*'([^']+)'/);
    if (pathMatch) mangaPath = pathMatch[1];
    const loadMore = /loadMore:\s*true/.test(m[5] ?? '');
    presets.push({ id: m[1], name: m[2], baseUrl: m[3], nsfw: m[4] === 'true', mangaPath, loadMore });
  }
}

const deep = args.includes('--deep');
const only = args.filter((a) => !a.startsWith('--'));
const targets = only.length ? presets.filter((p) => only.includes(p.id)) : presets;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function probe(url, referer, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, ...(referer ? { Referer: referer } : {}), ...(init.headers || {}) },
      redirect: 'manual',
      signal: controller.signal,
      ...init,
    });
    const body = res.status >= 200 && res.status < 300 ? await res.text() : '';
    return { status: res.status, location: res.headers.get('location'), body };
  } catch (error) {
    return { status: 0, error: error?.cause?.code || error?.name || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Follow up to 4 redirects, reporting if we leave the original host */
async function follow(url, referer, init) {
  let current = url;
  for (let i = 0; i < 4; i++) {
    const r = await probe(current, referer, init);
    if (r.status >= 300 && r.status < 400 && r.location) {
      current = new URL(r.location, current).href;
      continue;
    }
    return { ...r, finalUrl: current };
  }
  return { status: 0, error: 'redirect-loop', finalUrl: current };
}

/** Listing/search result rows across Madara skins */
function countRows(body) {
  return ((body.match(/page-item-detail/g) || []).length
    + (body.match(/manga__item/g) || []).length)
    || (body.match(/c-tabs-item__content/g) || []).length;
}

/** The engine's primary discovery path: archive GET, then load-more POST. */
async function probeListing(p) {
  if (!p.loadMore) {
    const r = await follow(`${p.baseUrl}/${p.mangaPath}/?m_orderby=views`, p.baseUrl + '/');
    const rows = countRows(r.body || '');
    if (rows > 0) {
      const ajax = /navigation-ajax/.test(r.body) ? ', load-more pagination' : '';
      return { rows, note: `${rows} rows via GET archive${ajax}`, r };
    }
  }
  const body = new URLSearchParams({
    'action': 'madara_load_more',
    'page': '0',
    'template': 'madara-core/content/content-archive',
    'vars[orderby]': 'meta_value_num',
    'vars[paged]': '1',
    'vars[post_type]': 'wp-manga',
    'vars[post_status]': 'publish',
    'vars[meta_key]': '_wp_manga_views',
    'vars[order]': 'desc',
    'vars[sidebar]': 'right',
    'vars[manga_archives_item_layout]': 'big_thumbnail',
  }).toString();
  const x = await follow(`${p.baseUrl}/wp-admin/admin-ajax.php`, p.baseUrl + '/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  const rows = countRows(x.body || '');
  return { rows, note: rows > 0 ? `${rows} rows via load-more POST` : 'listing: 0 rows', r: x };
}

function classify(p, r) {
  if (r.status === 0) return { verdict: 'DEAD', note: r.error };
  const origHost = new URL(p.baseUrl).hostname.replace(/^www\./, '');
  const finalHost = new URL(r.finalUrl).hostname.replace(/^www\./, '');
  const moved = origHost !== finalHost ? ` -> ${finalHost}` : '';
  if (r.status === 403 || r.status === 503 || /just a moment|cf-browser-verification|challenge-platform|_cf_chl/i.test(r.body || '')) {
    return { verdict: 'BLOCKED', note: `HTTP ${r.status}${moved} (bot wall)` };
  }
  if (r.status === 404) return { verdict: 'HTTP404', note: `search path missing${moved}` };
  if (r.status >= 400) return { verdict: `HTTP${r.status}`, note: moved.trim() };
  const rows = countRows(r.body || '');
  const isMadara = /wp-manga|madara/i.test(r.body);
  if (rows > 0) return { verdict: 'PASS', note: `${rows} rows${moved}`, moved: !!moved };
  if (isMadara) return { verdict: 'NOROWS', note: `madara markup, 0 result rows${moved}` };
  return { verdict: 'NOTMADARA', note: `no madara markers${moved}` };
}

const results = [];
let i = 0;
const queue = [...targets];
async function worker() {
  while (queue.length) {
    const p = queue.shift();

    // Primary probe: popular listing (matches the extension's quickCheck)
    const listing = await probeListing(p);

    // Secondary probe: search page
    const searchUrl = `${p.baseUrl}/?s=the&post_type=wp-manga`;
    const r = await follow(searchUrl, p.baseUrl + '/');
    const c = classify(p, r);

    let verdict = c.verdict;
    let note = c.note || '';
    if (listing.rows > 0) {
      verdict = 'PASS';
      note = `${listing.note}; search: ${c.verdict === 'PASS' ? c.note : c.verdict.toLowerCase()}`;
    } else if (c.verdict === 'PASS') {
      note = `${c.note} (search); ${listing.note}`;
    }

    let extra = '';
    if (deep && verdict === 'PASS') {
      const sourceBody = listing.rows > 0 ? (listing.r.body || '') : (r.body || '');
      // Mirror the engine's title-link cascade: .post-title a, then bare h3-h5 a
      const link = sourceBody.match(/class="post-title[^>]*>\s*<h[1-6][^>]*>\s*<a[^>]*href="([^"]+)"/)
        ?? sourceBody.match(/<h[3-5][^>]*>\s*<a[^>]*href="([^"]+)"/);
      if (link) {
        const mangaUrl = new URL(link[1], p.baseUrl).href;
        const m = await follow(mangaUrl, p.baseUrl + '/');
        let chaptersBody = m.body || '';
        // Chapter ROWS, not string occurrences: the class name also shows up
        // in inline CSS/widgets on pages whose real list loads via the XHR
        const rowsIn = (body) => (body.match(/<li\s[^>]*wp-manga-chapter/g) || []).length;
        let embedded = rowsIn(chaptersBody);
        if (embedded > 0) extra = ` · chapters embedded:${embedded}`;
        else {
          const x = await follow(mangaUrl.replace(/\/?$/, '/') + 'ajax/chapters/', p.baseUrl + '/', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Length': '0' } });
          const xhrRows = rowsIn(x.body || '');
          extra = xhrRows > 0 ? ` · chapters xhr:${xhrRows}` : ` · CHAPTERS NOT FOUND (embed 0, xhr ${x.status})`;
          chaptersBody = x.body || '';
        }

        // Pages check: oldest chapter must contain reader images (or the AES
        // chapter protector, which the engine decrypts). Catches novel/text
        // sites and custom readers that scrape fine until the last step.
        const chapLinks = [...chaptersBody.matchAll(/<li\s[^>]*wp-manga-chapter[\s\S]{0,300}?<a[^>]*href="([^"]+)"/g)].map((c) => c[1]);
        if (chapLinks.length > 0) {
          const chapUrl = new URL(chapLinks[chapLinks.length - 1], p.baseUrl).href;
          const styled = chapUrl + (chapUrl.includes('?') ? '&' : '?') + 'style=list';
          const ch = await follow(styled, mangaUrl);
          const chBody = ch.body || '';
          const readerIdx = chBody.indexOf('reading-content');
          const imgs = readerIdx === -1 ? 0 : (chBody.slice(readerIdx).match(/<img/g) || []).length;
          if (imgs > 0) extra += ` · pages:${imgs}`;
          else if (/chapter-protector-data/.test(chBody)) extra += ' · pages:protector';
          else extra += ` · PAGES NOT FOUND (http ${ch.status})`;
        }
      } else {
        extra = ' · no post-title link parsed';
      }
    }
    results.push({ ...p, verdict, note: note + extra });
    process.stderr.write(`\r${++i}/${targets.length} ${p.id.padEnd(20)}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
process.stderr.write('\n');

results.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.id.localeCompare(b.id));
const counts = {};
for (const r of results) {
  counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`${r.verdict.padEnd(10)} ${r.id.padEnd(20)} ${r.note}`);
}
console.log('\nSummary: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
