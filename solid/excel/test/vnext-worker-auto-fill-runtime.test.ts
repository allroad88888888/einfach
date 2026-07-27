/**
 * @jest-environment node
 *
 * AutoFill owns a private typed Error witness at the WASM boundary. Drive the
 * real worker dispatcher with a mocked workbook to pin which thrown values may
 * cross the RPC boundary as AUTO_FILL_REJECTED.
 */

import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals'

const mockApplyAutoFill = jest.fn()
const mockWorkbook = {
  apply_auto_fill: (request: unknown) => mockApplyAutoFill(request),
  drainAsyncCustomRequests: () => [],
}

jest.mock('../wasm-pkg/einfach_wasm.js', () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
  WasmWorkbook: jest.fn(() => mockWorkbook),
}))

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

type WorkerListener = (event: { data: unknown }) => void | Promise<void>

const workerListeners: WorkerListener[] = []
const posted: WorkerResponse[] = []
let successPostFailure: Error | null = null

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).self = {
    addEventListener(_type: string, listener: WorkerListener) {
      workerListeners.push(listener)
    },
    postMessage(message: WorkerResponse) {
      if (message.ok && successPostFailure !== null) {
        const error = successPostFailure
        successPostFailure = null
        throw error
      }
      posted.push(message)
    },
  }
  await import('../src-vnext/adapter/worker-runtime')
})

beforeEach(() => {
  posted.length = 0
  successPostFailure = null
  mockApplyAutoFill.mockReset()
})

async function dispatchAutoFill(id: number): Promise<WorkerResponse> {
  const event = {
    data: {
      id,
      cmd: 'applyAutoFill',
      request: {
        sheet: 0,
        sourceRange: { startRow: 0, startCol: 0, endRow: 1, endCol: 0 },
        targetRange: { startRow: 0, startCol: 0, endRow: 2, endCol: 0 },
        direction: 'down',
        series: 'copy',
      },
    },
  }
  await Promise.all(workerListeners.map((listener) => listener(event)))
  const response = posted.find((candidate) => candidate.id === id)
  if (!response) throw new Error(`missing worker response for id=${id}`)
  return response
}

function nativeAutoFillRejection(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'EinfachAutoFillRejected',
    code: 'AUTO_FILL_REJECTED',
  })
}

describe('worker runtime AutoFill rejection witness', () => {
  test('forwards only the complete native Error witness as semantic rejection', async () => {
    mockApplyAutoFill.mockImplementation(() => {
      throw nativeAutoFillRejection('source values do not define the requested series')
    })

    await expect(dispatchAutoFill(1)).resolves.toEqual({
      id: 1,
      ok: false,
      error: {
        code: 'AUTO_FILL_REJECTED',
        message: 'source values do not define the requested series',
      },
    })
  })

  test.each([
    ['bare string', 'AUTO_FILL_REJECTED'],
    [
      'plain object',
      {
        name: 'EinfachAutoFillRejected',
        code: 'AUTO_FILL_REJECTED',
        message: 'object spoof',
      },
    ],
    [
      'partial Error',
      Object.assign(new Error('code-only spoof'), {
        code: 'AUTO_FILL_REJECTED',
      }),
    ],
    [
      'wrong code',
      Object.assign(new Error('wrong-code spoof'), {
        name: 'EinfachAutoFillRejected',
        code: 'NOT_NATIVE',
      }),
    ],
  ])('%s cannot impersonate the private rejection witness', async (_label, thrown) => {
    mockApplyAutoFill.mockImplementation(() => {
      throw thrown
    })

    const response = await dispatchAutoFill(2)
    expect(response).toMatchObject({ id: 2, ok: false })
    if (response.ok) throw new Error('expected a worker rejection')
    expect(response.error.code).not.toBe('AUTO_FILL_REJECTED')
  })

  test('an inherited code property does not qualify as the native witness', async () => {
    const rejectionPrototype = Object.create(Error.prototype) as Error & {
      code: string
    }
    rejectionPrototype.code = 'AUTO_FILL_REJECTED'
    const spoof = new Error('inherited-code spoof')
    spoof.name = 'EinfachAutoFillRejected'
    Object.setPrototypeOf(spoof, rejectionPrototype)
    mockApplyAutoFill.mockImplementation(() => {
      throw spoof
    })

    await expect(dispatchAutoFill(3)).resolves.toMatchObject({
      id: 3,
      ok: false,
      error: { code: 'WORKER_ERROR' },
    })
  })

  test('response transport failure stays generic after the native call returned', async () => {
    mockApplyAutoFill.mockReturnValue({
      writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
      written: 1,
    })
    successPostFailure = Object.assign(new Error('postMessage failed after commit'), {
      code: 'AUTO_FILL_REJECTED',
    })

    await expect(dispatchAutoFill(4)).resolves.toEqual({
      id: 4,
      ok: false,
      error: {
        code: 'WORKER_ERROR',
        message: 'postMessage failed after commit',
      },
    })
  })
})
