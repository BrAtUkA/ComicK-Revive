import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

// Resolve everything against the directory npm ran the build from (the
// package root). This is identical on every OS and Node version, unlike
// `__dirname`, which Vite has to shim inside its temporary ESM-compiled
// config and which resolved differently under Linux/Node 20 in CI (the
// source of the "manifest.json ENOENT / only 10 modules" release failure).
const projectRoot = process.cwd();
const fromRoot = (...segments: string[]) => resolve(projectRoot, ...segments);

// Plugin to copy manifest and static assets into dist after the bundle.
const copyManifestPlugin = () => ({
  name: 'copy-manifest',
  closeBundle() {
    const distDir = fromRoot('dist');
    // The bundle write should have created dist, but guarantee it so a copy
    // can never fail on a missing destination directory.
    mkdirSync(distDir, { recursive: true });

    // Required files: fail loudly with the exact path if one is missing,
    // instead of a cryptic ENOENT.
    const required: Array<[string, string]> = [
      [fromRoot('manifest.json'), resolve(distDir, 'manifest.json')],
      [fromRoot('src/dashboard/dashboard.html'), resolve(distDir, 'dashboard.html')],
      [fromRoot('src/popup/popup.html'), resolve(distDir, 'popup.html')],
    ];
    for (const [src, dest] of required) {
      if (!existsSync(src)) {
        throw new Error(`[copy-manifest] Required file not found: ${src}`);
      }
      copyFileSync(src, dest);
    }

    // Content styles (referenced by name in the manifest).
    const contentStylesSrc = fromRoot('src/content/styles.css');
    if (existsSync(contentStylesSrc)) {
      copyFileSync(contentStylesSrc, resolve(distDir, 'content.css'));
    }

    // declarativeNetRequest rule files.
    const rulesSrcDir = fromRoot('rules');
    if (existsSync(rulesSrcDir)) {
      const rulesDestDir = resolve(distDir, 'rules');
      mkdirSync(rulesDestDir, { recursive: true });
      for (const ruleFile of ['mangadex.json', 'asura.json']) {
        const ruleSrc = resolve(rulesSrcDir, ruleFile);
        if (existsSync(ruleSrc)) {
          copyFileSync(ruleSrc, resolve(rulesDestDir, ruleFile));
        }
      }
    }

    // Icons.
    const iconsDir = resolve(distDir, 'assets/icons');
    mkdirSync(iconsDir, { recursive: true });
    for (const file of ['icon-16.png', 'icon-48.png', 'icon-128.png', 'claude-logo.png']) {
      const srcPath = fromRoot('assets/icons', file);
      if (existsSync(srcPath)) {
        copyFileSync(srcPath, resolve(iconsDir, file));
      }
    }
  },
});

export default defineConfig(({ mode }) => {
  // Strip noisy debug logging from production builds. Kept for `npm run dev`
  // (--mode development) or when DEBUG=1 is set. console.warn / console.error
  // are always preserved so real errors still surface for bug reports.
  const keepDebugLogs = mode !== 'production' || process.env.DEBUG === '1';

  return {
    plugins: [copyManifestPlugin()],
    esbuild: {
      pure: keepDebugLogs ? [] : ['console.log', 'console.info', 'console.debug'],
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: {
          content: fromRoot('src/content/index.ts'),
          background: fromRoot('src/background/index.ts'),
          viewer: fromRoot('src/viewer/index.ts'),
          dashboard: fromRoot('src/dashboard/index.ts'),
          popup: fromRoot('src/popup/index.ts'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name].js',
          assetFileNames: 'assets/[name].[ext]',
          // Disable chunking for extension - each entry should be self-contained.
          // This prevents background from importing viewer chunks with window references.
          // Note: shared modules without DOM/window refs (like sourceDomains) may still
          // be extracted as tiny chunks — this is safe since they contain only data.
          manualChunks: undefined,
        },
      },
      sourcemap: mode === 'development',
    },
    resolve: {
      alias: {
        '@': fromRoot('src'),
      },
    },
  };
});
