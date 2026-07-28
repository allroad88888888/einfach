import type { Store } from '@einfach/core'
import {
  beginProjectionAtom,
  resolveProjectionAtom,
  type ProjectionSnapshot,
  type VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

type ReadyVisibleProjectionSnapshot = Omit<ProjectionSnapshot, 'status' | 'result'> & {
  readonly status: 'ready'
  readonly result: VisibleProjectionResult
}

/** Seeds projection state through the same Core lifecycle used by production code. */
export function seedReadyVisibleProjection(
  store: Store,
  snapshot: ReadyVisibleProjectionSnapshot,
): void {
  const previousRequest =
    snapshot.request?.kind === 'visible-window' ? snapshot.request : undefined
  const begin = store.setter(beginProjectionAtom, {
    kind: 'visible-window',
    sheetId: snapshot.result.sheetId,
    reason: previousRequest?.reason ?? 'test',
    window: snapshot.result.window,
    revision: previousRequest?.revision,
  })

  if (begin.status !== 'started') {
    throw new Error(`projection fixture failed to start: ${begin.status}`)
  }

  const resolved = store.setter(resolveProjectionAtom, {
    request: begin.request,
    result: {
      ...snapshot.result,
      requestId: begin.request.requestId,
      cells: snapshot.result.cells.filter(
        (cell) =>
          cell.row >= snapshot.result.window.rowStart &&
          cell.row <= snapshot.result.window.rowEnd &&
          cell.col >= snapshot.result.window.colStart &&
          cell.col <= snapshot.result.window.colEnd,
      ),
      ...(begin.request.revision === undefined ? {} : { revision: begin.request.revision }),
    },
  })

  if (resolved.status !== 'accepted') {
    throw new Error(`projection fixture failed to resolve: ${resolved.reason}`)
  }
}
