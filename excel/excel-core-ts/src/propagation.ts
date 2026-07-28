/**
 * Mutation propagation — the workbook side of KEY_GRANULAR_INVALIDATION
 * (audit C-1/C-2/C-6).
 *
 * `createPropagation` owns the `DepGraph` plus the revision/epoch
 * counters and exposes the four operations `createWorkbook` wires up:
 *
 *  - `installDepsFor`  — lazy dep install, called from the evaluator's
 *    `onFormulaEvaluated` hook (Rust hydrate-on-read mirror).
 *  - `postWrite`       — the centralized post-mutation choke point:
 *    dirty BFS over dependents, epoch bumps, eviction, revision signal.
 *  - `recalculateAllSheets` — registry-driven FULL invalidation
 *    (names / custom formulas / locale / F9).
 *  - `revision`        — monotonic workbook revision (probe stamping).
 */

import type { Store } from '@einfach/core'

import { collectStaticDeps, DepGraph, fidLocation, fidOf, type ResolvedDeps } from './deps'
import type { WorkbookSheet } from './sheet'
import type { EvalRuntimeDeps, Expr, NameBinding } from './types'

/** One entry per written key, recorded by every cell mutator. */
export interface WriteRecord {
  readonly key: string
  /** AST of the cell BEFORE the write (dep-teardown trigger). */
  readonly prevAst: Expr | undefined
  /** False for format-only swaps — they never dirty formulas. */
  readonly valueChanged: boolean
}

export interface Propagation {
  /** Monotonic workbook revision — bumped once per mutation batch. */
  revision(): number
  installDepsFor(
    owner: WorkbookSheet,
    key: string,
    ast: Expr,
    runtimeDeps?: EvalRuntimeDeps,
  ): void
  postWrite(sheet: WorkbookSheet, records: ReadonlyArray<WriteRecord>): void
  recalculateAllSheets(): void
  /**
   * DepGraph size probe (TS mirror of Rust `debug_dep_graph_stats`).
   * Pure observation for the always-on scale suite. @internal
   */
  debugDepGraphStats(): {
    installed: number
    pointKeys: number
    rangeEntries: number
    broad: number
  }
}

export function createPropagation(deps: {
  store: Store
  sheetsList: WorkbookSheet[]
  sheetsById: Map<string, WorkbookSheet>
  sheetsByName: Map<string, WorkbookSheet>
  /** Canonical (case-insensitive) names-registry lookup. */
  resolveName(name: string): NameBinding | undefined
}): Propagation {
  const { store, sheetsList, sheetsById, sheetsByName, resolveName } = deps

  // Reverse dependency graph + lazy-install bookkeeping (audit C-2).
  // `namesRevision` bumps on every registry-driven recalc so the next
  // evaluation of each formula re-extracts deps against the new
  // names/custom-formula registry. `epochCounter` supplies the
  // ever-changing values written into per-formula epoch atoms.
  const depGraph = new DepGraph()
  let namesRevision = 0
  let epochCounter = 0

  const runtimeRangeKey = (ranges: ResolvedDeps['ranges']): string =>
    ranges
      .map((r) =>
        `${r.sheetId}:${r.range.rowStart}:${r.range.colStart}:${r.range.rowEnd}:${r.range.colEnd}`,
      )
      .join('|')

  // Workbook-scope revision counter. Bumped once per mutation batch in
  // `postWrite` (the centralized choke point). Sheets read it via the
  // `revisionProvider` callback to stamp `lastEvalRevision` on each
  // formula derive run, and it doubles as the monotonic value written
  // into each touched sheet's `revisionAtom`.
  let revisionCounter = 0

  /**
   * Lazy dep install (audit C-2): extract the formula's static refs and
   * replace its edges in the dep graph. Called from the evaluator hook
   * for the anchor AND every transitively-visited formula cell — the TS
   * twin of Rust's hydrate-on-read dep install. Skips when the AST
   * object and names revision are unchanged (O(1) on repeat visits).
   */
  function installDepsFor(
    owner: WorkbookSheet,
    key: string,
    ast: Expr,
    runtimeDeps?: EvalRuntimeDeps,
  ): void {
    const fid = fidOf(owner.id, key)
    const collected = collectStaticDeps(ast, resolveName)
    const resolved: ResolvedDeps = { points: [], ranges: [], broad: collected.broad }
    for (const p of collected.points) {
      const target = p.sheetName === undefined ? owner : sheetsByName.get(p.sheetName)
      if (!target) continue
      resolved.points.push({ sheetId: target.id, key: p.key })
    }
    for (const r of collected.ranges) {
      const target = r.sheetName === undefined ? owner : sheetsByName.get(r.sheetName)
      if (!target) continue
      resolved.ranges.push({ sheetId: target.id, range: r.range })
    }
    const runtimeRanges: ResolvedDeps['ranges'] = []
    for (const r of runtimeDeps?.ranges ?? []) {
      const target = r.sheetName === undefined ? owner : sheetsByName.get(r.sheetName)
      if (!target) continue
      const resolvedRange = { sheetId: target.id, range: r.range }
      runtimeRanges.push(resolvedRange)
      resolved.ranges.push(resolvedRange)
    }
    const runtimeKey = runtimeRangeKey(runtimeRanges)
    if (depGraph.isCurrent(fid, ast, namesRevision, runtimeKey)) return
    depGraph.install(fid, ast, namesRevision, resolved, runtimeKey)
  }

  /** Bump `key`'s epoch atom (if a derive is cached), re-deriving it. */
  function bumpEpoch(owner: WorkbookSheet, key: string, bumped: Set<string>): void {
    const epoch = owner._internal.epochAtomIfCached(key)
    if (!epoch) return
    const fid = fidOf(owner.id, key)
    if (bumped.has(fid)) return
    bumped.add(fid)
    epochCounter += 1
    // core/core's setter synchronously flushes: the formula derive
    // (the epoch atom's only back-dep) re-runs and publishes to its
    // listeners before this call returns.
    store.setter(epoch, epochCounter)
  }

  /**
   * The centralized post-mutation choke point (audit C-1/C-2): storage
   * was already mutated in place by the caller; this propagates the
   * change.
   *
   * Eager-at-mutation semantics are preserved — true dependents
   * re-derive synchronously inside the mutator. That remains the
   * central engine difference vs Rust-core (purely lazy: dirty until
   * next read). For probe semantics:
   *
   *   * "Never-read" formulas stay dirty across writes (no cached
   *     derive → nothing to bump).
   *   * "Already-read" DEPENDENT formulas auto-recover to clean during
   *     the write; non-dependents keep their valid cache and stay clean
   *     without re-deriving (pre-key-granular they were re-derived to
   *     the same end state — observable probe results are unchanged,
   *     see `excel-core-ts-debug-probes.test.ts`).
   */
  function postWrite(sheet: WorkbookSheet, records: ReadonlyArray<WriteRecord>): void {
    revisionCounter += 1
    const cells = sheet._internal.cells

    // 1. Dep teardown for overwritten/cleared formulas (audit C-6). A
    //    format-only swap keeps the same AST object and is skipped. New
    //    ASTs re-install lazily on next evaluation.
    let evictions: string[] | null = null
    for (const rec of records) {
      if (!rec.prevAst) continue
      const next = cells.get(rec.key)
      if (next?.ast === rec.prevAst) continue
      depGraph.uninstall(fidOf(sheet.id, rec.key))
      if (!next?.ast) {
        if (!evictions) evictions = []
        evictions.push(rec.key)
      }
    }

    let anyValueChange = false
    for (const rec of records) {
      if (rec.valueChanged) {
        anyValueChange = true
        break
      }
    }

    // 2. Dirty BFS over the reverse graph — O(dependents-of-written-
    //    keys), transitively (a dependent formula's own cell propagates
    //    to ITS dependents, mirroring Rust `mark_dependents_dirty`).
    //    Broad formulas (volatile / dynamic-ref) join on every value
    //    write. Skipped entirely while the graph is empty so dep-free
    //    bulk imports pay nothing per key.
    const dirtyFormulas: Array<[WorkbookSheet, string]> = []
    if (anyValueChange && !depGraph.isEmpty()) {
      const seen = new Set<string>()
      const expand: Array<[string, string]> = []
      for (const rec of records) {
        if (rec.valueChanged) expand.push([sheet.id, rec.key])
      }
      for (const fid of depGraph.broadDependents) {
        seen.add(fid)
        const loc = fidLocation(fid)
        const owner = sheetsById.get(loc.sheetId)
        if (!owner) continue
        dirtyFormulas.push([owner, loc.key])
        expand.push([loc.sheetId, loc.key])
      }
      const scratch: string[] = []
      while (expand.length > 0) {
        const [sheetId, key] = expand.pop()!
        scratch.length = 0
        depGraph.dependentsOfInto(sheetId, key, scratch)
        for (const fid of scratch) {
          if (seen.has(fid)) continue
          seen.add(fid)
          const loc = fidLocation(fid)
          const owner = sheetsById.get(loc.sheetId)
          if (!owner) continue
          dirtyFormulas.push([owner, loc.key])
          expand.push([loc.sheetId, loc.key])
        }
      }
    }

    // 3. Written keys' own cached derives re-derive (their cell value
    //    changed under them) — including a formula's final re-derive to
    //    a literal/blank right before eviction, so listeners observe the
    //    overwrite.
    const bumped = new Set<string>()
    if (anyValueChange) {
      for (const rec of records) {
        if (rec.valueChanged) bumpEpoch(sheet, rec.key, bumped)
      }
    }

    // 4. Re-derive true dependents.
    const dirtySheets = new Set<WorkbookSheet>()
    dirtySheets.add(sheet)
    for (const [owner, key] of dirtyFormulas) {
      bumpEpoch(owner, key, bumped)
      dirtySheets.add(owner)
    }

    // 5. Evict orphaned derives (audit C-6) — cache entries + epoch
    //    atoms drop out of the sheet maps; the store side lives in
    //    WeakMaps keyed by the dropped atoms and becomes collectable.
    if (evictions) {
      for (const key of evictions) sheet._internal.evict(key)
    }

    // 6. Sheet-changed signal for projection-style subscribers.
    for (const touched of dirtySheets) {
      store.setter(touched.revisionAtom, revisionCounter)
    }
  }

  /**
   * Registry-driven FULL invalidation (names / custom formulas / locale
   * / F9). Deliberately broad — a registry change may affect any formula
   * (audit C-3, documented contract): every cached derive re-derives,
   * and the names-revision bump forces dep re-extraction on each
   * formula's next evaluation.
   */
  function recalculateAllSheets(): void {
    namesRevision += 1
    revisionCounter += 1
    const bumped = new Set<string>()
    for (const sheet of sheetsList) {
      // Snapshot — derive runs triggered by the bumps must not interleave
      // with live iteration of the cache map.
      const keys = Array.from(sheet._internal.cachedFormulaKeys())
      for (const key of keys) bumpEpoch(sheet, key, bumped)
      store.setter(sheet.revisionAtom, revisionCounter)
    }
  }

  return {
    revision: () => revisionCounter,
    installDepsFor,
    postWrite,
    recalculateAllSheets,
    debugDepGraphStats: () => depGraph.debugStats(),
  }
}
