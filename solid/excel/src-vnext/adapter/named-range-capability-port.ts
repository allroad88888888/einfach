import type {
  NamedRangeBackendCapabilities,
  NamedRangeControllerPort,
  NamedRangeRuntime,
} from '@einfach/spreadsheet-ui-core'

export type NamedRangeCapabilityReaderPort = Required<
  Pick<NamedRangeControllerPort, 'readNamedRangeCapabilities'>
>

export type WorkerNamedRangeRuntime = Extract<
  NamedRangeRuntime,
  'worker-ts' | 'worker-wasm'
>

const STATIC_SESSION_CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'static-session',
  scopes: Object.freeze(['workbook', 'sheet'] as const),
  bindings: Object.freeze({ range: true, constant: true, lambda: true }),
  delete: true,
  rangeSemantics: 'stored-definition',
  listAuthority: 'static-session-registry',
  definitionReadback: 'full',
  namesWitness: false,
  mutationAck: 'session-registry-accepted',
  durability: 'session-local',
})

const WORKER_TS_CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'worker-ts',
  // The TS engine owns workbook names only. The adapter must not advertise
  // sheet scope merely because its overlay shape can store a sheet id.
  scopes: Object.freeze(['workbook'] as const),
  bindings: Object.freeze({ range: true, constant: true, lambda: true }),
  delete: true,
  rangeSemantics: 'live-reference',
  listAuthority: 'adapter-post-ack-overlay',
  definitionReadback: 'full',
  namesWitness: false,
  mutationAck: 'engine-accepted',
  durability: 'session-local',
})

const WORKER_WASM_CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'worker-wasm',
  // The current Rust/WASM protocol rejects defineName/undefineName. Keep the
  // manager read-only until the engine grows a real name-binding contract.
  scopes: Object.freeze([]),
  bindings: Object.freeze({ range: false, constant: false, lambda: false }),
  delete: false,
  rangeSemantics: 'unsupported',
  listAuthority: 'adapter-post-ack-overlay',
  definitionReadback: 'full',
  namesWitness: false,
  mutationAck: 'engine-accepted',
  durability: 'session-local',
})

function capabilityPort(
  capabilities: NamedRangeBackendCapabilities,
): NamedRangeCapabilityReaderPort {
  return Object.freeze({
    readNamedRangeCapabilities: () => Promise.resolve(capabilities),
  })
}

/** Explicit capability port for the in-memory static adapter. */
export function createStaticNamedRangeCapabilityPort(): NamedRangeCapabilityReaderPort {
  return capabilityPort(STATIC_SESSION_CAPABILITIES)
}

/**
 * Explicit capability port for a worker host.
 *
 * Runtime selection stays a host responsibility; it is intentionally not
 * inferred from method presence or attached as a hidden backend property.
 */
export function createWorkerNamedRangeCapabilityPort(
  runtime: WorkerNamedRangeRuntime,
): NamedRangeCapabilityReaderPort {
  return capabilityPort(
    runtime === 'worker-ts' ? WORKER_TS_CAPABILITIES : WORKER_WASM_CAPABILITIES,
  )
}
