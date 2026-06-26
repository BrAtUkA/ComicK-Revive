/**
 * Package the built extension into an installable zip for non-developers.
 *
 * Usage: `npm run package` (runs the build first, then this script).
 * Output: release/comick-revive-v<version>.zip
 *
 * A user installs it by unzipping and loading the folder via
 * chrome://extensions → Developer mode → "Load unpacked".
 */
const { resolve } = require('path');
const { existsSync, mkdirSync } = require('fs');
const AdmZip = require('adm-zip');
const pkg = require('../package.json');

const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');
const outDir = resolve(root, 'release');

if (!existsSync(distDir)) {
  console.error('[package] dist/ not found — run "npm run build" first.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const outFile = resolve(outDir, `comick-revive-v${pkg.version}.zip`);
const zip = new AdmZip();
zip.addLocalFolder(distDir);
zip.writeZip(outFile);

console.log(`[package] Wrote ${outFile}`);
