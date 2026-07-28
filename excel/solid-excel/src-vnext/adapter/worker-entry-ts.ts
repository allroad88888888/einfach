/// <reference lib="WebWorker" />

/**
 * Wave D — worker entry script for the TypeScript-backed engine.
 *
 * This file is the bundle target referenced by
 * `defaultExcelCoreTsWorkerFactory` (see `./worker-factory.ts`). It must
 * remain a thin shim: any logic lives in `worker-runtime-ts.ts`, which is
 * what jest tests import directly. The split mirrors `worker-runtime.ts`
 * (WASM) which is bundled by `src/wasm-workbook-worker.ts`.
 */

import { installWorkerRuntimeTs } from './worker-runtime-ts'

installWorkerRuntimeTs()

export {}
