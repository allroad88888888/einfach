/** @jsxImportSource solid-js */

import { createMemo, For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  presenceStateAtom,
  remoteCursorsAtom,
  type Participant,
  type RemoteCursor,
} from '@einfach/spreadsheet-ui-core'

export interface SpreadsheetPresenceOverlayProps {
  /** Optional active sheet id; when supplied, only cursors on that sheet are rendered. */
  activeSheetId?: string
  /** Optional cell coordinate resolver. Hosts wire this to a real layout function;
   *  the overlay falls back to a placeholder when omitted so the overlay still
   *  renders for tests and demos. */
  resolveCellPosition?: (sheetId: string, row: number, col: number) => {
    left: number
    top: number
    width: number
    height: number
  }
  class?: string
  cursorClass?: string
  selectionClass?: string
  labelClass?: string
  'data-testid'?: string
}

interface ResolvedAnchor {
  row: number
  col: number
  rowEnd: number
  colEnd: number
}

function anchorFromSelection(cursor: RemoteCursor): ResolvedAnchor {
  const s = cursor.selection
  if (s.kind === 'cell') {
    return { row: s.anchor.row, col: s.anchor.col, rowEnd: s.anchor.row, colEnd: s.anchor.col }
  }
  if (s.kind === 'range') {
    return {
      row: Math.min(s.anchor.row, s.focus.row),
      col: Math.min(s.anchor.col, s.focus.col),
      rowEnd: Math.max(s.anchor.row, s.focus.row),
      colEnd: Math.max(s.anchor.col, s.focus.col),
    }
  }
  if (s.kind === 'row') {
    return {
      row: Math.min(s.rowAnchor, s.rowFocus),
      col: 0,
      rowEnd: Math.max(s.rowAnchor, s.rowFocus),
      colEnd: 0,
    }
  }
  if (s.kind === 'column') {
    return {
      row: 0,
      col: Math.min(s.colAnchor, s.colFocus),
      rowEnd: 0,
      colEnd: Math.max(s.colAnchor, s.colFocus),
    }
  }
  return { row: 0, col: 0, rowEnd: 0, colEnd: 0 }
}

export function SpreadsheetPresenceOverlay(props: SpreadsheetPresenceOverlayProps) {
  const cursors = useAtomValue(remoteCursorsAtom)
  const state = useAtomValue(presenceStateAtom)

  function participantFor(participantId: string): Participant | undefined {
    return state().participants.find((p) => p.id === participantId)
  }

  function visibleCursors(): RemoteCursor[] {
    const list = cursors()
    const activeId = props.activeSheetId
    if (!activeId) return list
    return list.filter((c) => c.sheetId === activeId)
  }

  function positionFor(cursor: RemoteCursor) {
    const anchor = anchorFromSelection(cursor)
    if (props.resolveCellPosition) {
      const tl = props.resolveCellPosition(cursor.sheetId, anchor.row, anchor.col)
      const br = props.resolveCellPosition(cursor.sheetId, anchor.rowEnd, anchor.colEnd)
      return {
        left: tl.left,
        top: tl.top,
        width: Math.max(0, br.left + br.width - tl.left),
        height: Math.max(0, br.top + br.height - tl.top),
      }
    }
    return {
      left: anchor.col,
      top: anchor.row,
      width: anchor.colEnd - anchor.col + 1,
      height: anchor.rowEnd - anchor.row + 1,
    }
  }

  return (
    <div
      class={`spreadsheet-presence-overlay ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'presence-overlay'}
      style={{ position: 'absolute', inset: '0', 'pointer-events': 'none' }}
    >
      <For each={visibleCursors()}>
        {(cursor) => {
          const participant = createMemo(() => participantFor(cursor.participantId))
          const pos = createMemo(() => positionFor(cursor))
          const color = createMemo(() => participant()?.colorHint ?? '#888888')
          return (
            <div
              class={`presence-cursor ${props.cursorClass ?? ''}`.trim()}
              data-testid={`presence-cursor-${cursor.participantId}`}
              data-participant-id={cursor.participantId}
              data-sheet-id={cursor.sheetId}
              data-selection-kind={cursor.selection.kind}
              style={{
                position: 'absolute',
                left: `${pos().left}px`,
                top: `${pos().top}px`,
                width: `${pos().width}px`,
                height: `${pos().height}px`,
                '--presence-color': color(),
                'border-color': color(),
              }}
            >
              <div
                class={`presence-selection ${props.selectionClass ?? ''}`.trim()}
                data-testid={`presence-selection-${cursor.participantId}`}
                style={{ 'background-color': color(), opacity: '0.15' }}
              />
              <Show when={participant()}>
                {(p) => (
                  <span
                    class={`presence-label ${props.labelClass ?? ''}`.trim()}
                    data-testid={`presence-label-${cursor.participantId}`}
                    data-last-seen-at={p().lastSeenAt}
                    style={{ 'background-color': color(), color: '#ffffff' }}
                  >
                    {p().displayName}
                  </span>
                )}
              </Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}
