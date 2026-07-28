/// <reference lib="WebWorker" />

import { installWorkerRuntime } from '../src-vnext/adapter/worker-runtime'

installWorkerRuntime()

export * from '../src-vnext/adapter/worker-runtime'
