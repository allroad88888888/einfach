/**
 * Workbook-level reverse dependency graph — the TS mirror of Rust's
 * `cell_dependents` / `RangeDependentIndex` (see
 * `excel/rust/excel-core/src/sheet.rs` and
 * `docs/KEY_GRANULAR_INVALIDATION.md` for the design RFC).
 *
 * The graph answers ONE question fast: "which formulas may change when
 * cell (sheetId, key) changes?" Mutations run a BFS over those edges so
 * a write dirties O(true dependents), not O(cached formulas) — the
 * audit C-2 fix.
 *
 * Three edge classes:
 *  - **point** — `=A1+1` registers `A1 → formula`.
 *  - **range** — `=SUM(A1:B10)` / `=SUM(A:A)` registers the range in a
 *    column-bucketed index (Rust `RangeDependentIndex` shape: per-column
 *    buckets plus a linear `wide` fallback for ranges spanning more than
 *    `WIDE_COL_SPAN` columns, e.g. whole-row `1:1` ranges). Buckets are
 *    keyed by COLUMN because rows are unbounded (whole-column aggregates
 *    over sparse data are the hot case) while columns are capped at
 *    16 384.
 *  - **broad** — formulas whose reads cannot be statically bounded:
 *    `INDIRECT` / `OFFSET` / dynamic-range endpoints, plus volatile
 *    functions (NOW / TODAY / RAND / RANDBETWEEN / RANDARRAY). These are
 *    dirtied by EVERY value write — which is both Excel's volatile
 *    contract and exactly what the old whole-sheet flush did for them.
 *
 * Deps are extracted STATICALLY from the AST (`collectStaticDeps`),
 * resolving names through the registry — so `=SUM(MYRANGE)` depends on
 * the bound range, and a named LAMBDA's body contributes its refs (the
 * TS twin of the Rust B-4 fix). Static extraction over-approximates
 * (both IF branches register) which can only cause spurious re-evals,
 * never stale values.
 *
 * Installation is lazy and replace-shaped: the workbook installs a
 * formula's edges whenever the evaluator visits it (anchor derive runs
 * AND transitive trampoline visits via `EvalContext.onFormulaEvaluated`)
 * — the TS twin of Rust's hydrate-on-read dep install. Registry changes
 * bump `namesRevision` so the next visit re-extracts.
 */

import { cellKey, parseA1, parseRange } from './refs'
import type { CellKey, CellRange, Expr, NameBinding } from './types'

/** Workbook-global formula identity: `${sheetId}<NUL>${key}`. */
export type FormulaId = string

const FID_SEP = '\u0000'

export function fidOf(sheetId: string, key: CellKey): FormulaId {
  return `${sheetId}${FID_SEP}${key}`
}

export function fidLocation(fid: FormulaId): { sheetId: string; key: CellKey } {
  const idx = fid.indexOf(FID_SEP)
  return { sheetId: fid.slice(0, idx), key: fid.slice(idx + 1) }
}

/** Functions whose value can change without any cell changing. */
const VOLATILE_FUNCTIONS = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY'])

/**
 * Functions that compute cell references at runtime — their true read
 * set is invisible to static extraction, so the whole formula joins the
 * broad set. (CHOOSE is NOT here: its candidate refs all appear as
 * literal args and are collected normally.)
 */
const DYNAMIC_REF_FUNCTIONS = new Set(['INDIRECT', 'OFFSET'])

/**
 * Ranges spanning more than this many columns go to the linear `wide`
 * list instead of per-column buckets (mirrors Rust's
 * `WIDE_RANGE_BUCKET_THRESHOLD` rationale: registering a whole-row
 * range in 16k buckets would dominate insert cost).
 */
const WIDE_COL_SPAN = 128

export interface CollectedDeps {
  /** Point refs. `sheetName` undefined ⇒ the formula's own sheet. */
  points: Array<{ sheetName?: string; key: CellKey }>
  /** Range refs, normalized via `parseRange`. */
  ranges: Array<{ sheetName?: string; range: CellRange }>
  /** True when the formula must be dirtied on every value write. */
  broad: boolean
}

/**
 * Walk `ast` and collect every statically-visible cell/range reference.
 * `resolveName` threads the workbook names registry so named ranges and
 * named-LAMBDA bodies contribute their refs. LET/LAMBDA parameter names
 * that shadow workbook names may over-collect — harmless (spurious dep).
 */
export function collectStaticDeps(
  ast: Expr,
  resolveName: (name: string) => NameBinding | undefined,
): CollectedDeps {
  const out: CollectedDeps = { points: [], ranges: [], broad: false }
  walk(ast, undefined, out, resolveName, new Set())
  return out
}

function addPoint(out: CollectedDeps, a1: string, sheetName: string | undefined): void {
  const parsed = parseA1(a1)
  if (!parsed) return
  out.points.push({ sheetName, key: cellKey(parsed) })
}

function addRange(
  out: CollectedDeps,
  start: string,
  end: string,
  sheetName: string | undefined,
): void {
  const range = parseRange(start, end)
  if (!range) return
  out.ranges.push({ sheetName, range })
}

function walkNameBinding(
  binding: NameBinding,
  out: CollectedDeps,
  resolveName: (name: string) => NameBinding | undefined,
  visitedNames: Set<string>,
): void {
  if (binding.kind === 'range') {
    // Single-cell names parse as a degenerate range start===end.
    addRange(out, binding.start, binding.end, binding.sheetName)
    return
  }
  if (binding.kind === 'lambda') {
    walk(binding.body, undefined, out, resolveName, visitedNames)
  }
  // kind 'value' carries no cell refs; registry changes invalidate
  // every cached formula wholesale (see workbook.ts requestRecalc).
}

function resolveAndWalkName(
  name: string,
  out: CollectedDeps,
  resolveName: (name: string) => NameBinding | undefined,
  visitedNames: Set<string>,
): void {
  const canonical = name.toUpperCase()
  if (visitedNames.has(canonical)) return
  visitedNames.add(canonical)
  const binding = resolveName(name)
  if (binding) walkNameBinding(binding, out, resolveName, visitedNames)
}

function walk(
  node: Expr,
  sheetName: string | undefined,
  out: CollectedDeps,
  resolveName: (name: string) => NameBinding | undefined,
  visitedNames: Set<string>,
): void {
  switch (node.kind) {
    case 'number':
    case 'string':
    case 'boolean':
    case 'error':
      return
    case 'ref':
      addPoint(out, node.a1, sheetName)
      return
    case 'range':
      addRange(out, node.start, node.end, sheetName)
      return
    case 'dynamicRange':
      // Endpoints are computed at runtime (`A1:INDEX(...)`) — the
      // realized range is invisible statically. Collect the endpoint
      // exprs (they still pin the anchor side) and go broad.
      out.broad = true
      walk(node.start, sheetName, out, resolveName, visitedNames)
      walk(node.end, sheetName, out, resolveName, visitedNames)
      return
    case 'spillRef':
      // `A1#` reads the anchor's spilled array — the anchor dep covers it.
      walk(node.anchor, sheetName, out, resolveName, visitedNames)
      return
    case 'crossSheet':
      walk(node.inner, node.sheetName, out, resolveName, visitedNames)
      return
    case 'multiArea':
      for (const area of node.areas) walk(area, sheetName, out, resolveName, visitedNames)
      return
    case 'name':
      resolveAndWalkName(node.name, out, resolveName, visitedNames)
      return
    case 'unary':
      walk(node.operand, sheetName, out, resolveName, visitedNames)
      return
    case 'percent':
      walk(node.operand, sheetName, out, resolveName, visitedNames)
      return
    case 'binary':
      walk(node.left, sheetName, out, resolveName, visitedNames)
      walk(node.right, sheetName, out, resolveName, visitedNames)
      return
    case 'call': {
      const upper = node.name.toUpperCase()
      if (DYNAMIC_REF_FUNCTIONS.has(upper) || VOLATILE_FUNCTIONS.has(upper)) {
        out.broad = true
      }
      // Named-LAMBDA invocation: the body's refs are real deps.
      resolveAndWalkName(node.name, out, resolveName, visitedNames)
      for (const arg of node.args) walk(arg, sheetName, out, resolveName, visitedNames)
      return
    }
    case 'lambdaCall':
      walk(node.callee, sheetName, out, resolveName, visitedNames)
      for (const arg of node.args) walk(arg, sheetName, out, resolveName, visitedNames)
      return
    case 'arrayLiteral':
      for (const row of node.rows) {
        for (const cell of row) walk(cell, sheetName, out, resolveName, visitedNames)
      }
      return
  }
}

// ---------------------------------------------------------------------------
// Reverse index
// ---------------------------------------------------------------------------

/** Deps resolved against workbook sheet ids, ready for installation. */
export interface ResolvedDeps {
  points: Array<{ sheetId: string; key: CellKey }>
  ranges: Array<{ sheetId: string; range: CellRange }>
  broad: boolean
}

interface RangeEntry {
  readonly rowStart: number
  readonly rowEnd: number
  readonly colStart: number
  readonly colEnd: number
  readonly dependents: Set<FormulaId>
}

interface SheetRangeIndex {
  /** rangeKey → entry */
  entries: Map<string, RangeEntry>
  /** col → rangeKeys of narrow ranges covering that column */
  colBuckets: Map<number, Set<string>>
  /** rangeKeys of ranges spanning > WIDE_COL_SPAN columns */
  wide: Set<string>
}

interface InstalledRecord {
  /** AST object identity at install time — skip-reinstall check. */
  ast: Expr
  /** Names-registry revision at install time — skip-reinstall check. */
  namesRevision: number
  /** Runtime deps such as the formula's current spill range. */
  runtimeKey: string
  points: Array<{ sheetId: string; key: CellKey }>
  rangeKeys: Array<{ sheetId: string; rangeKey: string }>
  broad: boolean
}

function rangeKeyOf(range: CellRange): string {
  return `${range.rowStart}:${range.colStart}:${range.rowEnd}:${range.colEnd}`
}

export class DepGraph {
  private readonly cellDependents = new Map<string, Map<CellKey, Set<FormulaId>>>()

  private readonly rangeIndexes = new Map<string, SheetRangeIndex>()

  /** Formulas dirtied by every value write. Read by the workbook BFS. */
  readonly broadDependents = new Set<FormulaId>()

  private readonly installed = new Map<FormulaId, InstalledRecord>()

  /** Fast bail-out so dep-free bulk imports pay nothing per key. */
  isEmpty(): boolean {
    return this.installed.size === 0
  }

  /** True when `fid` is already installed for this exact AST + registry rev. */
  isCurrent(fid: FormulaId, ast: Expr, namesRevision: number, runtimeKey = ''): boolean {
    const rec = this.installed.get(fid)
    return (
      rec !== undefined &&
      rec.ast === ast &&
      rec.namesRevision === namesRevision &&
      rec.runtimeKey === runtimeKey
    )
  }

  /** Replace-install `fid`'s edges. */
  install(
    fid: FormulaId,
    ast: Expr,
    namesRevision: number,
    deps: ResolvedDeps,
    runtimeKey = '',
  ): void {
    this.uninstall(fid)
    const rec: InstalledRecord = {
      ast,
      namesRevision,
      runtimeKey,
      points: deps.points,
      rangeKeys: [],
      broad: deps.broad,
    }
    for (const p of deps.points) {
      let bySheet = this.cellDependents.get(p.sheetId)
      if (!bySheet) {
        bySheet = new Map()
        this.cellDependents.set(p.sheetId, bySheet)
      }
      let set = bySheet.get(p.key)
      if (!set) {
        set = new Set()
        bySheet.set(p.key, set)
      }
      set.add(fid)
    }
    for (const r of deps.ranges) {
      const rangeKey = rangeKeyOf(r.range)
      rec.rangeKeys.push({ sheetId: r.sheetId, rangeKey })
      let idx = this.rangeIndexes.get(r.sheetId)
      if (!idx) {
        idx = { entries: new Map(), colBuckets: new Map(), wide: new Set() }
        this.rangeIndexes.set(r.sheetId, idx)
      }
      let entry = idx.entries.get(rangeKey)
      if (!entry) {
        entry = {
          rowStart: r.range.rowStart,
          rowEnd: r.range.rowEnd,
          colStart: r.range.colStart,
          colEnd: r.range.colEnd,
          dependents: new Set(),
        }
        idx.entries.set(rangeKey, entry)
        if (entry.colEnd - entry.colStart > WIDE_COL_SPAN) {
          idx.wide.add(rangeKey)
        } else {
          for (let c = entry.colStart; c <= entry.colEnd; c += 1) {
            let bucket = idx.colBuckets.get(c)
            if (!bucket) {
              bucket = new Set()
              idx.colBuckets.set(c, bucket)
            }
            bucket.add(rangeKey)
          }
        }
      }
      entry.dependents.add(fid)
    }
    if (deps.broad) this.broadDependents.add(fid)
    this.installed.set(fid, rec)
  }

  /** Remove every edge `fid` installed. Bounded maps under formula churn. */
  uninstall(fid: FormulaId): void {
    const rec = this.installed.get(fid)
    if (!rec) return
    this.installed.delete(fid)
    for (const p of rec.points) {
      const bySheet = this.cellDependents.get(p.sheetId)
      const set = bySheet?.get(p.key)
      if (!set) continue
      set.delete(fid)
      if (set.size === 0) bySheet!.delete(p.key)
    }
    for (const r of rec.rangeKeys) {
      const idx = this.rangeIndexes.get(r.sheetId)
      const entry = idx?.entries.get(r.rangeKey)
      if (!entry) continue
      entry.dependents.delete(fid)
      if (entry.dependents.size === 0) {
        idx!.entries.delete(r.rangeKey)
        if (idx!.wide.has(r.rangeKey)) {
          idx!.wide.delete(r.rangeKey)
        } else {
          for (let c = entry.colStart; c <= entry.colEnd; c += 1) {
            const bucket = idx!.colBuckets.get(c)
            if (!bucket) continue
            bucket.delete(r.rangeKey)
            if (bucket.size === 0) idx!.colBuckets.delete(c)
          }
        }
      }
    }
    if (rec.broad) this.broadDependents.delete(fid)
  }

  /**
   * Size probe for the always-on scale suite (TS mirror of Rust's
   * `debug_dep_graph_stats`). Pure observation — no graph mutation.
   *
   *  - `installed`: formulas with live edges (size of `installed`).
   *  - `pointKeys`: distinct (sheet, key) coordinates with ≥1 point
   *    dependent (Σ of per-sheet cellDependents map sizes).
   *  - `rangeEntries`: distinct registered ranges across all sheets.
   *  - `broad`: formulas in the dirty-on-every-write set.
   *
   * @internal
   */
  debugStats(): { installed: number; pointKeys: number; rangeEntries: number; broad: number } {
    let pointKeys = 0
    for (const bySheet of this.cellDependents.values()) pointKeys += bySheet.size
    let rangeEntries = 0
    for (const idx of this.rangeIndexes.values()) rangeEntries += idx.entries.size
    return {
      installed: this.installed.size,
      pointKeys,
      rangeEntries,
      broad: this.broadDependents.size,
    }
  }

  /**
   * Append every formula depending on (sheetId, key) — point edges plus
   * range entries containing the coordinate (candidates narrowed via the
   * column bucket; `wide` scanned linearly, expected tiny).
   */
  dependentsOfInto(sheetId: string, key: CellKey, out: FormulaId[]): void {
    const direct = this.cellDependents.get(sheetId)?.get(key)
    if (direct) {
      for (const fid of direct) out.push(fid)
    }
    const idx = this.rangeIndexes.get(sheetId)
    if (!idx) return
    const sep = key.indexOf(':')
    const row = Number(key.slice(0, sep))
    const col = Number(key.slice(sep + 1))
    const bucket = idx.colBuckets.get(col)
    if (bucket) {
      for (const rangeKey of bucket) {
        const entry = idx.entries.get(rangeKey)!
        if (row >= entry.rowStart && row <= entry.rowEnd) {
          for (const fid of entry.dependents) out.push(fid)
        }
      }
    }
    for (const rangeKey of idx.wide) {
      const entry = idx.entries.get(rangeKey)!
      if (
        row >= entry.rowStart &&
        row <= entry.rowEnd &&
        col >= entry.colStart &&
        col <= entry.colEnd
      ) {
        for (const fid of entry.dependents) out.push(fid)
      }
    }
  }
}
