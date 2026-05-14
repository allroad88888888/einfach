# clipboard

Owns copy/cut/paste UI state and backend chunked transfer contracts.

## State Decision Template

- Source atoms:
  - `clipboardStateAtom`: current clipboard UI status, source/target range descriptors, bounded payload metadata, and error.
  - `clipboardIntentAtom`: last copy/cut/paste intent for host adapter consumption.
- Derived atoms: none in the first wave; payload metadata is produced by pure helpers.
- Commands:
  - `copyClipboardAtom`
  - `cutClipboardAtom`
  - `pasteClipboardAtom`
  - `markClipboardReadyAtom`
  - `clearClipboardAtom`
- Scale bound: command status and source range marker.
- Backend reads: chunked export/import only.
- Per-cell/per-row/per-col atom risk: do not store large TSV payloads.
- Tests: `test/clipboard.test.ts`.
