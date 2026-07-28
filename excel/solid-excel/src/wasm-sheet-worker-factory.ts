import type { WorkerLike } from './wasm-sheet-proxy'

/**
 * Default browser-side factory that spawns the real `wasm-sheet-worker.ts`
 * via Vite's `new Worker(new URL(..., import.meta.url), { type: 'module' })`
 * pattern. Lives in its own file so Jest's CommonJS transform (which
 * doesn't understand `import.meta.url`) never has to parse it — only the
 * Solid demos do, at bundle time.
 *
 * Pass into `createWorkerSheet({ workerFactory: defaultWorkerFactory })`
 * to get the browser-backed proxy. In tests, inject a fake instead.
 */
export const defaultWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./wasm-sheet-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
