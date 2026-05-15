import type { WorkerLike } from './worker-protocol'

export const defaultVNextWorkbookWorkerFactory = (): WorkerLike =>
  new Worker(new URL('../../src/wasm-workbook-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
