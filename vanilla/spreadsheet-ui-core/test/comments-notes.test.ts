import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeCommentSessionAtom,
  commentEditorDraftAtom,
  commentIntentAtom,
  commentSessionAtom,
  openCommentSessionAtom,
  setCommentDraftAtom,
  type ClearNoteRequest,
  type DeleteCommentRequest,
  type DisplayCell,
  type PostCommentRequest,
  type ResolveCommentThreadRequest,
  type SetNoteRequest,
  type VisibleProjectionResult,
} from '../src'

describe('comments-notes', () => {
  test('initial state: session null, draft empty, intent null', () => {
    const store = createStore()
    expect(store.getter(commentSessionAtom)).toBeNull()
    expect(store.getter(commentEditorDraftAtom)).toBe('')
    expect(store.getter(commentIntentAtom)).toBeNull()
  })

  test('openCommentSessionAtom sets session with cell and no threadId', () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, { sheetId: 'sheet-1', cell: { row: 2, col: 3 } })
    const session = store.getter(commentSessionAtom)
    expect(session).toEqual({ sheetId: 'sheet-1', cell: { row: 2, col: 3 }, threadId: undefined })
  })

  test('openCommentSessionAtom clears draft on open', () => {
    const store = createStore()
    store.setter(commentEditorDraftAtom, 'leftover')
    store.setter(openCommentSessionAtom, { sheetId: 'sheet-1', cell: { row: 0, col: 0 } })
    expect(store.getter(commentEditorDraftAtom)).toBe('')
  })

  test('openCommentSessionAtom carries threadId when provided', () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, { sheetId: 'sheet-1', cell: { row: 1, col: 1 }, threadId: 't1' })
    expect(store.getter(commentSessionAtom)?.threadId).toBe('t1')
  })

  test('setCommentDraftAtom updates draft', () => {
    const store = createStore()
    store.setter(setCommentDraftAtom, 'Hello')
    expect(store.getter(commentEditorDraftAtom)).toBe('Hello')
  })

  test('closeCommentSessionAtom resets session and draft', () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, { sheetId: 'sheet-1', cell: { row: 0, col: 0 } })
    store.setter(setCommentDraftAtom, 'draft text')
    store.setter(closeCommentSessionAtom)
    expect(store.getter(commentSessionAtom)).toBeNull()
    expect(store.getter(commentEditorDraftAtom)).toBe('')
  })

  test('DisplayCell accepts noteIndicator and commentThreadId', () => {
    const cell: DisplayCell = {
      row: 0,
      col: 0,
      displayValue: 'A',
      noteIndicator: true,
      commentThreadId: 't1',
    }
    expect(cell.noteIndicator).toBe(true)
    expect(cell.commentThreadId).toBe('t1')
  })

  test('DisplayCell indicator fields pass through VisibleProjectionResult unchanged', () => {
    const result: VisibleProjectionResult = {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      requestId: 1,
      cells: [{ row: 0, col: 0, displayValue: 'A', noteIndicator: true, commentThreadId: 't1' }],
    }
    expect(result.cells[0].noteIndicator).toBe(true)
    expect(result.cells[0].commentThreadId).toBe('t1')
  })

  test('SetNoteRequest shape', () => {
    const req: SetNoteRequest = {
      kind: 'set-note',
      sheetId: 'sheet-1',
      cell: { row: 1, col: 2 },
      note: { text: 'memo' },
    }
    expect(req.kind).toBe('set-note')
    expect(req.note.text).toBe('memo')
  })

  test('PostCommentRequest shape with optional threadId', () => {
    const req: PostCommentRequest = {
      kind: 'post-comment',
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      body: 'hello',
    }
    expect(req.threadId).toBeUndefined()

    const req2: PostCommentRequest = { ...req, threadId: 't1' }
    expect(req2.threadId).toBe('t1')
  })

  test('ResolveCommentThreadRequest shape', () => {
    const req: ResolveCommentThreadRequest = {
      kind: 'resolve-comment-thread',
      sheetId: 'sheet-1',
      threadId: 't1',
    }
    expect(req.kind).toBe('resolve-comment-thread')
  })

  test('DeleteCommentRequest shape', () => {
    const req: DeleteCommentRequest = {
      kind: 'delete-comment',
      sheetId: 'sheet-1',
      threadId: 't1',
      commentId: 'c1',
    }
    expect(req.commentId).toBe('c1')
  })

  test('ClearNoteRequest shape', () => {
    const req: ClearNoteRequest = {
      kind: 'clear-note',
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    }
    expect(req.kind).toBe('clear-note')
  })
})
