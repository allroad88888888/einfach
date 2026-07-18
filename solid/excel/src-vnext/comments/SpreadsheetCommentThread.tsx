import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeCommentSessionAtom,
  commentEditorDraftAtom,
  commentMutationStateAtom,
  commentMutationSubmissionBlockedAtom,
  commentSessionAtom,
  runCommentMutationAtom,
  setCommentDraftAtom,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetCommentThreadProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetCommentThread(props: SpreadsheetCommentThreadProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const session = useAtomValue(commentSessionAtom)
  const draft = useAtomValue(commentEditorDraftAtom)
  const mutation = useAtomValue(commentMutationStateAtom)
  const submissionBlocked = useAtomValue(commentMutationSubmissionBlockedAtom)

  createEffect(() => {
    if (session() === null) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeCommentSessionAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

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

  function handlePost() {
    void store.setter(runCommentMutationAtom, { action: 'post', source: backend })
  }

  function handleResolve() {
    void store.setter(runCommentMutationAtom, { action: 'resolve', source: backend })
  }

  function handleClose() {
    store.setter(closeCommentSessionAtom)
  }

  return (
    <Show when={session() !== null}>
      <div
        class={`comment-thread spreadsheet-comment-thread ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'comment-thread'}
        role="dialog"
        aria-label="Comment thread"
        aria-busy={mutation().phase === 'PendingPublished'}
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={handleClose}
        >
          ×
        </button>
        <span class="comment-thread-cell" data-testid="comment-thread-cell">
          {session()?.sheetId} · {cellLabel()}
        </span>
        <textarea
          class="comment-thread-textarea spreadsheet-comment-thread-textarea"
          data-testid="comment-thread-textarea"
          value={draft()}
          disabled={
            mutation().phase === 'PendingPublished' || mutation().phase === 'OutcomeUnknownBlocked'
          }
          onInput={(e) => {
            store.setter(setCommentDraftAtom, (e.target as HTMLTextAreaElement).value)
          }}
        />
        <button
          type="button"
          class="comment-post-button"
          data-testid="comment-post-button"
          disabled={submissionBlocked()}
          onClick={handlePost}
        >
          Post
        </button>
        <Show when={session()?.threadId != null}>
          <button
            type="button"
            class="comment-resolve-button"
            data-testid="comment-resolve-button"
            disabled={submissionBlocked()}
            onClick={handleResolve}
          >
            Resolve thread
          </button>
        </Show>
        <Show when={mutation().error !== null}>
          <p class="comment-mutation-error" data-testid="comment-mutation-error" role="alert">
            {mutation().error}
          </p>
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
