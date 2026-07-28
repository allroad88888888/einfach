import type { WorkerLike } from './worker-protocol'

export const defaultVNextWorkbookWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./worker-runtime.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike

/**
 * Wave D — factory for the TypeScript-backed worker engine. Spawns the
 * dedicated `worker-entry-ts.ts` bundle (which delegates to
 * `worker-runtime-ts.ts`). The wire protocol is identical to the WASM
 * factory above, so the same `createWorkerWorkbookSpreadsheetBackend`
 * shim can drive either backend — the demo just swaps which factory
 * gets passed in.
 */
export const defaultExcelCoreTsWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./worker-entry-ts.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
