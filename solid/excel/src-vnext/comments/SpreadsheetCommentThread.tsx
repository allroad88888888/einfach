import { Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeCommentSessionAtom,
  commentEditorDraftAtom,
  commentSessionAtom,
  setCommentDraftAtom,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetCommentThreadProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetCommentThread(props: SpreadsheetCommentThreadProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const session = useAtomValue(commentSessionAtom)
  const draft = useAtomValue(commentEditorDraftAtom)

  function cellLabel() {
    const s = session()
    if (!s) return ''
    const col = s.cell.col
    let value = col + 1
    let label = ''
    while (value > 0) {
      const rem = (value - 1) % 26
      label = String.fromCharCode(65 + rem) + label
      value = Math.floor((value - 1) / 26)
    }
    return `${label}${s.cell.row + 1}`
  }

  async function handlePost() {
    const s = session()
    if (!s) return
    await backend.postComment?.({
      kind: 'post-comment',
      sheetId: s.sheetId,
      cell: s.cell,
      threadId: s.threadId,
      body: draft(),
    })
    store.setter(closeCommentSessionAtom)
  }

  async function handleResolve() {
    const s = session()
    if (!s?.threadId) return
    await backend.resolveCommentThread?.({
      kind: 'resolve-comment-thread',
      sheetId: s.sheetId,
      threadId: s.threadId,
    })
  }

  function handleClose() {
    store.setter(closeCommentSessionAtom)
  }

  return (
    <Show when={session() !== null}>
      <div
        class={`comment-thread spreadsheet-comment-thread ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'comment-thread'}
      >
        <span class="comment-thread-cell" data-testid="comment-thread-cell">
          {session()?.sheetId} · {cellLabel()}
        </span>
        <textarea
          class="comment-thread-textarea spreadsheet-comment-thread-textarea"
          data-testid="comment-thread-textarea"
          value={draft()}
          onInput={(e) => {
            store.setter(setCommentDraftAtom, (e.target as HTMLTextAreaElement).value)
          }}
        />
        <button
          type="button"
          class="comment-post-button"
          data-testid="comment-post-button"
          onClick={() => {
            void handlePost()
          }}
        >
          Post
        </button>
        <Show when={session()?.threadId != null}>
          <button
            type="button"
            class="comment-resolve-button"
            data-testid="comment-resolve-button"
            onClick={() => {
              void handleResolve()
            }}
          >
            Resolve thread
          </button>
        </Show>
        <button
          type="button"
          class="comment-close-button"
          data-testid="comment-close-button"
          onClick={handleClose}
        >
          Close
        </button>
      </div>
    </Show>
  )
}
