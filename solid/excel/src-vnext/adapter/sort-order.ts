// Shared physical-sort comparator + slot algorithm (design-engine-sort §3.2,
// §6.2). This is the TS mirror of the Rust `sort_cmp` / slot machine in
// `rust/excel-core/src/sort.rs`; the static reference backend and the
// WASM-golden parity test both consume it so a static-host sort and the
// engine sort agree cell-for-cell.
//
// Alignment with Rust `sort_cmp` (checked point by point):
//   - Type order:   number < text < boolean < error < empty  (`type_rank`).
//   - Empty last:   `Null` sorts LAST in BOTH directions; only the non-empty
//                   comparison is reversed for descending.
//   - Numbers:      f64 order; NaN equals NaN and sorts after every real
//                   number, still inside the number class (`cmp_number`).
//   - Text:         code-POINT order (not UTF-16 code-unit order), case-folded
//                   via the Unicode default lowercase mapping when
//                   `caseSensitive` is false (`cmp_text`). Deliberately NO
//                   locale collation — never `localeCompare` (determinism over
//                   ICU, design §3.2 conformance note).
//   - Booleans:     FALSE < TRUE.
//   - Errors:       mutually equal (stability preserves pre-sort order).
//   - Stability:    the slot permutation is a stable sort of the visible rows.

import type { SortDirection } from '@einfach/spreadsheet-ui-core'

/**
 * Cap on the number of cells a sort source range may span before the adapter
 * refuses (fail-closed, no work performed). Mirrors the worker adapter's
 * `MAX_SORT_SOURCE_CELLS` and the `MAX_FILTER_SORT_PREDICATE_CELLS` budget so
 * static and worker reject an over-budget range identically.
 */
export const MAX_SORT_SOURCE_CELLS = 50_000

/**
 * A cell's evaluated value projected onto the five Excel sort classes. This is
 * the TS analogue of the engine `Value` variants the comparator sees after the
 * spill gate (arrays can never reach a key position). Formulas contribute their
 * evaluated result, matching the engine's "sort by value" rule.
 */
export type SortValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error' }
  | { kind: 'empty' }

/** Ascending type-class order (Rust `type_rank`): number < text < boolean < error < empty. */
export const SORT_TYPE_RANK: Readonly<Record<SortValue['kind'], number>> = Object.freeze({
  number: 0,
  text: 1,
  boolean: 2,
  error: 3,
  empty: 4,
})

/**
 * Number order (Rust `cmp_number`). NaN is an engineering extension (Excel has
 * no NaN): NaNs are mutually equal and sort after every real number.
 */
export function compareSortNumbers(a: number, b: number): number {
  const an = Number.isNaN(a)
  const bn = Number.isNaN(b)
  if (an && bn) return 0
  if (an) return 1
  if (bn) return -1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Code-point comparison of two strings (Rust `str::chars().cmp()`). The string
 * iterator yields whole code points, so a surrogate pair compares by its scalar
 * value — NOT by UTF-16 code unit, which is what `<` / `localeCompare` would do.
 */
function compareByCodePoint(a: string, b: string): number {
  const ai = a[Symbol.iterator]()
  const bi = b[Symbol.iterator]()
  for (;;) {
    const an = ai.next()
    const bn = bi.next()
    if (an.done && bn.done) return 0
    if (an.done) return -1
    if (bn.done) return 1
    const ac = an.value.codePointAt(0)!
    const bc = bn.value.codePointAt(0)!
    if (ac !== bc) return ac < bc ? -1 : 1
  }
}

/**
 * Text order (Rust `cmp_text`): code-point order; case-folded via the Unicode
 * default lowercase mapping when `caseSensitive` is false. `toLowerCase()` is
 * locale-independent (unlike `toLocaleLowerCase`), matching Rust
 * `char::to_lowercase`; the comparison itself is by code point.
 */
export function compareSortText(a: string, b: string, caseSensitive: boolean): number {
  if (caseSensitive) return compareByCodePoint(a, b)
  return compareByCodePoint(a.toLowerCase(), b.toLowerCase())
}

/** Boolean order: FALSE < TRUE. */
function compareSortBooleans(a: boolean, b: boolean): number {
  if (a === b) return 0
  return a ? 1 : -1
}

/** Non-empty comparison (Rust `cmp_non_null`): type class first, then within-class. */
function compareNonEmpty(a: SortValue, b: SortValue, caseSensitive: boolean): number {
  const ra = SORT_TYPE_RANK[a.kind]
  const rb = SORT_TYPE_RANK[b.kind]
  if (ra !== rb) return ra < rb ? -1 : 1
  if (a.kind === 'number' && b.kind === 'number') return compareSortNumbers(a.value, b.value)
  if (a.kind === 'text' && b.kind === 'text') return compareSortText(a.value, b.value, caseSensitive)
  if (a.kind === 'boolean' && b.kind === 'boolean') return compareSortBooleans(a.value, b.value)
  // Error class: errors never compare against each other — equal.
  return 0
}

/**
 * Ascending total order (Rust `sort_cmp`): number < text < boolean < error <
 * empty, empty always last. Stable sorting on top of this gives the full sort.
 */
export function compareSortValues(a: SortValue, b: SortValue, caseSensitive: boolean): number {
  const ae = a.kind === 'empty'
  const be = b.kind === 'empty'
  if (ae && be) return 0
  if (ae) return 1
  if (be) return -1
  return compareNonEmpty(a, b, caseSensitive)
}

/**
 * Directional comparator (Rust `sort_cmp_with_direction`): the empty layer is
 * direction-independent (empty sinks both ways); the direction applies only to
 * the non-empty comparison.
 */
export function compareSortValuesWithDirection(
  a: SortValue,
  b: SortValue,
  caseSensitive: boolean,
  direction: SortDirection,
): number {
  const ae = a.kind === 'empty'
  const be = b.kind === 'empty'
  if (ae && be) return 0
  if (ae) return 1
  if (be) return -1
  const ord = compareNonEmpty(a, b, caseSensitive)
  return direction === 'desc' ? -ord : ord
}

/** One resolved sort key (defaults already applied by the caller). */
export interface ResolvedSortKey {
  readonly col: number
  readonly direction: SortDirection
  readonly caseSensitive: boolean
}

/**
 * Result of planning a physical sort over a range (design §6.2). `rowMap` maps a
 * source row to the slot it moves to; `rowPermutation` is `[slotRow, sourceRow]`
 * over the CHANGED slots only (matching the engine `SortRangeReport`). Both are
 * empty when the permutation is identity (a no-op sort).
 */
export interface PhysicalSortPlan {
  readonly visibleRows: readonly number[]
  readonly rowMap: Map<number, number>
  readonly rowPermutation: Array<[number, number]>
}

/**
 * Stable slot permutation (design §6.2). The visible rows are the range's rows
 * `[rowStart, rowEnd]` minus the (deduped, clamped) excluded set; they are
 * stably reordered by `keys` while excluded rows keep their position. Key values
 * come from `keyValueAt`, materialized before any move by the caller.
 */
export function planPhysicalSort(
  rowStart: number,
  rowEnd: number,
  excludedRows: readonly number[],
  keys: readonly ResolvedSortKey[],
  keyValueAt: (row: number, col: number) => SortValue,
): PhysicalSortPlan {
  const excluded = new Set<number>()
  for (const row of excludedRows) {
    if (row >= rowStart && row <= rowEnd) excluded.add(row)
  }

  const visibleRows: number[] = []
  for (let row = rowStart; row <= rowEnd; row += 1) {
    if (!excluded.has(row)) visibleRows.push(row)
  }

  const empty: PhysicalSortPlan = {
    visibleRows,
    rowMap: new Map(),
    rowPermutation: [],
  }
  if (visibleRows.length <= 1) return empty

  // Materialize every key tuple before sorting — no mid-permutation reads.
  const keyValues: SortValue[][] = visibleRows.map((row) =>
    keys.map((key) => keyValueAt(row, key.col)),
  )

  // Stable permutation of visible-slot indices. `Array.prototype.sort` is spec-
  // stable (ES2019+); key-equal rows keep their pre-sort slot order.
  const perm = visibleRows.map((_row, index) => index)
  perm.sort((ia, ib) => {
    for (let ki = 0; ki < keys.length; ki += 1) {
      const ord = compareSortValuesWithDirection(
        keyValues[ia][ki],
        keyValues[ib][ki],
        keys[ki].caseSensitive,
        keys[ki].direction,
      )
      if (ord !== 0) return ord
    }
    return 0
  })

  const rowMap = new Map<number, number>()
  const rowPermutation: Array<[number, number]> = []
  for (let i = 0; i < perm.length; i += 1) {
    const slot = visibleRows[i]
    const source = visibleRows[perm[i]]
    if (slot !== source) {
      rowMap.set(source, slot)
      rowPermutation.push([slot, source])
    }
  }

  return { visibleRows, rowMap, rowPermutation }
}
