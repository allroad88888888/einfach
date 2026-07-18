import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  FORMAT_PAINTER_LEDGER_MAX,
  applyFormatPainterAtom,
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  exitFormatPainterAtom,
  formatPainterBlockedAtom,
  formatPainterClipboardAtom,
  formatPainterControllerAtom,
  formatPainterLedgerAtom,
  formatPainterPendingAtom,
  formatPainterStateAtom,
  syncFormatPainterContextAtom,
  type ApplyFormatPainterInput,
  type CapturedFormat,
} from '../src/format-painter'
import { setSelectionAtom } from '../src/selection'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'

const SOURCE = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }
const TARGET = { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function sampleFormat(): CapturedFormat {
  return {
    format: {
      bold: true,
      italic: false,
      align: 'right',
      fontSize: 14,
      fgColor: '#112233',
      bgColor: '#ffeecc',
      numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
      borders: { top: { style: 'thin', color: '#000000' } },
    },
    conditionalFormat: { bgColor: '#ff0000' },
  }
}

function selectRange(
  store: ReturnType<typeof createStore>,
  range: typeof SOURCE,
  sheetId = 'sheet-1',
): void {
  store.setter(setSelectionAtom, {
    kind: 'range',
    sheetId,
    anchor: { row: range.rowStart, col: range.colStart },
    focus: { row: range.rowEnd, col: range.colEnd },
  })
}

function prepare(mode: 'armed' | 'sticky' = 'armed', captured: CapturedFormat = sampleFormat()) {
  const store = createStore()
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  selectRange(store, SOURCE)
  store.setter(mode === 'armed' ? armFormatPainterAtom : armFormatPainterStickyAtom, captured)
  selectRange(store, TARGET)
  return store
}

function successfulPorts(
  overrides: Partial<ApplyFormatPainterInput> = {},
): ApplyFormatPainterInput {
  return {
    resolveTargetRanges: (_sheetId, range) => [range],
    setFormatRange: (request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }),
    refreshProjection: () => undefined,
    ...overrides,
  }
}

describe('format-painter Core authority and mutation lifecycle', () => {
  test('starts idle and arms from Core-owned selection/workspace authority', () => {
    const store = prepare()
    const controller = store.getter(formatPainterControllerAtom)

    expect(controller.state).toBe('armed')
    expect(controller.source).toEqual({ sheetId: 'sheet-1', range: SOURCE })
    expect(controller.sessionId).toBe(1)
    expect(controller.phase).toBe('ready')
    expect(store.getter(formatPainterPendingAtom)).toBe(false)
  })

  test('deep-snapshots and freezes base/compatibility evidence without aliasing caller data', () => {
    const captured = sampleFormat()
    const store = prepare('armed', captured)
    const clipboard = store.getter(formatPainterClipboardAtom)!

    captured.format.bold = false
    if (captured.format.borders?.top) captured.format.borders.top.color = '#fff'
    if (captured.conditionalFormat) captured.conditionalFormat.bgColor = '#000'

    expect(clipboard.format.bold).toBe(true)
    expect(clipboard.format.borders?.top?.color).toBe('#000000')
    expect(clipboard.conditionalFormat?.bgColor).toBe('#ff0000')
    expect(Object.isFrozen(clipboard)).toBe(true)
    expect(Object.isFrozen(clipboard.format)).toBe(true)
    expect(Object.isFrozen(clipboard.format.borders?.top)).toBe(true)
  })

  test('keeps session/request identities strict, unique, and isolated per store', async () => {
    const first = prepare('sticky')
    const second = prepare('sticky')
    const firstRequestIds: number[] = []
    const secondRequestIds: number[] = []

    await first.setter(
      applyFormatPainterAtom,
      successfulPorts({
        setFormatRange: (request) => {
          firstRequestIds.push(request.requestId!)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: request.range,
          }
        },
      }),
    )
    await second.setter(
      applyFormatPainterAtom,
      successfulPorts({
        setFormatRange: (request) => {
          secondRequestIds.push(request.requestId!)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: request.range,
          }
        },
      }),
    )
    selectRange(first, { rowStart: 6, rowEnd: 6, colStart: 6, colEnd: 6 })
    await first.setter(
      applyFormatPainterAtom,
      successfulPorts({
        setFormatRange: (request) => {
          firstRequestIds.push(request.requestId!)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: request.range,
          }
        },
      }),
    )

    expect(firstRequestIds).toEqual([1, 2])
    expect(secondRequestIds).toEqual([1])
    expect(firstRequestIds.every(Number.isSafeInteger)).toBe(true)
  })

  test('blocks before transport when any port is missing and retains armed state', async () => {
    const store = prepare()
    const setFormatRange = jest.fn()

    const result = await store.setter(applyFormatPainterAtom, {
      resolveTargetRanges: (_sheetId, range) => [range],
      setFormatRange,
    })

    expect(result).toBe('preflight-failed')
    expect(setFormatRange).not.toHaveBeenCalled()
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
    expect(store.getter(formatPainterLedgerAtom)).toHaveLength(0)
    expect(store.getter(formatPainterBlockedAtom)).toBe(false)
  })

  test.each([{ ranges: [] }, { ranges: [TARGET, { ...TARGET, rowStart: 7, rowEnd: 7 }] }])(
    'rejects zero or multiple backing ranges before the first mutation call',
    async ({ ranges }) => {
      const store = prepare()
      const setFormatRange = jest.fn()

      const result = await store.setter(
        applyFormatPainterAtom,
        successfulPorts({ resolveTargetRanges: () => ranges, setFormatRange }),
      )

      expect(result).toBe('preflight-failed')
      expect(setFormatRange).not.toHaveBeenCalled()
      expect(store.getter(formatPainterLedgerAtom)).toHaveLength(0)
      expect(store.getter(formatPainterStateAtom)).toBe('armed')
    },
  )

  test('uses only the frozen base format, accepts an exact receipt, refreshes, then exits armed', async () => {
    const store = prepare()
    const setFormatRange = jest.fn((request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    const refreshProjection = jest.fn()

    const result = await store.setter(
      applyFormatPainterAtom,
      successfulPorts({ setFormatRange, refreshProjection }),
    )

    expect(result).toBe('local-acknowledged')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(setFormatRange.mock.calls[0][0]).toMatchObject({
      kind: 'set-format-range',
      sheetId: 'sheet-1',
      range: TARGET,
      requestId: 1,
      format: { bold: true },
    })
    expect(setFormatRange.mock.calls[0][0]).not.toHaveProperty('conditionalFormat')
    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
    expect(store.getter(formatPainterLedgerAtom)[0].status).toBe('local-acknowledged')
  })

  test('sticky mode stays armed after exact acknowledgement and suppresses the same target', async () => {
    const store = prepare('sticky')
    const setFormatRange = jest.fn((request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    const ports = successfulPorts({ setFormatRange })

    expect(await store.setter(applyFormatPainterAtom, ports)).toBe('local-acknowledged')
    expect(await store.setter(applyFormatPainterAtom, ports)).toBe('blocked')
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
  })

  test.each([
    ['mismatched receipt', async () => ({ sheetId: 'wrong', requestId: 1, affectedRange: TARGET })],
    ['rejection', async () => Promise.reject(new Error('backend rejected'))],
    [
      'synchronous throw',
      () => {
        throw new Error('transport throw')
      },
    ],
  ])('enters outcome-unknown after the first port call on %s', async (_name, port) => {
    const store = prepare()
    const setFormatRange = jest.fn(port)

    expect(await store.setter(applyFormatPainterAtom, successfulPorts({ setFormatRange }))).toBe(
      'outcome-unknown',
    )
    expect(setFormatRange).toHaveBeenCalledTimes(1)
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
    expect(store.getter(formatPainterBlockedAtom)).toBe(true)
    expect(store.getter(formatPainterLedgerAtom)[0].status).toBe('outcome-unknown')
    expect(await store.setter(applyFormatPainterAtom, successfulPorts())).toBe('blocked')
  })

  test('blocks duplicate dispatch while pending', async () => {
    const store = prepare()
    const transport = deferred<unknown>()
    const setFormatRange = jest.fn(() => transport.promise)
    const first = store.setter(
      applyFormatPainterAtom,
      successfulPorts({ setFormatRange, timeoutMs: 1_000 }),
    )

    await Promise.resolve()
    expect(store.getter(formatPainterPendingAtom)).toBe(true)
    expect(await store.setter(applyFormatPainterAtom, successfulPorts())).toBe('blocked')
    expect(setFormatRange).toHaveBeenCalledTimes(1)

    const request = setFormatRange.mock.calls[0][0]
    transport.resolve({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    })
    expect(await first).toBe('local-acknowledged')
  })

  test('timeout stays unknown; late exact settlement records evidence only', async () => {
    const store = prepare()
    const transport = deferred<unknown>()
    let request: Parameters<NonNullable<ApplyFormatPainterInput['setFormatRange']>>[0] | null = null

    expect(
      await store.setter(
        applyFormatPainterAtom,
        successfulPorts({
          timeoutMs: 1,
          setFormatRange: (nextRequest) => {
            request = nextRequest
            return transport.promise
          },
        }),
      ),
    ).toBe('outcome-unknown')

    transport.resolve({
      sheetId: request!.sheetId,
      requestId: request!.requestId,
      affectedRange: request!.range,
    })
    await Promise.resolve()
    await Promise.resolve()

    const attempt = store.getter(formatPainterLedgerAtom)[0]
    expect(attempt.status).toBe('outcome-unknown')
    expect(attempt.lateEvidence).toBe('late-exact-acknowledgement')
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    expect(store.getter(formatPainterBlockedAtom)).toBe(true)
  })

  test('exit/re-arm tombstones pending UI authority; late exact ack only updates old ledger', async () => {
    const store = prepare()
    const transport = deferred<unknown>()
    let request: Parameters<NonNullable<ApplyFormatPainterInput['setFormatRange']>>[0] | null = null
    const running = store.setter(
      applyFormatPainterAtom,
      successfulPorts({
        setFormatRange: (nextRequest) => {
          request = nextRequest
          return transport.promise
        },
      }),
    )
    await Promise.resolve()

    store.setter(exitFormatPainterAtom)
    selectRange(store, SOURCE)
    store.setter(armFormatPainterStickyAtom, { format: { italic: true } })
    const newSession = store.getter(formatPainterControllerAtom).sessionId
    selectRange(store, TARGET)
    transport.resolve({
      sheetId: request!.sheetId,
      requestId: request!.requestId,
      affectedRange: request!.range,
    })

    expect(await running).toBe('stale')
    expect(store.getter(formatPainterControllerAtom).sessionId).toBe(newSession)
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)?.format.italic).toBe(true)
    expect(store.getter(formatPainterLedgerAtom)[0].status).toBe('local-acknowledged')
  })

  test('refresh runs only after exact ack; refresh failure reports honest local projection unknown', async () => {
    const store = prepare()
    const refreshProjection = jest.fn(async () => Promise.reject(new Error('refresh failed')))

    expect(await store.setter(applyFormatPainterAtom, successfulPorts({ refreshProjection }))).toBe(
      'honest-local-projection-unknown',
    )

    expect(refreshProjection).toHaveBeenCalledTimes(1)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
    expect(store.getter(formatPainterControllerAtom).phase).toBe('honest-local-projection-unknown')
    expect(store.getter(formatPainterLedgerAtom)[0].status).toBe('honest-local-projection-unknown')
  })

  test('workspace drift is tombstoned by the Core sync command', () => {
    const store = prepare('sticky')
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })

    expect(store.setter(syncFormatPainterContextAtom)).toBe(true)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  test('bounds the attempt ledger by evicting acknowledged evidence only', async () => {
    const store = prepare('sticky')
    for (let index = 0; index < FORMAT_PAINTER_LEDGER_MAX + 3; index += 1) {
      selectRange(store, {
        rowStart: index + 2,
        rowEnd: index + 2,
        colStart: index + 3,
        colEnd: index + 3,
      })
      expect(await store.setter(applyFormatPainterAtom, successfulPorts())).toBe(
        'local-acknowledged',
      )
    }

    const ledger = store.getter(formatPainterLedgerAtom)
    expect(ledger).toHaveLength(FORMAT_PAINTER_LEDGER_MAX)
    expect(ledger.every((attempt) => attempt.status === 'local-acknowledged')).toBe(true)
    expect(ledger[0].requestId).toBe(4)
  })
})
