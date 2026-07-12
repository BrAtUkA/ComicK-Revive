/**
 * Preset harvester: walks the Tachiyomi reference repo's EN Madara sources
 * (references/full-ref-mobileapp-repo/extensions-source/src/en/*) and emits
 * candidate catalog presets as JSON, skipping domains we already ship or
 * pruned. Feed the output to the live-site probe:
 *
 *   node scripts/harvest-madara.mjs > /tmp/candidates.json
 *   node scripts/test-catalog.mjs --deep --json /tmp/candidates.json
 *
 * Extracted per source: baseUrl + display name (build.gradle.kts), nsfw
 * (contentWarning != SAFE), mangaPath (Kotlin mangaSubString override),
 * loadMore (LoadMoreStrategy.Always). Kotlin overrides our engine has no
 * equivalent for are surfaced as `flags` so heavily customized sources can
 * be reviewed by hand instead of shipped blind.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REF = new URL('../../references/full-ref-mobileapp-repo/extensions-source/src/en/', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1'); // strip leading slash on Windows drive paths

const PRESETS = readFileSync(new URL('../src/sources/catalog/presets.ts', import.meta.url), 'utf8');
const shippedHosts = new Set(
  [...PRESETS.matchAll(/'(https:\/\/[^']+)'/g)]
    .map((m) => new URL(m[1]).hostname.replace(/^www\./, ''))
);
// Pruned 2026-07-11 (dead / bot-walled / novel-first) — never re-suggest
for (const host of [
  'firescans.xyz', 'flamescans.lol', 'wuxiaworld.site', 'dragontea.ink',
  'manhuafast.net', 'manhuaus.com', 'setsuscans.com', 'manga18fx.com',
]) shippedHosts.add(host);

// Kotlin overrides the TS engine genuinely reimplements or absorbs via its
// cascades — safe to ignore when flagging customization.
const ABSORBED = new Set([
  'mangaSubString', 'useLoadMoreRequest', 'useNewChapterEndpoint',
  'dateFormat', 'filterNonMangaItems', 'mangaEntrySelector',
  'chapterUrlSuffix', 'chapterUrlSelector', 'mangaDetailsSelectorTitle',
  'mangaDetailsSelectorStatus', 'mangaDetailsSelectorDescription',
  'mangaDetailsSelectorAuthor', 'mangaDetailsSelectorArtist',
  'mangaDetailsSelectorGenre', 'mangaDetailsSelectorThumbnail',
  'mangaDetailsSelectorTag', 'popularMangaUrlSelector',
  'searchMangaSelector', 'popularMangaSelector', 'seriesTypeSelector',
  'altNameSelector', 'altName', 'versionId', 'supportsLatest',
  'sendViewCount', 'defaultUserAgentProvider',
]);

const candidates = [];
for (const dir of readdirSync(REF)) {
  const gradlePath = join(REF, dir, 'build.gradle.kts');
  if (!existsSync(gradlePath)) continue;
  const gradle = readFileSync(gradlePath, 'utf8');
  if (!/theme = "madara"/.test(gradle)) continue;

  const name = gradle.match(/name = "([^"]+)"/)?.[1] ?? dir;
  const baseUrl = gradle.match(/baseUrl = "([^"]+)"/)?.[1];
  if (!baseUrl) continue;
  const host = new URL(baseUrl).hostname.replace(/^www\./, '');
  if (shippedHosts.has(host)) continue;
  const nsfw = !/contentWarning = ContentWarning\.SAFE/.test(gradle);

  // The source class (may be absent: pure-preset sources exist)
  let kt = '';
  const ktDir = join(REF, dir, 'src', 'eu', 'kanade', 'tachiyomi', 'extension', 'en', dir);
  if (existsSync(ktDir)) {
    for (const f of readdirSync(ktDir)) {
      if (f.endsWith('.kt')) kt += readFileSync(join(ktDir, f), 'utf8');
    }
  }

  const mangaPath = kt.match(/mangaSubString\s*=\s*"([^"]+)"/)?.[1];
  const loadMore = /LoadMoreStrategy\.Always/.test(kt);

  // Anything else overridden is a potential behavior gap in our engine
  const flags = [...kt.matchAll(/override\s+(?:val|var|fun)\s+(\w+)/g)]
    .map((m) => m[1])
    .filter((n) => !ABSORBED.has(n));

  candidates.push({
    id: dir, name, baseUrl, nsfw,
    ...(mangaPath ? { mangaPath } : {}),
    ...(loadMore ? { loadMore } : {}),
    ...(flags.length ? { flags: [...new Set(flags)] } : {}),
  });
}

candidates.sort((a, b) => a.id.localeCompare(b.id));
console.log(JSON.stringify(candidates, null, 2));
console.error(`${candidates.length} candidates (skipped ${shippedHosts.size} shipped/pruned hosts)`);
