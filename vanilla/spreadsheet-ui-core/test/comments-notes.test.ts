import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  COMMENT_MUTATION_TIMEOUT_MS,
  closeCommentSessionAtom,
  commentEditorDraftAtom,
  commentIntentAtom,
  commentMutationBlockedAtom,
  commentMutationStateAtom,
  commentOperationAttemptLedgerAtom,
  commentRuntimeStatusAtom,
  commentSessionAtom,
  nextCommentRequestId,
  openCommentSessionAtom,
  runCommentMutationAtom,
  setCommentDraftAtom,
  type ClearNoteRequest,
  type DeleteCommentRequest,
  type DisplayCell,
  type PostCommentRequest,
  type ResolveCommentThreadRequest,
  type SetNoteRequest,
  type VisibleProjectionResult,
} from '../src'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushLaunch(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('comments-notes', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

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
    store.setter(setCommentDraftAtom, 'leftover')
    store.setter(openCommentSessionAtom, { sheetId: 'sheet-1', cell: { row: 0, col: 0 } })
    expect(store.getter(commentEditorDraftAtom)).toBe('')
  })

  test('openCommentSessionAtom carries threadId when provided', () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 1, col: 1 },
      threadId: 't1',
    })
    expect(store.getter(commentSessionAtom)?.threadId).toBe('t1')
  })

  test('setCommentDraftAtom updates draft', () => {
    const store = createStore()
    store.setter(setCommentDraftAtom, 'Hello')
    expect(store.getter(commentEditorDraftAtom)).toBe('Hello')
  })

  test('commentEditorDraftAtom rejects direct writes without changing the draft', () => {
    const store = createStore()
    store.setter(setCommentDraftAtom, 'command-owned')

    expect('write' in commentEditorDraftAtom).toBe(false)
    expect(() => Reflect.apply(store.setter, store, [commentEditorDraftAtom, 'forged'])).toThrow()
    expect(store.getter(commentEditorDraftAtom)).toBe('command-owned')
  })

  test('draft command invalidates launch capture and stays gated while pending or unknown', async () => {
    const store = createStore()
    const result = deferred<unknown>()
    let transportCalls = 0

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'initial')

    await store.setter(runCommentMutationAtom, {
      action: 'post',
      get source() {
        store.setter(setCommentDraftAtom, 'capture invalidated')
        return {
          postComment() {
            transportCalls += 1
            return result.promise
          },
        }
      },
    })

    expect(transportCalls).toBe(0)
    expect(store.getter(commentEditorDraftAtom)).toBe('capture invalidated')
    expect(store.getter(commentMutationStateAtom).phase).toBe('Idle')
    expect(store.getter(commentOperationAttemptLedgerAtom)).toEqual([])

    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: {
        postComment() {
          transportCalls += 1
          return result.promise
        },
      },
    })
    await flushLaunch()

    expect(transportCalls).toBe(1)
    expect(store.getter(commentMutationStateAtom).phase).toBe('PendingPublished')
    store.setter(setCommentDraftAtom, 'blocked while pending')
    expect(store.getter(commentEditorDraftAtom)).toBe('capture invalidated')

    result.reject(new Error('outcome uncertain'))
    await mutation
    expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked')

    store.setter(setCommentDraftAtom, 'blocked while unknown')
    expect(store.getter(commentEditorDraftAtom)).toBe('capture invalidated')
    expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked')
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

  test('request identities remain safe and non-repeating across the signed boundary', () => {
    expect(nextCommentRequestId(0)).toBe(1)
    expect(nextCommentRequestId(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(nextCommentRequestId(Number.MAX_SAFE_INTEGER)).toBe(-1)
    expect(nextCommentRequestId(-1)).toBe(-2)
    expect(nextCommentRequestId(Number.MIN_SAFE_INTEGER)).toBeNull()
    expect(nextCommentRequestId(Number.NaN)).toBeNull()
  })

  test('publishes pending state and ledger before invoking the selected port', async () => {
    const store = createStore()
    const result = deferred<unknown>()
    let calls = 0
    const capturedRequests: PostCommentRequest[] = []

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 4 },
      threadId: 'thread-1',
    })
    store.setter(setCommentDraftAtom, 'pending first')

    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: {
        postComment(request) {
          calls += 1
          capturedRequests.push(request)
          expect(store.getter(commentMutationStateAtom)).toMatchObject({
            phase: 'PendingPublished',
            action: 'post',
            requestId: request.requestId,
          })
          expect(store.getter(commentOperationAttemptLedgerAtom)).toEqual([
            expect.objectContaining({
              requestId: request.requestId,
              status: 'pending',
              sheetId: 'sheet-1',
              cell: { row: 2, col: 4 },
              threadId: 'thread-1',
            }),
          ])
          return result.promise
        },
      },
    })

    await flushLaunch()
    expect(calls).toBe(1)
    expect(capturedRequests).toHaveLength(1)
    const capturedRequest = capturedRequests[0]
    expect(capturedRequest).toMatchObject({
      kind: 'post-comment',
      sheetId: 'sheet-1',
      cell: { row: 2, col: 4 },
      threadId: 'thread-1',
      body: 'pending first',
      requestId: 1,
    })
    expect(Number.isSafeInteger(capturedRequest.requestId)).toBe(true)

    result.resolve({ sheetId: 'sheet-1', requestId: 1 })
    await mutation
    expect(store.getter(commentMutationStateAtom).phase).toBe('LocalAcknowledged')
    expect(store.getter(commentSessionAtom)).toBeNull()
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('local-acknowledged')
  })

  test('missing optional port blocks submission and preserves the open session and draft', async () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'keep me')

    await store.setter(runCommentMutationAtom, { action: 'post', source: {} })

    expect(store.getter(commentSessionAtom)).toEqual({
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
      threadId: undefined,
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('keep me')
    expect(store.getter(commentMutationStateAtom)).toMatchObject({
      phase: 'ErrorOpen',
      requestId: null,
    })
    expect(store.getter(commentOperationAttemptLedgerAtom)).toEqual([])
  })

  test.each([
    [
      'synchronous throw',
      () => {
        throw new Error('sync transport failed')
      },
    ],
    ['rejected promise', () => Promise.reject(new Error('async transport failed'))],
  ])('%s becomes an honest unknown and blocks retry', async (_label, postComment) => {
    const store = createStore()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'uncertain')

    await store.setter(runCommentMutationAtom, {
      action: 'post',
      source: { postComment },
    })

    expect(store.getter(commentSessionAtom)).not.toBeNull()
    expect(store.getter(commentEditorDraftAtom)).toBe('uncertain')
    expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked')
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('outcome-unknown')
  })

  test('a normal stalled transport reaches the Core deadline and preserves retry evidence', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const result = deferred<unknown>()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
    })
    store.setter(setCommentDraftAtom, 'keep this draft')

    const startedAt = Date.now()
    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: { postComment: () => result.promise },
    })
    await flushLaunch()

    expect(store.getter(commentMutationStateAtom).phase).toBe('PendingPublished')
    expect(store.getter(commentOperationAttemptLedgerAtom)[0]).toMatchObject({
      deadlineAt: startedAt + COMMENT_MUTATION_TIMEOUT_MS,
      status: 'pending',
    })

    jest.advanceTimersByTime(COMMENT_MUTATION_TIMEOUT_MS - 1)
    await flushLaunch()
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('pending')

    jest.advanceTimersByTime(1)
    await mutation

    expect(store.getter(commentSessionAtom)).toEqual({
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      threadId: undefined,
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('keep this draft')
    expect(store.getter(commentMutationStateAtom)).toMatchObject({
      phase: 'OutcomeUnknownBlocked',
      error: expect.stringContaining('Core deadline'),
    })
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
    expect(store.getter(commentOperationAttemptLedgerAtom)[0]).toMatchObject({
      deadlineAt: startedAt + COMMENT_MUTATION_TIMEOUT_MS,
      status: 'outcome-unknown',
      error: expect.stringContaining('Core deadline'),
    })
  })

  test('a late fulfilment cannot acknowledge or double-settle a timed-out ticket', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const result = deferred<unknown>()
    let requestId: number | undefined
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'uncertain draft')

    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: {
        postComment(request) {
          requestId = request.requestId
          return result.promise
        },
      },
    })
    await flushLaunch()
    jest.advanceTimersByTime(COMMENT_MUTATION_TIMEOUT_MS)
    await mutation
    const timedOutAttempt = store.getter(commentOperationAttemptLedgerAtom)[0]

    result.resolve({ sheetId: 'sheet-1', requestId })
    await flushLaunch()

    expect(store.getter(commentOperationAttemptLedgerAtom)[0]).toBe(timedOutAttempt)
    expect(timedOutAttempt.status).toBe('outcome-unknown')
    expect(timedOutAttempt.resultRevision).toBeUndefined()
    expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked')
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
    expect(store.getter(commentEditorDraftAtom)).toBe('uncertain draft')
  })

  test('timeout settles the old ticket without overwriting a reopened session, and late reject is ignored', async () => {
    jest.useFakeTimers()
    const store = createStore()
    const result = deferred<unknown>()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-old',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'old draft')
    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: { postComment: () => result.promise },
    })
    await flushLaunch()

    store.setter(closeCommentSessionAtom)
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-new',
      cell: { row: 4, col: 5 },
    })
    store.setter(setCommentDraftAtom, 'new draft')
    jest.advanceTimersByTime(COMMENT_MUTATION_TIMEOUT_MS)
    await mutation
    const timedOutAttempt = store.getter(commentOperationAttemptLedgerAtom)[0]

    expect(store.getter(commentSessionAtom)).toEqual({
      sheetId: 'sheet-new',
      cell: { row: 4, col: 5 },
      threadId: undefined,
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('new draft')
    expect(store.getter(commentMutationStateAtom).phase).toBe('Idle')
    expect(store.getter(commentRuntimeStatusAtom)).toBe('OpenDirty')
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
    expect(timedOutAttempt.status).toBe('outcome-unknown')

    result.reject(new Error('late reject after timeout'))
    await flushLaunch()

    expect(store.getter(commentOperationAttemptLedgerAtom)[0]).toBe(timedOutAttempt)
    expect(store.getter(commentSessionAtom)?.sheetId).toBe('sheet-new')
    expect(store.getter(commentEditorDraftAtom)).toBe('new draft')
    expect(store.getter(commentMutationStateAtom).phase).toBe('Idle')
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
  })

  test('an unknown outcome retains its ticket and suppresses later transport calls', async () => {
    const store = createStore()
    let calls = 0
    const source = {
      async postComment(request: PostCommentRequest) {
        calls += 1
        return { sheetId: request.sheetId, requestId: (request.requestId ?? 0) + 1 }
      },
    }
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'dispatch once')

    await store.setter(runCommentMutationAtom, { action: 'post', source })
    await store.setter(runCommentMutationAtom, { action: 'post', source })

    expect(calls).toBe(1)
    expect(store.getter(commentOperationAttemptLedgerAtom)).toEqual([
      expect.objectContaining({ requestId: 1, status: 'outcome-unknown' }),
    ])
  })

  test.each([
    ['missing request id', (request: PostCommentRequest) => ({ sheetId: request.sheetId })],
    [
      'mismatched request id',
      (request: PostCommentRequest) => ({
        sheetId: request.sheetId,
        requestId: (request.requestId ?? 0) + 1,
      }),
    ],
    [
      'unsafe request id',
      (request: PostCommentRequest) => ({ sheetId: request.sheetId, requestId: 1.5 }),
    ],
    [
      'mismatched sheet',
      (request: PostCommentRequest) => ({ sheetId: 'other-sheet', requestId: request.requestId }),
    ],
    [
      'mismatched affected cell',
      (request: PostCommentRequest) => ({
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      }),
    ],
  ])('%s acknowledgement is never promoted to local success', async (_label, response) => {
    const store = createStore()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'strict acknowledgement')

    await store.setter(runCommentMutationAtom, {
      action: 'post',
      source: { postComment: async (request) => response(request) },
    })

    expect(store.getter(commentMutationStateAtom).phase).toBe('OutcomeUnknownBlocked')
    expect(store.getter(commentSessionAtom)).not.toBeNull()
    expect(store.getter(commentEditorDraftAtom)).toBe('strict acknowledgement')
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('outcome-unknown')
  })

  test('an exact optional affectedRange is accepted as ticket-bound local evidence', async () => {
    const store = createStore()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 3, col: 7 },
      threadId: 'thread-1',
    })

    await store.setter(runCommentMutationAtom, {
      action: 'resolve',
      source: {
        async resolveCommentThread(request) {
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: { rowStart: 3, rowEnd: 3, colStart: 7, colEnd: 7 },
          }
        },
      },
    })

    expect(store.getter(commentMutationStateAtom).phase).toBe('LocalAcknowledged')
    expect(store.getter(commentSessionAtom)).toBeNull()
    expect(store.getter(commentEditorDraftAtom)).toBe('')
    expect(store.getter(commentOperationAttemptLedgerAtom)[0]).toMatchObject({
      action: 'resolve',
      threadId: 'thread-1',
      status: 'local-acknowledged',
    })
  })

  test('same-tick double submission dispatches only one immutable ticket', async () => {
    const store = createStore()
    const result = deferred<unknown>()
    const requests: PostCommentRequest[] = []
    const source = {
      postComment(request: PostCommentRequest) {
        requests.push(request)
        return result.promise
      },
    }
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-1',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'once')

    const first = store.setter(runCommentMutationAtom, { action: 'post', source })
    const second = store.setter(runCommentMutationAtom, { action: 'post', source })
    await flushLaunch()

    expect(requests).toHaveLength(1)
    expect(store.getter(commentOperationAttemptLedgerAtom)).toHaveLength(1)
    result.resolve({ sheetId: 'sheet-1', requestId: requests[0].requestId })
    await Promise.all([first, second])
  })

  test('late exact settlement records old ledger evidence without closing a reopened session', async () => {
    const store = createStore()
    const result = deferred<unknown>()
    let requestId: number | undefined
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-old',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'old draft')
    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: {
        postComment(request) {
          requestId = request.requestId
          return result.promise
        },
      },
    })
    await flushLaunch()

    store.setter(closeCommentSessionAtom)
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-new',
      cell: { row: 4, col: 5 },
    })
    store.setter(setCommentDraftAtom, 'new draft')
    result.resolve({ sheetId: 'sheet-old', requestId })
    await mutation

    expect(store.getter(commentSessionAtom)).toEqual({
      sheetId: 'sheet-new',
      cell: { row: 4, col: 5 },
      threadId: undefined,
    })
    expect(store.getter(commentEditorDraftAtom)).toBe('new draft')
    expect(store.getter(commentMutationStateAtom).phase).toBe('Idle')
    expect(store.getter(commentRuntimeStatusAtom)).toBe('OpenDirty')
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('local-acknowledged')
  })

  test('late rejected settlement blocks globally but does not overwrite a reopened session', async () => {
    const store = createStore()
    const result = deferred<unknown>()
    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-old',
      cell: { row: 0, col: 0 },
    })
    store.setter(setCommentDraftAtom, 'old draft')
    const mutation = store.setter(runCommentMutationAtom, {
      action: 'post',
      source: { postComment: () => result.promise },
    })
    await flushLaunch()

    store.setter(openCommentSessionAtom, {
      sheetId: 'sheet-new',
      cell: { row: 1, col: 1 },
    })
    store.setter(setCommentDraftAtom, 'new draft')
    result.reject(new Error('late reject'))
    await mutation

    expect(store.getter(commentSessionAtom)?.sheetId).toBe('sheet-new')
    expect(store.getter(commentEditorDraftAtom)).toBe('new draft')
    expect(store.getter(commentMutationStateAtom).phase).toBe('Idle')
    expect(store.getter(commentMutationBlockedAtom)).toBe(true)
    expect(store.getter(commentOperationAttemptLedgerAtom)[0].status).toBe('outcome-unknown')
  })

  test('operation state and request identities are isolated per Einfach store', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    for (const store of [firstStore, secondStore]) {
      store.setter(openCommentSessionAtom, {
        sheetId: 'sheet-1',
        cell: { row: 0, col: 0 },
      })
      store.setter(setCommentDraftAtom, 'isolated')
      await store.setter(runCommentMutationAtom, {
        action: 'post',
        source: {
          async postComment(request) {
            return { sheetId: request.sheetId, requestId: request.requestId }
          },
        },
      })
    }

    expect(firstStore.getter(commentOperationAttemptLedgerAtom)[0].requestId).toBe(1)
    expect(secondStore.getter(commentOperationAttemptLedgerAtom)[0].requestId).toBe(1)
    expect(firstStore.getter(commentOperationAttemptLedgerAtom)).not.toBe(
      secondStore.getter(commentOperationAttemptLedgerAtom),
    )
  })

  test('the bounded journal evicts only old locally acknowledged evidence', async () => {
    const store = createStore()
    const source = {
      async postComment(request: PostCommentRequest) {
        return { sheetId: request.sheetId, requestId: request.requestId }
      },
    }

    for (let index = 1; index <= 33; index += 1) {
      store.setter(openCommentSessionAtom, {
        sheetId: 'sheet-1',
        cell: { row: index, col: 0 },
      })
      store.setter(setCommentDraftAtom, `comment ${index}`)
      await store.setter(runCommentMutationAtom, { action: 'post', source })
    }

    const ledger = store.getter(commentOperationAttemptLedgerAtom)
    expect(ledger).toHaveLength(32)
    expect(ledger.map((attempt) => attempt.requestId)).toEqual(
      Array.from({ length: 32 }, (_value, index) => index + 2),
    )
    expect(ledger.every((attempt) => attempt.status === 'local-acknowledged')).toBe(true)
  })
})
