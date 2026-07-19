export type OutlineAxis = 'row' | 'column'

/**
 * One grouping band on an axis. `start` / `end` are inclusive zero-based
 * indices. The nesting level is NOT stored — it derives from containment
 * (see `getOutlineLeveledGroupsForSheet`), so structural remaps only have
 * to translate the interval.
 */
export interface OutlineGroup {
  readonly start: number
  readonly end: number
  readonly collapsed: boolean
}

export interface OutlineGroupWithLevel extends OutlineGroup {
  /** 1-based nesting depth derived from containment (outermost = 1, cap 8). */
  readonly level: number
}

export interface OutlineState {
  readonly rowsBySheet: Record<string, readonly OutlineGroup[]>
  readonly colsBySheet: Record<string, readonly OutlineGroup[]>
}

export type OutlineCommandOutcome = 'committed' | 'unchanged' | 'invalid'

export interface OutlineAxisRangeInput {
  readonly sheetId: string
  readonly axis: OutlineAxis
  readonly start: number
  readonly end: number
}

export interface OutlineSelectionCommandInput {
  readonly axis: OutlineAxis
  /**
   * Optional persistence hook forwarded to the hidden-set mirror when a
   * collapse state changes. Group/ungroup metadata itself has no backend
   * port yet — see the module TODO on outline persistence.
   */
  readonly source?: unknown
}

export interface ToggleOutlineGroupCollapsedInput extends OutlineAxisRangeInput {
  /**
   * Disambiguates identical-range groups (grouping the same span twice
   * creates a deeper level). When omitted the outermost match toggles.
   */
  readonly level?: number
  readonly source?: unknown
}

export interface CollapseOutlineToLevelInput {
  readonly sheetId: string
  readonly axis: OutlineAxis
  /**
   * Excel level button semantics: groups with derived level >= `level`
   * collapse, shallower groups expand. `maxLevel + 1` expands everything.
   */
  readonly level: number
  readonly source?: unknown
}
