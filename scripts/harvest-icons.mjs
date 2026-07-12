/**
 * Icon harvester: copies each catalog preset's real source icon out of the
 * Tachiyomi reference repo (res/mipmap-xhdpi/ic_launcher.png — the actual
 * site logos, curated by the keiyoushi maintainers) into
 * assets/icons/catalog/<presetId>.png, which the build copies into dist.
 *
 *   node scripts/harvest-icons.mjs
 *
 * Matching: preset baseUrl domain (minus www.) against every reference
 * source's gradle baseUrl domain, falling back to reference dir name ==
 * preset id (covers sites that moved domains since the reference snapshot,
 * e.g. yaoihub.net → .org). Misses are listed for manual follow-up; presets
 * without a bundled icon just keep the letter fallback in the UI.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REF = join(HERE, '..', '..', 'references', 'full-ref-mobileapp-repo', 'extensions-source', 'src', 'en');
const OUT = join(HERE, '..', 'assets', 'icons', 'catalog');

const presetsSrc = readFileSync(join(HERE, '..', 'src', 'sources', 'catalog', 'presets.ts'), 'utf8');
const presets = [...presetsSrc.matchAll(/en\('([^']+)',\s*'[^']+',\s*'(https?:\/\/[^']+)'/g)]
  .map((m) => ({ id: m[1], domain: new URL(m[2]).hostname.replace(/^www\./, '') }));

// domain → reference dir, plus the dir set for the id fallback
const byDomain = new Map();
const dirs = new Set();
for (const dir of readdirSync(REF)) {
  const gradle = join(REF, dir, 'build.gradle.kts');
  if (!existsSync(gradle)) continue;
  dirs.add(dir);
  const baseUrl = readFileSync(gradle, 'utf8').match(/baseUrl = "([^"]+)"/)?.[1];
  if (baseUrl) byDomain.set(new URL(baseUrl).hostname.replace(/^www\./, ''), dir);
}

const DENSITIES = ['mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-hdpi', 'mipmap-mdpi'];
const iconFor = (dir) => {
  for (const density of DENSITIES) {
    const p = join(REF, dir, 'res', density, 'ic_launcher.png');
    if (existsSync(p)) return p;
  }
  return null;
};

mkdirSync(OUT, { recursive: true });
let copied = 0;
const misses = [];
for (const { id, domain } of presets) {
  const dir = byDomain.get(domain) ?? (dirs.has(id) ? id : null);
  const icon = dir && iconFor(dir);
  if (!icon) {
    misses.push(`${id} (${domain})`);
    continue;
  }
  copyFileSync(icon, join(OUT, `${id}.png`));
  copied++;
}

console.log(`${copied}/${presets.length} icons copied to assets/icons/catalog/`);
if (misses.length) console.log('no icon found for:', misses.join(', '));
