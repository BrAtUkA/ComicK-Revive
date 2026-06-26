import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

// Plugin to copy manifest and assets after build
const copyManifestPlugin = () => ({
  name: 'copy-manifest',
  closeBundle() {
    // Copy manifest.json
    copyFileSync(
      resolve(__dirname, 'manifest.json'),
      resolve(__dirname, 'dist/manifest.json')
    );

    // Copy content styles directly (for CSS file reference in manifest)
    const contentStylesSrc = resolve(__dirname, 'src/content/styles.css');
    const contentStylesDest = resolve(__dirname, 'dist/content.css');
    if (existsSync(contentStylesSrc)) {
      copyFileSync(contentStylesSrc, contentStylesDest);
    }

    // Copy declarativeNetRequest rules
    const rulesSrcDir = resolve(__dirname, 'rules');
    const rulesDestDir = resolve(__dirname, 'dist/rules');
    if (existsSync(rulesSrcDir)) {
      if (!existsSync(rulesDestDir)) {
        mkdirSync(rulesDestDir, { recursive: true });
      }
      // Copy all rule JSON files
      for (const ruleFile of ['mangadex.json', 'asura.json']) {
        const ruleSrc = resolve(rulesSrcDir, ruleFile);
        if (existsSync(ruleSrc)) {
          copyFileSync(ruleSrc, resolve(rulesDestDir, ruleFile));
        }
      }
    }

    // Ensure assets/icons directory exists
    const iconsDir = resolve(__dirname, 'dist/assets/icons');
    if (!existsSync(iconsDir)) {
      mkdirSync(iconsDir, { recursive: true });
    }

    // Copy icons if they exist
    const iconSizes = ['16', '48', '128'];
    for (const size of iconSizes) {
      const srcPath = resolve(__dirname, `assets/icons/icon-${size}.png`);
      const destPath = resolve(__dirname, `dist/assets/icons/icon-${size}.png`);
      if (existsSync(srcPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
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
          content: resolve(__dirname, 'src/content/index.ts'),
          background: resolve(__dirname, 'src/background/index.ts'),
          viewer: resolve(__dirname, 'src/viewer/index.ts'),
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
        '@': resolve(__dirname, 'src'),
      },
    },
  };
});
