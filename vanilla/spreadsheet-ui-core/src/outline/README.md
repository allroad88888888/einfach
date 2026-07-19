# outline — grouping / outline / collapse (#07)

Row and column grouping with Excel outline semantics. UI-core canonical
(CANONICAL_OWNERSHIP §7-2): group metadata never participates in evaluation
and has no xlsx round-trip requirement, so the per-sheet group lists here are
the source of truth. Collapse **visibility** is not a second fact — collapsing
a group replays a hide transition into the hidden rows/columns canonical sets
(`viewport/hidden.ts`), expanding replays the inverse.

## Model

- A group is an inclusive axis interval `{ start, end, collapsed }`.
- Nesting **level is derived from containment**, never stored: `level = 1 +`
  number of groups containing the interval. Identical ranges nest by list
  order (grouping the same span twice = one level deeper, like Excel).
- Partial overlaps (neither interval contains the other) are rejected as
  `'invalid'` — the interval-list model cannot represent Excel's per-row
  level splitting, and Google Sheets rejects them outright too.
- Depth cap **8** (Excel outline levels), enforced against the whole
  post-command list — adding an outer group that would push an inner group
  past 8 is `'invalid'`.
- Bounded metadata: at most **200 groups per sheet per axis**
  (`OUTLINE_MAX_GROUPS_PER_SHEET_AXIS`); the 201st add is `'invalid'`.

## Collapse ↔ hidden linkage

`toggleOutlineGroupCollapsedAtom` / `collapseOutlineToLevelAtom` compute the
union of collapsed-group intervals before and after the flag change and apply
only the delta to the hidden set:

- collapse hides the interval indices not already covered by another
  collapsed group,
- expand unhides only the indices **no remaining collapsed group covers**
  (nested collapsed groups keep their rows hidden),
- manually hidden indices outside the delta are untouched,
- ungrouping a collapsed group leaves its indices hidden (Excel semantics —
  they become plain manually-hidden indices).

The state write goes through the hidden module's registered local-replay
applier (`VIEWPORT_HIDDEN_REPLAY_KEY`), so the optional hidden persistence
mirror fires exactly as if a hide/unhide command had run — without pushing a
second history entry.

## Undo (single-entry decision)

One gesture = **one** history entry of kind `'outline'` with a `localReplay`
payload (`OutlineReplaySnapshot`) carrying the axis group list and — for
collapse/expand — the exact hidden before/after snapshots. The `'outline'`
applier restores the metadata itself and delegates the hidden slice to the
hidden applier. Rationale: `HistoryEntry.localReplay` is single-payload and
`localSidePayloads` (the bundling mechanism for "one gesture, several view
facts") is reserved for backend-transaction entries, so pushing a separate
`viewport.hidden` entry per collapse would split one gesture across two undo
steps with an inconsistent intermediate state (collapsed flag without hidden
rows, or vice versa). Structural backend mutations snapshot outline state
into `localSidePayloads` under the same `'outline'` applier key.

## Structural shifts

`applyOutlineStructuralShiftAtom` consumes `BackendMutationResult.structuralShift`
(wired in `operations/index.ts` next to the freeze/hidden appliers) and
remaps every interval with the pure `remapRangeAfterStructuralShift` helper:
inserts inside a group extend it, overlapping deletes shrink it, a delete
covering the whole interval removes the group.

## Atoms

| atom | class | notes |
| --- | --- | --- |
| `outlineAtom` | derived (read-only projection) | `spreadsheet.outline.state` |
| `groupSelectionAtom` | command | group selected rows/cols, one level per gesture |
| `ungroupSelectionAtom` | command | remove innermost level(s) inside the selection |
| `addOutlineGroupAtom` | command | explicit-range variant of group |
| `ungroupOutlineRangeAtom` | command | explicit-range variant of ungroup |
| `toggleOutlineGroupCollapsedAtom` | command | +/− gutter buttons; syncs hidden |
| `collapseOutlineToLevelAtom` | command | Excel 1/2/3… level buttons; syncs hidden |
| `applyOutlineStructuralShiftAtom` | command | interval remap, no own history entry |
| `outlineBackingAtom` | source (private) | `spreadsheet.outline.stateBacking` |

Commands return `'committed' | 'unchanged' | 'invalid'` and are fully
synchronous.

## Persistence

TODO: no backend port yet. When durable outlines are needed, add optional
`readOutlineProjection` / `setOutlineGroups` backend ports and a one-shot
per-sheet hydrate command mirroring `hydrateViewportHiddenAtom` (seed-once,
local commands own the sheet afterwards). Until then the `source` input on
collapse commands only feeds the existing hidden persistence mirror.
