import type { WorkerLike } from './wasm-workbook-proxy'

export const defaultWorkbookWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./wasm-workbook-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
