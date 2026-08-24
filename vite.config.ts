import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lovinspPlugin } from 'lovinsp';
import {
  bridgeDist,
  launcherDist,
  lovinspBridgeEntry,
  marketplaceEntry,
} from './scripts/paths.mjs';

function lovinsp() {
  return lovinspPlugin({
      bundler: 'vite',
      dev: true,
      pathType: 'absolute',
      port: 5678,
      printServer: true,
      showSwitch: false,
      hideConsole: false,
      behavior: { locate: true, copy: true, defaultAction: 'locate' },
    });
}

export default defineConfig(({ command }) => {
  const target =
    process.env.CODEEX_BUILD_TARGET ||
    process.env.LOV_CODEX_BUILD_TARGET ||
    'marketplace';
  const buildingLovinsp = target === 'lovinsp';
  const buildingLauncher = target === 'launcher';
  if (buildingLauncher) {
    return {
      base: './',
      plugins: [react()],
      build: {
        outDir: launcherDist,
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        target: 'safari17',
      },
    };
  }
  return {
    // The marketplace dev server is itself inspectable. In packaged builds,
    // Lovinsp is compiled only when its independent plugin is installed.
    plugins: command === 'serve' || buildingLovinsp ? [lovinsp(), react()] : [react()],
    build: {
      outDir: bridgeDist,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'chrome151',
      rollupOptions: {
        input: buildingLovinsp ? lovinspBridgeEntry : marketplaceEntry,
        output: {
          codeSplitting: false,
          entryFileNames: buildingLovinsp
            ? 'lovinsp-client.js'
            : 'marketplace-client.js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  };
});
