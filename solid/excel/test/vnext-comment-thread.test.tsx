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
  commentEditorDraftAtom,
  commentMutationStateAtom,
  commentSessionAtom,
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

  it('publishes pending before the port, disables duplicate submission, then accepts exact local evidence', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const gate = deferred<{ sheetId: string; requestId: number }>()
    const requests: PostCommentRequest[] = []
    let phaseAtPort: string | null = null
    const backend: SpreadsheetBackend = {
      ...baseBackend,
      postComment(request) {
        phaseAtPort = store.getter(commentMutationStateAtom).phase
        requests.push(request)
        return gate.promise
      },
    }

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-pending',
      cell: { row: 3, col: 4 },
    })
    store.setter(setCommentDraftAtom, 'Pending body')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    const postButton = getByTestId('comment-post-button') as HTMLButtonElement
    fireEvent.click(postButton)
    fireEvent.click(postButton)

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(phaseAtPort).toBe('PendingPublished')
    expect(postButton.disabled).toBe(true)
    expect((getByTestId('comment-thread-textarea') as HTMLTextAreaElement).disabled).toBe(true)

    const request = requests[0]
    expect(request.requestId).toEqual(expect.any(Number))
    gate.resolve({ sheetId: request.sheetId, requestId: request.requestId! })

    await waitFor(() => expect(store.getter(commentSessionAtom)).toBeNull())
    expect(store.getter(commentMutationStateAtom).phase).toBe('LocalAcknowledged')
  })

  it('shows a pre-dispatch missing-port error without discarding the session or draft', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const backend: SpreadsheetBackend = { ...baseBackend, postComment: undefined }

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-no-port',
      cell: { row: 4, col: 5 },
    })
    store.setter(setCommentDraftAtom, 'Keep this draft')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('comment-post-button'))

    await waitFor(() => expect(getByTestId('comment-mutation-error')).toBeTruthy())
    expect(store.getter(commentMutationStateAtom).phase).toBe('ErrorOpen')
    expect(store.getter(commentSessionAtom)).toMatchObject({
      sheetId: 'sheet-no-port',
      cell: { row: 4, col: 5 },
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('Keep this draft')
  })

  it('keeps a rejected dispatch open, reports unknown outcome, and blocks retry', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const backend: SpreadsheetBackend = {
      ...baseBackend,
      postComment() {
        return Promise.reject(new Error('offline'))
      },
    }

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-reject',
      cell: { row: 6, col: 7 },
    })
    store.setter(setCommentDraftAtom, 'Uncertain body')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    const postButton = getByTestId('comment-post-button') as HTMLButtonElement
    fireEvent.click(postButton)

    await waitFor(() =>
      expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked'),
    )
    expect(getByTestId('comment-mutation-error')).toBeTruthy()
    expect(postButton.disabled).toBe(true)
    expect(store.getter(commentSessionAtom)?.sheetId).toBe('sheet-reject')
    expect(store.getter(commentEditorDraftAtom)).toBe('Uncertain body')
  })

  it('treats a mismatched acknowledgement as unknown instead of closing the editor', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const backend: SpreadsheetBackend = {
      ...baseBackend,
      async postComment(request) {
        return { sheetId: request.sheetId, requestId: request.requestId! + 1 }
      },
    }

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-mismatch',
      cell: { row: 8, col: 9 },
    })
    store.setter(setCommentDraftAtom, 'Do not lose me')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('comment-post-button'))

    await waitFor(() =>
      expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked'),
    )
    expect(getByTestId('comment-mutation-error')).toBeTruthy()
    expect(store.getter(commentSessionAtom)?.sheetId).toBe('sheet-mismatch')
    expect(store.getter(commentEditorDraftAtom)).toBe('Do not lose me')
  })

  it('does not let a late acknowledgement close or overwrite a reopened session', async () => {
    const store = createStore()
    const { backend: baseBackend } = createFakeBackend()
    const gate = deferred<{ sheetId: string; requestId: number }>()
    let request: PostCommentRequest | null = null
    const backend: SpreadsheetBackend = {
      ...baseBackend,
      postComment(nextRequest) {
        request = nextRequest
        return gate.promise
      },
    }

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-old',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'Old draft')

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetCommentThread />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('comment-post-button'))
    await waitFor(() => expect(request).not.toBeNull())
    fireEvent.click(getByTestId('comment-close-button'))
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-new',
      cell: { row: 10, col: 11 },
    })
    store.setter(setCommentDraftAtom, 'New draft')

    const oldRequest = request!
    gate.resolve({ sheetId: oldRequest.sheetId, requestId: oldRequest.requestId! })

    await waitFor(() => expect(store.getter(commentMutationStateAtom).phase).toBe('Idle'))
    expect(store.getter(commentSessionAtom)).toMatchObject({
      sheetId: 'sheet-new',
      cell: { row: 10, col: 11 },
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('New draft')
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

    const { getByTestId, queryByTestId } = render(() => (
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
    await waitFor(() =>
      expect(store.getter(commentMutationStateAtom).phase).toBe('LocalAcknowledged'),
    )
    expect(store.getter(commentSessionAtom)).toBeNull()
    expect(queryByTestId('comment-thread')).toBeNull()
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
