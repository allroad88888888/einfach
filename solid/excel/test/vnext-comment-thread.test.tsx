/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  PostCommentRequest,
  ResolveCommentThreadRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  RangeProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  commentSessionAtom,
  commentEditorDraftAtom,
  openCommentSessionAtom,
  setCommentDraftAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetCommentThread } from '../src-vnext/comments'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(() => {
  cleanup()
})

function createFakeBackend() {
  const postCommentRequests: PostCommentRequest[] = []
  const resolveThreadRequests: ResolveCommentThreadRequest[] = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request: VisibleProjectionRequest) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        window: request.window,
        cells: [],
      }
    },
    async readRangeProjection(request: RangeProjectionRequest) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        range: request.range,
        cells: [],
      }
    },
    async setCellInput(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
      }
    },
    async postComment(request) {
      postCommentRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
    async resolveCommentThread(request) {
      resolveThreadRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId }
    },
  }

  return { backend, postCommentRequests, resolveThreadRequests }
}

describe('SpreadsheetCommentThread', () => {
  it('does not render when session is null', () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('comment-thread')).toBeNull()
  })

  it('renders when session is active', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    const thread = await waitFor(() => getByTestId('comment-thread'))
    expect(thread).toBeTruthy()
    expect(getByTestId('comment-thread-cell').textContent).toContain('sheet-1')
    expect(getByTestId('comment-thread-cell').textContent).toContain('D3')
  })

  it('Post button calls backend.postComment with draft text and closes session', async () => {
    const store = createStore()
    const { backend, postCommentRequests } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'Hello world')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('comment-post-button'))

    await waitFor(() => expect(postCommentRequests).toHaveLength(1))
    expect(postCommentRequests[0]).toMatchObject({
      kind: 'post-comment',
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      body: 'Hello world',
    })
    await waitFor(() => expect(store.getter(commentSessionAtom)).toBeNull())
  })

  it('Close button closes the session without calling postComment', async () => {
    const store = createStore()
    const { backend, postCommentRequests } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 1, col: 1 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('comment-close-button'))

    await waitFor(() => expect(store.getter(commentSessionAtom)).toBeNull())
    expect(postCommentRequests).toHaveLength(0)
  })

  it('textarea is bound to draft atom', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-2',
      cell: { row: 0, col: 0 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    const textarea = getByTestId('comment-thread-textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: 'My comment' } })

    await waitFor(() => expect(store.getter(commentEditorDraftAtom)).toBe('My comment'))
  })

  it('Resolve button visible with threadId, calls resolveCommentThread', async () => {
    const store = createStore()
    const { backend, resolveThreadRequests } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      threadId: 'thread-abc',
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    const resolveBtn = await waitFor(() => getByTestId('comment-resolve-button'))
    fireEvent.click(resolveBtn)

    await waitFor(() => expect(resolveThreadRequests).toHaveLength(1))
    expect(resolveThreadRequests[0]).toMatchObject({
      kind: 'resolve-comment-thread',
      sheetId: 'sheet-1',
      threadId: 'thread-abc',
    })
  })

  it('Resolve button not shown when no threadId', async () => {
    const store = createStore()
    const { backend } = createFakeBackend()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(queryByTestId('comment-thread')).toBeTruthy())
    expect(queryByTestId('comment-resolve-button')).toBeNull()
  })
})
