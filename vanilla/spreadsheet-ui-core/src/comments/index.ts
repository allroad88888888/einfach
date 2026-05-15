import { atom } from '@einfach/core'
import type { CommentIntent, CommentSessionState } from './types'

export * from './types'

export const commentSessionAtom = atom<CommentSessionState | null>(null)
commentSessionAtom.debugLabel = 'spreadsheet.comments.session'

export const commentEditorDraftAtom = atom<string>('')
commentEditorDraftAtom.debugLabel = 'spreadsheet.comments.draft'

export const commentIntentAtom = atom<CommentIntent | null>(null)
commentIntentAtom.debugLabel = 'spreadsheet.comments.intent'

export const openCommentSessionAtom = atom(
  null,
  (_get, set, input: { sheetId: string; cell: { row: number; col: number }; threadId?: string }) => {
    set(commentSessionAtom, { sheetId: input.sheetId, cell: input.cell, threadId: input.threadId })
    set(commentEditorDraftAtom, '')
  },
)
openCommentSessionAtom.debugLabel = 'spreadsheet.comments.openSession'

export const closeCommentSessionAtom = atom(null, (_get, set) => {
  set(commentSessionAtom, null)
  set(commentEditorDraftAtom, '')
})
closeCommentSessionAtom.debugLabel = 'spreadsheet.comments.closeSession'

export const setCommentDraftAtom = atom(null, (_get, set, draft: string) => {
  set(commentEditorDraftAtom, draft)
})
setCommentDraftAtom.debugLabel = 'spreadsheet.comments.setDraft'
