/**
 * Source catalog - built-in engine presets.
 *
 * Each entry is pure data over a TypeScript engine (Phase A: Madara).
 * Enabling one from the dashboard requests permission for that site's
 * origin only, then registers the engine instance like any other source.
 * Curated EN wave 1, extracted from the Tachiyomi reference repo
 * (references/full-ref-mobileapp-repo/extensions-source); nsfw flags carry
 * over from that repo's content warnings (conservative: sites carrying any
 * mature content are flagged).
 *
 * Validated 2026-07-07 with scripts/test-catalog.mjs: entries that failed
 * authoritatively (dead DNS, moved off Madara, broken search, host errors)
 * were removed. Entries marked "bot wall" or that reset non-browser TLS
 * kept: the engine sends the user's cookies, so passing the site's check
 * once in a normal tab unlocks them. In-app ground truth: the catalog's
 * "Check enabled" button and each source's flask test.
 *
 * Audited 2026-07-11 against the reference repo (domain-matched each preset
 * to its Kotlin source): every entry extends the Madara multisrc except
 * manga18fx ("isn't actually based on Madara" per its source) — dropped.
 * mangaPath seeds carry the reference mangaSubString overrides; loadMore
 * seeds carry LoadMoreStrategy.Always. Both are seeds only: the engine
 * learns/updates them from real result URLs at runtime, so unlisted sites
 * self-correct. Quirks absorbed by engine cascades, no flags needed:
 * style=list-hostile chapters (zinmanga, aquamanga), new vs legacy chapter
 * endpoints, lazy-load attr variants, watermark imgs (mangadistrict).
 *
 * Pruned 2026-07-11 after an in-browser test round: dead domains, bot-walled
 * sites (unlock shelved), and the novel-first wuxiaworld.site (see the
 * scanlator-section comment). Wave 2 harvested same day from the remaining
 * reference EN Madara sources, gated by scripts/test-catalog.mjs --deep.
 */

export type EngineId = 'madara';

export interface CatalogPreset {
  id: string;
  engine: EngineId;
  name: string;
  baseUrl: string;
  lang: string;
  nsfw: boolean;
  iconUrl?: string;
  overrides?: {
    /** URL directory manga live under (default "manga", e.g. Toonily uses "serie").
     *  A seed only — the engine learns the real path from result URLs. */
    mangaPath?: string;
    /** Listings paginate via the admin-ajax load-more POST (reference
     *  LoadMoreStrategy.Always). Seed only; the engine auto-detects. */
    loadMore?: boolean;
    /** Referer sent with requests and image fetches (default baseUrl + "/") */
    referer?: string;
    /** Extra image CDN origins to request permission for at enable time */
    imageHosts?: string[];
    /** Politeness gap between requests, ms (default 350) */
    requestDelayMs?: number;
    /** Cookies to set on the site at enable time (age gates etc.), e.g.
     *  Toonily's { 'toonily-mature': '1' }. Needs the optional cookies perm. */
    cookies?: Record<string, string>;
  };
}

const en = (id: string, name: string, baseUrl: string, nsfw: boolean, overrides?: CatalogPreset['overrides']): CatalogPreset => ({
  id, engine: 'madara', name, baseUrl, lang: 'en', nsfw,
  // Real source icons harvested from the reference repo's launcher icons
  // (scripts/harvest-icons.mjs); UIs fall back to a letter if one is missing
  iconUrl: `assets/icons/catalog/${id}.png`,
  ...(overrides ? { overrides } : {}),
});

export const CATALOG: CatalogPreset[] = [
  // ── General aggregators ──
  en('toonily', 'Toonily', 'https://toonily.com', true, { mangaPath: 'serie', loadMore: true, cookies: { 'toonily-mature': '1' }, imageHosts: ['https://data.tnlycdn.com'] }),
  en('toongod', 'ToonGod', 'https://www.toongod.org', true, { mangaPath: 'webtoons' }),
  en('madaradex', 'MadaraDex', 'https://madaradex.org', true, { mangaPath: 'title' }),
  en('mangareadorg', 'MangaRead.org', 'https://www.mangaread.org', true),
  en('mangaforfree', 'Mangaforfree', 'https://mangaforfree.com', true),
  en('mangadistrict', 'Manga District', 'https://mangadistrict.com', true, { mangaPath: 'series' }),
  en('mangagg', 'MangaGG', 'https://mangagg.com', true),
  en('mangaowlio', 'MangaOwl.io', 'https://mangaowl.io', true, { mangaPath: 'read-1' }),
  en('kissmangain', 'Kissmanga.in', 'https://kissmanga.in', true, { mangaPath: 'kissmanga' }),
  en('mangadia', 'MangaDia', 'https://mangadia.com', false),
  // mangaka.cc dropped 2026-07-12: DNS gone (passed the probe hours earlier)
  en('zinmanga', 'Zinmanga', 'https://mangazin.org', true),
  // zinmanga.net dropped 2026-07-12: migrated off WordPress to a custom JSON
  // backend (/api/comics/{slug}/chapters) behind a Madara-looking skin; no
  // Madara engine can drive it (the reference extension is equally broken)
  en('coffeemanga', 'Coffee Manga', 'https://coffeemanga.ink', true),
  en('s2manga', 'S2Manga', 'https://s2read.com', true, { loadMore: true }),
  en('webtoonxyz', 'WebtoonXYZ', 'https://www.webtoon.xyz', true, { mangaPath: 'read' }),
  en('webtoonscan', 'WebtoonScan', 'https://webtoonscan.com', true),
  en('cocomic', 'Cocomic', 'https://cocomic.co', true),

  // ── Manhua / manhwa aggregators ──
  en('manhuaplus', 'Manhua Plus', 'https://manhuaplus.com', false),
  en('manhuahot', 'ManhuaHot', 'https://manhuahot.com', false),
  en('manhuanext', 'Manhuanext', 'https://manhuanext.com', false),
  en('manhuatop', 'ManhuaTop', 'https://manhuatop.org', true, { mangaPath: 'manhua' }),
  en('manhwatop', 'Manhwatop', 'https://manhwatop.com', true),
  en('manhwa68', 'Manhwa68', 'https://manhwa68.com', true),
  en('manhwaden', 'ManhwaDen', 'https://www.manhwaden.com', true, { imageHosts: ['https://manhwamint.com'] }),
  en('manhwareads', 'Manhwa Reads', 'https://manhwareads.com', true),
  en('manhwaget', 'ManhwaGet', 'https://manhwaget.com', false),
  en('manhwanex', 'ManhwaNex', 'https://manhwanex.com', false),

  // ── Scanlator groups ──
  // Pruned 2026-07-11 (in-browser test round):
  //   dead domains: firescans.xyz, flamescans.lol
  //   bot-walled, unlock shelved (docs/bot-wall-unlock-and-cors.md):
  //     dragontea.ink, manhuafast.net, manhuaus.com, setsuscans.com
  //     — re-add when unlock ships
  //   wuxiaworld.site: primarily web novels (reference mangaSubString
  //     "novel"); typical entries have text chapters, so pages come up
  //     empty — not shippable as a manga source
  en('aquamanga', 'Aqua Manga', 'https://aquareader.org', false),
  en('lhtranslation', 'LHTranslation', 'https://lhtranslation.net', false),
  en('mangasushi', 'Mangasushi', 'https://mangasushi.org', false),
  en('rdscans', 'RD Scans', 'https://rdscans.com', false, { mangaPath: 'new', imageHosts: ['https://blogger.googleusercontent.com'] }),
  en('sleepytranslations', 'Sleepy Translations', 'https://sleepytranslations.com', false),
  en('tritiniascans', 'TritiniaScans', 'https://tritinia.org', false),
  en('yakshacomics', 'YakshaComics', 'https://yakshacomics.com', false),
  en('gakamangas', 'GakaMangas', 'https://gakamangas.com', false),
  en('bunmanga', 'Bun Manga', 'https://bunmanga.com', false, { loadMore: true }),

  // ── 18+ ──
  // manga18fx dropped 2026-07-11: mimics Madara markup but is a custom CMS
  // (own /search?q= endpoint, bsx-item rows, .row-content-chapter chapters)
  en('manga18free', 'Manga18Free', 'https://manga18free.com', true),
  // manhwa18.org dropped 2026-07-12: HTTP 521, origin dead behind Cloudflare
  en('milftoon', 'Milftoon', 'https://milftoon.xxx', true, { mangaPath: 'comics' }),
  // toon18.to dropped 2026-07-11: ENOTFOUND (domain dead)
  en('toonizy', 'Toonizy', 'https://toonizy.com', true),
  en('lilymanga', 'Lily Manga', 'https://lilymanga.net', true, { mangaPath: 'ys' }),

  // ── Wave 2 (2026-07-11) — probe-verified ──
  // Harvested from the remaining reference EN Madara sources
  // (scripts/harvest-madara.mjs); full pipeline (listing → chapters → pages
  // markup) confirmed live by scripts/test-catalog.mjs --deep. nsfw flags
  // carry the reference repo's conservative content warnings. yaoihub ships
  // with its redirect target (.net 301s to .org).
  en('anisascans', 'Anisa Scans', 'https://anisascans.in', true, { imageHosts: ['https://like.mgread.io'] }),
  en('cucumbermanga', 'Cucumber Manga', 'https://cucumbermanga.com', true, { loadMore: true }),
  en('decadencescans', 'Decadence Scans', 'https://reader.decadencescans.com', true),
  en('galaxydegenscans', 'GalaxyDegenScans', 'https://gdscans.com', true),
  en('gourmetscans', 'Gourmet Scans', 'https://gourmetsupremacy.com', true, { mangaPath: 'project' }),
  en('jinmangas', 'Jinmangas', 'https://jinmangas.com', true, { loadMore: true }),
  en('ksgroupscans', 'KSGroupScans', 'https://ksgroupscans.com', true),
  en('likemangain', 'MangaYY', 'https://mangayy.org', true, { imageHosts: ['https://like.mgread.io'] }),
  en('manga18x', 'Manga 18x', 'https://manga18x.net', true, { imageHosts: ['https://manhwaclub.net'] }),
  en('mangafree', 'Mangafree', 'https://mangafree.info', true, { loadMore: true }),
  en('mangahe', 'MangaHe', 'https://mangahe.com', true),
  en('mangamaniacs', 'MangaManiacs', 'https://mangamaniacs.org', true),
  en('manhwacomics', 'Manhwa Comics', 'https://manhwacomics.com', true, { mangaPath: 'manhwa', imageHosts: ['https://pub-68b6bd343af74393bfdb7b261199f610.r2.dev'] }),
  en('manhwatoon', 'Manhwa Toon', 'https://www.manhwatoon.me', true, { loadMore: true }),
  en('octopusmanga', 'OctopusManga', 'https://octopusmanga.com', true, { loadMore: true }),
  en('orchisasia', 'Orchisasia', 'https://www.orchisasia.org', true, { mangaPath: 'comic' }),
  en('topmanhuanet', 'TopManhua.net', 'https://topmanhua.net', true),
  en('wearehunger', 'KokoMangas', 'https://kokomangas.com', true, { loadMore: true }),
  en('yaoihub', 'Yaoihub', 'https://yaoihub.org', true),

  // ── Wave 2 (2026-07-11) — pending one in-browser "Test all" round ──
  // The Node probe couldn't judge these: their edge resets/challenges Node's
  // TLS fingerprint, while the extension rides real browser TLS and the
  // user's cookies and often passes (docs/bot-wall-unlock-and-cors.md,
  // "Node TLS pessimism"). Run the catalog's Test all, then prune whatever
  // comes back failed/blocked. Authoritative Node deaths (ENOTFOUND,
  // non-Madara markup, CF 5xx origin errors) were already dropped.
  // Browser round 2026-07-12: aryascans + boratscans confirmed bot-walled
  // (403 in the extension too), mangakiss.org origin dead behind CF — dropped
  en('allporncomic', 'AllPornComic', 'https://allporncomic.com', true, { mangaPath: 'porncomic' }),
  en('allporncomicio', 'AllPornComic.io', 'https://allporncomic.io', true),
  en('apcomics', 'AP Comics', 'https://apcomics.org', true),
  en('ero18x', 'Ero18x', 'https://ero18x.com', true),
  en('gedecomix', 'GEDE Comix', 'https://gedecomix.com', true, { mangaPath: 'porncomic' }),
  // Pruned 2026-07-12 (two in-browser Test all rounds, with and without VPN):
  //   gingertoon, manhwajoy, shibamanga, whalemanga: zero rows from listing
  //   AND search in both runs; mangahentai.me unreachable in both
  en('hentai4free', 'Hentai4Free', 'https://hentai4free.net', true, { mangaPath: 'hentai' }),
  en('hentaisco', 'HentaiSco', 'https://hentaisco.cc', true, { mangaPath: 'hentai', imageHosts: ['https://cdn.hentaisco.com'] }),
  en('hentaixcomic', 'HentaiXComic', 'https://hentaixcomic.com', true),
  en('hentaixdickgirl', 'HentaiXDickgirl', 'https://hentaixdickgirl.com', true),
  en('hentaixyuri', 'HentaiXYuri', 'https://hentaixyuri.com', true),
  en('hm2d', 'HM2D', 'https://doujindistrict.com', true),
  en('linkmanga', 'LinkManga', 'https://linkmanga.com', true),
  en('mahouirexnohentaikarte', 'Mahouirexnohentaikarte', 'https://mahouirexnohentaikarte.com', true),
  en('manhuazonghe', 'Manhua Zonghe', 'https://www.manhuazonghe.com', true, { mangaPath: 'manhua' }),
  en('petrotechsociety', 'Petrotechsociety', 'https://www.petrotechsociety.org', true),
  en('yaoiscan', 'YaoiScan', 'https://yaoiscan.com', true),
];

const byId = new Map(CATALOG.map((p) => [p.id, p]));

export function getCatalogPreset(id: string): CatalogPreset | undefined {
  return byId.get(id);
}
