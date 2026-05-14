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
    },
  },
  build: {
    target: 'esnext',
  },
})
