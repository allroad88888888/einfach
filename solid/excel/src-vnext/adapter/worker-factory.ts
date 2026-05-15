interface WorkerLike {
  postMessage(msg: unknown): void
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  terminate(): void
}

export const defaultVNextWorkbookWorkerFactory = (): WorkerLike =>
  new Worker(new URL('../../src/wasm-workbook-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike
