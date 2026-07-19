import type { Store } from '@einfach/core'
import { resolveContentMutationAtom, type CellRange } from '@einfach/spreadsheet-ui-core'

/**
 * Mutation-gateway resolution for a Format Cells dialog save: remaps the
 * display-coordinate selection to source rows (filter/sort) and enforces
 * the protection gate — locked cells on a protected sheet cannot be
 * reformatted.
 *
 * A blocked resolution throws BEFORE any transport: the shared save
 * controller (`createFormatCellsSaveController`) rejects ahead of its
 * write boundary, so the dialog settles as `error-open` with zero
 * `setFormatRange` calls, and the gateway has already recorded the
 * structured diagnostic + lastBlock.
 */
export function resolveFormatSaveSourceRanges(
  store: Store,
  sheetId: string,
  range: CellRange,
): CellRange[] {
  const resolution = store.setter(resolveContentMutationAtom, {
    kind: 'set-format-range',
    sheetId,
    range,
  })
  if (resolution.status === 'blocked') {
    throw new Error(resolution.diagnostic.message)
  }
  return (resolution.ranges ?? [range]).map((sourceRange) => ({ ...sourceRange }))
}
