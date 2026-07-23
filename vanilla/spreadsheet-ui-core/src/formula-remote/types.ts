/**
 * Remote formula contracts (Wave 8.1).
 *
 * =REMOTE("https://api.example.com/data", A1, B1) produces #BUSY! while
 * the request is in flight. The UI core tracks in-flight calls through
 * these plain-value types so the host can render loading indicators and
 * error banners without coupling to the worker protocol.
 *
 * All types are framework-agnostic — no DOM / worker / WASM glue.
 */

/** Aggregate status of all in-flight remote-formula calls. */
export type RemoteStatus = 'idle' | 'busy' | 'error'

/** Descriptor for one in-flight =REMOTE call. */
export interface RemotePendingDescriptor {
  /** Engine-assigned call ID (u64 → number). */
  readonly id: number
  /** Zero-based sheet index. */
  readonly sheetId: number
  /** Human-readable cell address (e.g. "B4"). */
  readonly addr: string
  /** Truncated URL preview for UI display (max 80 chars). */
  readonly urlPreview: string
  /** Date.now() when the call was enqueued by the engine. */
  readonly startedAt: number
}
