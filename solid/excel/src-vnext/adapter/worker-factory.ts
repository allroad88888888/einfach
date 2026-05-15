import type { WorkerLike } from './worker-protocol'

export const defaultVNextWorkbookWorkerFactory = (): WorkerLike =>
  new Worker(new URL('./worker-runtime.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
