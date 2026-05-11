import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the Solid Excel demo smoke suite.
 *
 * The dev server is started automatically via the `webServer` block. We pin
 * to port 5174 (one above vite's default) so a stray vite dev server on 5173
 * — common during interactive development — doesn't interfere with the
 * suite; the e2e command always boots its own.
 *
 * Locally `reuseExistingServer` lets repeat runs share one server for speed;
 * in CI we always start a fresh one.
 */
const PORT = 5174
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // build:wasm prepends so DemoFormulas / DemoCrossSheetChain don't render
    // "Loading WASM…" forever on a clean checkout (no `solid/excel/wasm-pkg/`
    // yet). Local re-runs are fast — wasm-pack short-circuits when nothing
    // in rust/wasm changed.
    command: `npm run build:wasm && npm run dev -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // Bumped: cold wasm-pack on a fresh machine can take ~30s before vite
    // even starts.
    timeout: 180_000,
  },
})
