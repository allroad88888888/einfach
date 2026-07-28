import { describe, expect, it, jest } from '@jest/globals'
import type { ImportCellWire } from '../src/wasm-workbook-proxy'
import { TextDecoder } from 'util'
import {
  detectDelimiter,
  importDelimitedFileToWorkbook,
  parseDelimitedLine,
} from '../src/file-import'

if (!globalThis.TextDecoder) {
  globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder
}

function makeTextBlob(text: string, name: string): Blob & { name: string } {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  const stream = () => ({
    getReader() {
      let drained = false
      return {
        async read() {
          if (drained) return { done: true, value: undefined }
          drained = true
          return { done: false, value: bytes }
        },
      }
    },
  })
  return { name, stream } as Blob & { name: string }
}

function makeChunkedTextBlob(chunks: string[], name: string) {
  const state = { readCalls: 0 }
  const bytes = chunks.map((chunk) => {
    const out = new Uint8Array(chunk.length)
    for (let i = 0; i < chunk.length; i++) out[i] = chunk.charCodeAt(i)
    return out
  })
  const stream = () => ({
    getReader() {
      let index = 0
      return {
        async read() {
          state.readCalls += 1
          if (index >= bytes.length) return { done: true, value: undefined }
          const value = bytes[index]
          index += 1
          return { done: false, value }
        },
        // No-op stub: the fake reader has nothing to release on cancel.
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        async cancel() {},
      }
    },
  })
  return {
    blob: { name, stream } as Blob & { name: string },
    state,
  }
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeFakeClient() {
  const calls = {
    beginImport: [] as number[],
    importChunk: [] as Array<{ sessionId: number; cells: ImportCellWire[] }>,
    commitImport: [] as number[],
    cancelImport: [] as number[],
  }

  const client = {
    beginImport: jest.fn(() => {
      calls.beginImport.push(1)
      return 1
    }),
    importChunk: jest.fn(async (_sessionId: number, cells: ImportCellWire[]) => {
      calls.importChunk.push({ sessionId: _sessionId, cells: [...cells] })
      return cells.length
    }),
    commitImport: jest.fn(async () => {
      calls.commitImport.push(1)
      return {
        accepted: 0,
        formulas: 0,
        rejectedFormulas: 0,
        cleared: 0,
        errors: 0,
      }
    }),
    cancelImport: jest.fn(async () => {
      calls.cancelImport.push(1)
      return true
    }),
  }

  return {
    client: client as unknown as Parameters<typeof importDelimitedFileToWorkbook>[0],
    calls,
    setImportChunkImpl(fn: (sessionId: number, cells: ImportCellWire[]) => Promise<number>) {
      client.importChunk = fn as never
    },
  }
}

describe('file import helpers', () => {
  it('parses quoted CSV fields and escaped quotes', () => {
    expect(parseDelimitedLine('a,"b,c","d""e",""', ',')).toEqual(['a', 'b,c', 'd"e', ''])
    expect(parseDelimitedLine('a,b,"c"\r', ',')).toEqual(['a', 'b', 'c'])
  })

  it('detects TSV and parses tab-delimited lines', () => {
    expect(detectDelimiter('report.tsv', 'a\tb\tc')).toBe('\t')
    expect(detectDelimiter('input', 'a\tb\tc\nd\te\tf')).toBe('\t')
    expect(parseDelimitedLine('A\tB\t"quoted\tfield"\t', '\t')).toEqual([
      'A',
      'B',
      'quoted\tfield',
      '',
    ])
  })

  it('streams and flushes chunks sequentially (backpressure)', async () => {
    const gate = deferred()
    const { client, calls, setImportChunkImpl } = makeFakeClient()

    let firstChunkResolved = false
    setImportChunkImpl(async (_sessionId, cells) => {
      calls.importChunk.push({ sessionId: _sessionId, cells: [...cells] })
      if (cells.length === 1 && !firstChunkResolved) {
        await gate.promise
        firstChunkResolved = true
      }
      return cells.length
    })

    const importPromise = importDelimitedFileToWorkbook(
      client,
      makeTextBlob('1,2\n3,4\n', 'data.csv'),
      { chunkSize: 1 },
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(calls.beginImport).toEqual([1])
    expect(calls.importChunk).toHaveLength(1)
    expect(calls.importChunk[0].cells).toEqual([
      { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
    ])

    gate.resolve()
    const result = await importPromise
    expect(result.status).toBe('committed')
    expect(calls.importChunk.length).toBeGreaterThan(1)
    expect(calls.commitImport).toHaveLength(1)
    expect(calls.cancelImport).toHaveLength(0)
  })

  it('waits for chunk ack before reading the next stream chunk', async () => {
    const gate = deferred()
    const firstChunkStarted = deferred()
    const { client, calls, setImportChunkImpl } = makeFakeClient()
    const { blob, state } = makeChunkedTextBlob(['1\n', '2\n'], 'data.csv')

    setImportChunkImpl(async (_sessionId, cells) => {
      calls.importChunk.push({ sessionId: _sessionId, cells: [...cells] })
      firstChunkStarted.resolve()
      await gate.promise
      return cells.length
    })

    const importPromise = importDelimitedFileToWorkbook(client, blob, { chunkSize: 1 })
    await firstChunkStarted.promise

    expect(calls.importChunk).toHaveLength(1)
    expect(state.readCalls).toBe(1)

    gate.resolve()
    await importPromise
    expect(state.readCalls).toBeGreaterThanOrEqual(3)
  })

  it('aborts and cancels without commit', async () => {
    const gate = deferred()
    const firstChunkStarted = deferred()
    const { client, calls, setImportChunkImpl } = makeFakeClient()

    setImportChunkImpl(async (_sessionId, cells) => {
      calls.importChunk.push({ sessionId: _sessionId, cells: [...cells] })
      firstChunkStarted.resolve()
      await gate.promise
      return 1
    })

    const controller = new AbortController()
    const importPromise = importDelimitedFileToWorkbook(
      client,
      makeTextBlob('1,2\n3,4\n', 'data.csv'),
      { chunkSize: 1, signal: controller.signal },
    )

    await firstChunkStarted.promise
    controller.abort()
    const result = await importPromise

    expect(result.status).toBe('cancelled')
    expect(calls.cancelImport).toHaveLength(1)
    expect(calls.cancelImport[0]).toBe(1)
    expect(calls.commitImport).toHaveLength(0)
  })

  it('cancels the import session when a chunk fails', async () => {
    const { client, calls, setImportChunkImpl } = makeFakeClient()
    setImportChunkImpl(async (_sessionId, cells) => {
      calls.importChunk.push({ sessionId: _sessionId, cells: [...cells] })
      throw new Error('worker import failed')
    })

    await expect(
      importDelimitedFileToWorkbook(client, makeTextBlob('1,2\n', 'data.csv'), { chunkSize: 1 }),
    ).rejects.toThrow('worker import failed')

    expect(calls.cancelImport).toEqual([1])
    expect(calls.commitImport).toHaveLength(0)
  })

  it('imports formula cells as formula kind', async () => {
    const { client, calls } = makeFakeClient()

    await importDelimitedFileToWorkbook(client, makeTextBlob('=A1+1,text,TRUE,3.5', 'data.csv'), {
      chunkSize: 10,
    })

    expect(calls.beginImport).toEqual([1])
    expect(calls.importChunk).toHaveLength(1)
    const cells = calls.importChunk[0].cells
    expect(cells[0]).toEqual({ sheet: 0, row: 0, col: 0, kind: 'formula', value: '=A1+1' })
    expect(cells[1]).toEqual({ sheet: 0, row: 0, col: 1, kind: 'text', value: 'text' })
    expect(cells[2]).toEqual({ sheet: 0, row: 0, col: 2, kind: 'boolean', value: true })
    expect(cells[3]).toEqual({ sheet: 0, row: 0, col: 3, kind: 'number', value: 3.5 })
  })
})
