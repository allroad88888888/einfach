import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for the Solid Excel demo smoke suite.
 *
 * The dev server is started automatically via the `webServer` block. Port
 * 5174 remains the default, while `EINFACH_E2E_PORT` lets concurrent agents
 * assign an isolated port to this worktree.
 *
 * Existing servers are never reused by default: a Vite process from another
 * worktree can serve stale source while still satisfying the URL probe. Local
 * reuse is therefore an explicit `EINFACH_E2E_REUSE_SERVER=1` opt-in only.
 */
const PORT = Number(process.env.EINFACH_E2E_PORT ?? 5174)
const BASE_URL = `http://127.0.0.1:${PORT}`

// Playwright's web-server availability probe honours the ambient proxy. Keep
// loopback traffic direct so an HTTP proxy response cannot be mistaken for a
// live local Vite server on an otherwise unused port.
const noProxyEntries = new Set(
  `${process.env.NO_PROXY ?? ''},${process.env.no_proxy ?? ''}`
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
)
noProxyEntries.add('127.0.0.1')
noProxyEntries.add('localhost')
process.env.NO_PROXY = [...noProxyEntries].join(',')
process.env.no_proxy = process.env.NO_PROXY

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'wasm',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `${BASE_URL}/?backend=wasm`,
      },
    },
    {
      name: 'ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `${BASE_URL}/?backend=ts`,
      },
    },
  ],
  webServer: {
    // build:wasm prepends so DemoFormulas / DemoCrossSheetChain don't render
    // "Loading WASM…" forever on a clean checkout (no `solid/excel/wasm-pkg/`
    // yet). Local re-runs are fast — wasm-pack short-circuits when nothing
    // in rust/wasm changed.
    command: `npm run build:wasm && npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: process.env.EINFACH_E2E_REUSE_SERVER === '1',
    // Bumped: cold wasm-pack on a fresh machine can take ~30s before vite
    // even starts.
    timeout: 180_000,
  },
})
