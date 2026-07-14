import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirName = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(dirName, '../..')

export default defineConfig({
  // Order matters: wasm() rewrites .wasm imports, then solidPlugin transforms
  // .tsx, then topLevelAwait() rewrites the resulting top-level `await`s into
  // an async IIFE so the bundle is loadable on browsers without TLA support.
  plugins: [wasm(), topLevelAwait(), solidPlugin()],
  resolve: {
    alias: {
      '@einfach/spreadsheet-ui-core': path.resolve(
        repoRoot,
        'vanilla/spreadsheet-ui-core/src',
      ),
      // Mirrors the jest moduleNameMapper so the bundled worker resolves
      // excel-core-ts straight from source. Otherwise vite would pick up the
      // stale published esm/cjs outputs and ?backend=ts would crash when the
      // worker calls debug RPCs added in Phase 1.
      '@einfach/excel-core-ts': path.resolve(repoRoot, 'vanilla/excel-core-ts/src'),
      // Same source-alias treatment for the remaining workspace deps so the
      // dev server never depends on built esm/cjs artifacts (a failed
      // `npm run build` deletes them via clearTypes and would 500 every
      // module until the next successful build).
      '@einfach/core': path.resolve(repoRoot, 'vanilla/core/src'),
      '@einfach/solid': path.resolve(repoRoot, 'solid/solid/src'),
    },
  },
  build: {
    target: 'esnext',
  },
})
