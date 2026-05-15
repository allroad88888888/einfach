# auto-fill-series

Planning doc for series-aware fill-handle drag in `@einfach/spreadsheet-ui-core`.

## Goal

Drag the fill handle over an adjacent range and have the UI core detect a
numeric or named sequence in the source range, then pass that detection to the
backend so cells extrapolate — numbers step by a constant delta, dates advance
by day/week/month, weekday and month names cycle, custom lists repeat — instead
of simply copying source values.

## Scope

Series kinds the UI core detector must recognise:

- **Integer arithmetic** — uniform integer step (1, 2, 3 or 10, 20, 30).
- **Decimal arithmetic** — uniform decimal step (0.5, 1.0, 1.5).
- **Date stepping** — consecutive dates; step unit is day, week, or month.
- **Weekday names** — Monday … Friday cycling (locale string set provided by
  host at init time).
- **Month names** — January … December cycling (locale string set provided by
  host).
- **Custom lists** — ordered string sequences registered by the host.

Ctrl+drag always means copy-only; the detector result is ignored.

### Out of scope

- Formula-only fill — already handled by `FillRangeRequest` copy semantics.
- Chart/sparkline fill — outside the spreadsheet-ui-core boundary.

## State (UI core)

Augment `PointerFillHandleSession` with an optional series preview field.
Detection runs as a pure function over the visible source cells when the session
starts or the source range changes; the result is stored on the session atom so
the host viewport can render a preview tooltip without a backend round-trip.

```ts
// pointer/types.ts additions
export interface FillSeriesPreview {
  kind: FillSeriesKind
  step: number | null          // null for named sequences
  lastCellText: string         // formatted value for the final target cell
}

export interface PointerFillHandleSession {
  kind: 'fill-handle'
  sheetId: string
  sourceRange: CellRange
  focus: CellCoord | null
  previewRange: CellRange | null
  direction: PointerFillDirection | null
  seriesPreview: FillSeriesPreview | null   // null = copy mode
  copyOnly: boolean                         // true when Ctrl is held
}
```

Atoms:

- `pointerSessionAtom` — already exists; carries the extended session.
- `autoFillSeriesPreviewAtom` — derived, reads `pointerSessionAtom`, emits
  `FillSeriesPreview | null`. `debugLabel`: `spreadsheet.autoFill.seriesPreview`.
- `autoFillCopyOnlyAtom` — derived boolean from session `copyOnly` field.
  `debugLabel`: `spreadsheet.autoFill.copyOnly`.

No per-cell atoms. Detection result is a single bounded object.

## Types

New types live in `src/auto-fill/types.ts`:

```ts
export type FillSeriesKind =
  | 'integer'
  | 'decimal'
  | 'date-day'
  | 'date-week'
  | 'date-month'
  | 'weekday'
  | 'month'
  | 'custom-list'

export interface FillSeriesDetectionResult {
  kind: FillSeriesKind
  step: number | null
  listName?: string          // for 'custom-list' kind
  startIndex: number         // index into the list at source start
}

export interface FillSeriesRequest extends SheetRef {
  kind: 'fill-series'
  sourceRange: CellRange
  targetRange: CellRange
  direction: SpreadsheetFillDirection
  series: FillSeriesDetectionResult
  copyOnly?: boolean
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  cancelToken?: ProjectionCancelToken
}
```

`FillSeriesRequest` is a sibling of `FillRangeRequest`, not an extension; the
backend port discriminates on `kind`.

## Backend port

Add an optional method to `SpreadsheetBackend`:

```ts
fillSeries?(request: FillSeriesRequest): Promise<BackendMutationResult>
```

Optional: if the host adapter omits `fillSeries`, the UI core falls back to
`fillRange` (copy semantics). The host adapter must still handle `cancelToken`
and treat a stale `revision` as a no-op in the same way as all other mutation
ports.

**Detection ownership:** the UI core runs a lightweight detector over the
`DisplayCell[]` already in the visible projection cache — no extra backend call
during the drag. The backend re-validates the detection result server-side
before writing and may override it (e.g. if the source range contains formula
cells not visible in the projection). The backend result is authoritative;
`BackendMutationResult.affectedRange` reflects what was actually written.

## Integration points

- **Pointer** — `startPointerAtom` and `updatePointerAtom` writers invoke the
  detector when `kind === 'fill-handle'` and `copyOnly` is false. Detection
  input is the `DisplayCell[]` slice from the last visible projection result
  covering `sourceRange`.
- **Viewport** — host renders `autoFillSeriesPreviewAtom` as a tooltip or
  overlay on the last target cell during the drag. No new viewport atom needed;
  the host reads the derived atom directly.
- **Keyboard** — a Ctrl modifier event sets `copyOnly: true` on the active
  fill-handle session via `updatePointerAtom`. The intent emitted by
  `commitPointerAtom` carries `copyOnly`; the host adapter checks this flag
  before calling `fillSeries` vs `fillRange`.
- **Backend** — `PointerFillHandleCommitIntent` gains a `copyOnly` flag and an
  optional `seriesDetection: FillSeriesDetectionResult | null` field. Host
  adapters route to `fillSeries` when `seriesDetection !== null && !copyOnly`,
  else to `fillRange`.

## Risks & open questions

- **Locale-dependent names** — weekday and month name lists must be supplied by
  the host at workbook init, not hard-coded. Decide on a `FillSeriesLocale`
  config object passed to the detector factory.
- **Mixed-content source** — source range contains both numbers and strings.
  Current plan: fall back to copy. Confirm whether partial-series detection
  (numbers only, ignore strings) is wanted.
- **Large source range** — if source row/column count exceeds a threshold (e.g.
  32 cells) the lightweight detector may be skipped and the backend decides.
  Threshold value is open.
- **Merged cells** — source or target range intersects merged cells. The backend
  must reject or clamp; the UI core has no merged-cell facts.
- **Custom lists storage** — where custom lists are persisted (workbook file,
  user profile, backend config) is unresolved. The UI core only consumes the
  list by name; the host adapter owns the registry.
- **Reverse series** — dragging up or left with a positive step should produce a
  descending sequence. Confirm direction semantics with product.

## Test surface

`test/auto-fill-series.test.ts` — unit tests for the pure detector:

- Integer step detected from 2-cell and 3-cell source.
- Decimal step detected; floating-point epsilon handled.
- Date-day, date-week, date-month step detection.
- Weekday name cycling (custom locale list).
- Month name cycling.
- Mixed content falls back to `null` (copy mode).
- Single-cell source returns `null`.
- `copyOnly: true` skips detection, emits `null`.
- `FillSeriesRequest` round-trips through `SpreadsheetBackend` type check
  (compile-time only test).

## State Decision Template

- Source atoms: `pointerSessionAtom` (extended with `seriesPreview`, `copyOnly`).
- Derived atoms: `autoFillSeriesPreviewAtom`, `autoFillCopyOnlyAtom`.
- Commands: none new — commit flows through existing `commitPointerAtom`.
- Scale bound: single `FillSeriesDetectionResult` object per active session.
- Backend reads: `DisplayCell[]` from existing projection cache only.
- Per-cell/per-row/per-col atom risk: none; detector is a pure function.
- Tests: `test/auto-fill-series.test.ts`.
