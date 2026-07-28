# error-codes — graded taxonomy refinement

## Goal

The current five `SpreadsheetErrorCode` values (`BACKEND_ERROR`, `CANCELLED`,
`INVALID_FORMULA`, `FORMULA_CYCLE`, `OUT_OF_BOUNDS`) are coarse string literals
that conflate distinct failure domains: parse failures (formula syntax),
runtime failures (cycle, eval), transport failures (worker crash, timeout),
permission failures (read-only sheet), and projection overflows. Downstream
consumers — diagnostics, formula-bar, workspace — already infer severity and
source with local switch statements, duplicating logic that belongs on the error
itself.

The refinement introduces a structured `SpreadsheetError` with explicit
`severity`, `source`, and open-string `code` fields. Stable conventional
namespaces (e.g. `parse.unexpected_token`, `runtime.formula_cycle`) replace the
all-caps enum, while legacy callers that emit only `{ code, message }` remain
valid via auto-grading.

## Scope

Refine `SpreadsheetError` in `src/shared/types.ts` and update
`src/diagnostics/index.ts` to consume the richer shape. Adjust the
`mapSpreadsheetErrorToDiagnostic` bridge to read `severity` and `source`
directly when present rather than deriving them. Add a normalisation helper
`gradeSpreadsheetError` that promotes legacy shapes.

**Out of scope**

- i18n message catalog — host adapter responsibility; `message` and `hint`
  remain raw strings
- Telemetry export schema or redaction rules — handled outside ui-core

## State (UI core)

No new top-level atoms. `diagnosticsAtom` consumes `SpreadsheetDiagnostic`
unchanged; the enrichment happens at the `mapSpreadsheetErrorToDiagnostic`
call site before items enter the atom. Bounded diagnostics retention
(`DEFAULT_MAX_DIAGNOSTICS = 20`, `limitDiagnostics`) continues to apply
unmodified.

## Types

```ts
// src/shared/types.ts

export type SpreadsheetErrorSeverity = 'warning' | 'error' | 'fatal'

export type SpreadsheetErrorSource =
  | 'parse'
  | 'runtime'
  | 'permission'
  | 'transport'
  | 'validation'
  | 'projection'
  | 'unknown'

// Conventional code namespaces (open string — not an enum)
// parse.*      — formula/expression syntax errors from the parser layer
// runtime.*    — evaluation errors: cycles, type mismatches, divide-by-zero
// permission.* — read-only sheet, locked cell, quota
// transport.*  — worker crash, WASM panic, request timeout
// validation.* — cell input rejected before commit (see editing sibling)
// projection.* — viewport overflow, stale result, RANGE_TOO_LARGE
// unknown.*    — unclassified backend errors

export interface SpreadsheetError {
  code: string                    // open string; legacy ALL_CAPS codes remain valid
  severity: SpreadsheetErrorSeverity
  source: SpreadsheetErrorSource
  message: string
  hint?: string                   // optional structured guidance for formula-bar UI
}
```

Migration: existing backends that return only `{ code: SpreadsheetErrorCode,
message: string }` are promoted by `gradeSpreadsheetError`:

```ts
// src/shared/error-grade.ts

import type { SpreadsheetError, SpreadsheetErrorSeverity, SpreadsheetErrorSource } from './types'

const LEGACY_SEVERITY: Record<string, SpreadsheetErrorSeverity> = {
  CANCELLED: 'warning',
  OUT_OF_BOUNDS: 'warning',
  INVALID_FORMULA: 'error',
  FORMULA_CYCLE: 'error',
  BACKEND_ERROR: 'error',
}

const LEGACY_SOURCE: Record<string, SpreadsheetErrorSource> = {
  INVALID_FORMULA: 'parse',
  FORMULA_CYCLE: 'runtime',
  OUT_OF_BOUNDS: 'projection',
  CANCELLED: 'transport',
  BACKEND_ERROR: 'unknown',
}

export function gradeSpreadsheetError(
  raw: { code: string; message: string; severity?: SpreadsheetErrorSeverity; source?: SpreadsheetErrorSource; hint?: string },
): SpreadsheetError {
  return {
    code: raw.code,
    severity: raw.severity ?? LEGACY_SEVERITY[raw.code] ?? 'error',
    source: raw.source ?? LEGACY_SOURCE[raw.code] ?? 'unknown',
    message: raw.message,
    hint: raw.hint,
  }
}
```

`SpreadsheetErrorCode` union type is kept as a deprecated alias for `string`
for one release cycle; existing switch statements on the old literals remain
valid because the `code` field is still a `string`.

## Backend port

No changes to `SpreadsheetBackend` method signatures. Results carrying errors
gain the richer shape in their payload types:

- `DisplayCell.error` — already typed `SpreadsheetError`; backends emitting
  only `{ code, message }` must be normalised by the adapter before entering
  the result (static-backend, worker-workbook-backend call
  `gradeSpreadsheetError` at the seam).
- `BackendMutationResult` — add optional `error?: SpreadsheetError`; callers
  that currently `throw` on failure may instead return a graded error, enabling
  non-fatal mutation warnings (e.g. partial import with `severity: 'warning'`).

Backward compatibility guarantee: any backend that returns the legacy
`{ code: SpreadsheetErrorCode, message: string }` shape receives
`severity: 'error'`, `source: 'unknown'` from `gradeSpreadsheetError` unless
the legacy map overrides it. No runtime crash, no silent swallow.

## Integration points

- **diagnostics** — `mapSpreadsheetErrorToDiagnostic` reads `error.severity`
  and maps to `DiagnosticSeverity` (`fatal` → `'error'` for now; extend when
  `DiagnosticSeverity` gains `'fatal'`). Severity-aware retention policy can
  later pin `fatal` items regardless of `limitDiagnostics` cap.
- **formula-bar** — `hint` field surfaces structured guidance in the formula
  bar diagnostic UI; `severity: 'warning'` uses a softer tone vs `'error'`.
- **editing** — validation errors use `source: 'validation'`; the editing
  sibling owns the pre-commit check path and emits codes in the `validation.*`
  namespace.
- **projection** — `CANCELLED` maps to `source: 'transport'`,
  `severity: 'warning'`; `OUT_OF_BOUNDS` / `RANGE_TOO_LARGE` map to
  `source: 'projection'`, `severity: 'warning'`. The distinction is now
  explicit in the error shape rather than inferred from code string.
- **workspace** — `source: 'transport'` with `severity: 'fatal'` is the signal
  for session reset; workspace adapter checks this field rather than matching
  `'BACKEND_ERROR'` literally.

## Risks & open questions

- **Enum vs open string** — open string with conventional namespaces
  (`parse.unexpected_token`) is recommended. Enums require a package release
  for every new backend code; open strings allow backends (including
  Rust/WASM) to emit their own namespaced codes without a ui-core change.
  Downside: no exhaustive switch; mitigate with a lint rule or discriminated
  helper.
- **Translating Rust/WASM errors** — Rust error variants arrive as string
  payloads over the worker message channel. The worker adapter
  (`worker-workbook-backend.ts`) is responsible for mapping them to
  conventional `parse.*` / `runtime.*` codes before calling
  `gradeSpreadsheetError`; ui-core does not import WASM types.
- **Severity contract for known codes** — the `LEGACY_SEVERITY` map in
  `gradeSpreadsheetError` is the source of truth for promoted legacy codes.
  New codes introduced by Rust backends must be documented in this map or
  they fall back to `severity: 'error'`, which is safe but possibly noisy.
- **`fatal` in `DiagnosticSeverity`** — `SpreadsheetErrorSeverity` includes
  `'fatal'` but `DiagnosticSeverity` currently tops out at `'error'`. The
  mapping is lossy until `DiagnosticSeverity` is extended; this is an open
  design question for the diagnostics sibling.
- **Telemetry redaction** — `message` and `hint` may contain cell content;
  redaction is out of scope here but consumers must not log these fields raw.
- **Breaking change window** — `SpreadsheetError.code` widens from
  `SpreadsheetErrorCode` union to `string`. TypeScript callers with exhaustive
  switches will get compile warnings; this is intentional and documented in
  the migration notes.

## Test surface

New file: `test/error-codes.test.ts`

Focus areas:

- `gradeSpreadsheetError` promotes each legacy `SpreadsheetErrorCode` to the
  correct `severity` and `source` without mutation.
- Legacy shape `{ code, message }` (no `severity`, no `source`) round-trips
  through `gradeSpreadsheetError` and produces a valid `SpreadsheetError`.
- New structured shape with all fields passes through unchanged.
- `mapSpreadsheetErrorToDiagnostic` reads `severity` from the graded error
  rather than re-deriving it from the code string.
- `source: 'transport'` + `severity: 'fatal'` produces a diagnostic with
  `severity: 'error'` (lossless downgrade until `DiagnosticSeverity` expands).
- Bounded diagnostics cap still enforced after enrichment.
