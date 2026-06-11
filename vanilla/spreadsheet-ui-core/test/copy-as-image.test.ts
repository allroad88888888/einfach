import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  encodeSelectionAsImage,
  lastCopyAsAtom,
  MAX_EXPORT_PIXELS,
  type CopyAsImageResult,
  type CopyAsTextResult,
} from '../src/copy-as'
import type {
  RangeImageExportRequest,
  RangeImageExportResult,
  SpreadsheetBackend,
} from '../src/backend/types'

/**
 * Minimal valid PNG signature followed by an IHDR placeholder. Only used
 * here to give the mocked backend something to round-trip — the test
 * never decodes the image, it just asserts the bytes survive the
 * encoder.
 */
const FAKE_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d, // IHDR length
  0x49, 0x48, 0x44, 0x52, // 'IHDR'
])

function makeMinimalBackend(
  overrides: Partial<SpreadsheetBackend> = {},
): SpreadsheetBackend {
  return {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: request.window,
        requestId: request.requestId,
        cells: [],
      }
    },
    async readRangeProjection(request) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: request.range,
        requestId: request.requestId,
        cells: [],
      }
    },
    async setCellInput(request) {
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision,
      }
    },
    ...overrides,
  }
}

describe('encodeSelectionAsImage', () => {
  test('returns no-backend failure when backend.exportRangeAsImage is missing', async () => {
    const backend = makeMinimalBackend()
    const result = await encodeSelectionAsImage(
      { sheetId: 'sheet-1', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } },
      backend,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-backend')
  })

  test('returns empty-bytes failure when backend returns empty bytes', async () => {
    const backend = makeMinimalBackend({
      exportRangeAsImage: async (req: RangeImageExportRequest): Promise<RangeImageExportResult> => ({
        kind: 'range-image',
        sheetId: req.sheetId,
        range: req.range,
        bytes: new Uint8Array(0),
        width: 0,
        height: 0,
        mimeType: 'image/png',
      }),
    })
    const result = await encodeSelectionAsImage(
      { sheetId: 'sheet-1', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } },
      backend,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty-bytes')
  })

  test('returns a Blob typed image/png with the backend bytes', async () => {
    const spy = jest.fn(
      async (req: RangeImageExportRequest): Promise<RangeImageExportResult> => ({
        kind: 'range-image',
        sheetId: req.sheetId,
        range: req.range,
        bytes: FAKE_PNG_BYTES,
        width: 64,
        height: 32,
        mimeType: 'image/png',
      }),
    )
    const backend = makeMinimalBackend({ exportRangeAsImage: spy })
    const result = await encodeSelectionAsImage(
      { sheetId: 'sheet-x', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, scale: 2 },
      backend,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok=true')
    expect(result.blob.type).toBe('image/png')
    // jsdom's Blob lacks `arrayBuffer()`; `size` is the most we can assert
    // about the payload without reading it back. The size === input bytes
    // confirms the encoder didn't drop or re-encode anything.
    expect(result.blob.size).toBe(FAKE_PNG_BYTES.byteLength)
    // And the encoder forwarded the rect → range conversion + scale verbatim.
    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0]![0]
    expect(call.kind).toBe('export-range-image')
    expect(call.sheetId).toBe('sheet-x')
    expect(call.format).toBe('png')
    expect(call.scale).toBe(2)
    expect(call.range).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })
  })

  test('returns too-large failure without calling the backend when the estimate exceeds the cap', async () => {
    // 100k rows × 26 cols × default sizes (96 × 24) = 2,496 × 96 × 100,000 × 24
    // = 5.99e9 pixels — well above the 16.78M cap.
    const spy = jest.fn(
      async (req: RangeImageExportRequest): Promise<RangeImageExportResult> => ({
        kind: 'range-image',
        sheetId: req.sheetId,
        range: req.range,
        bytes: FAKE_PNG_BYTES,
        width: 1,
        height: 1,
        mimeType: 'image/png',
      }),
    )
    const backend = makeMinimalBackend({ exportRangeAsImage: spy })
    const result = await encodeSelectionAsImage(
      {
        sheetId: 'big-sheet',
        rect: { startRow: 0, startCol: 0, endRow: 99_999, endCol: 25 },
      },
      backend,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok=false')
    expect(result.reason).toBe('too-large')
    expect(result.estimatedPixels).toBeGreaterThan(MAX_EXPORT_PIXELS)
    expect(result.limit).toBe(MAX_EXPORT_PIXELS)
    // Critical: backend was NEVER called — the cap is a pre-flight gate.
    expect(spy).not.toHaveBeenCalled()
  })

  test('per-call maxPixels override raises the cap', async () => {
    const spy = jest.fn(
      async (req: RangeImageExportRequest): Promise<RangeImageExportResult> => ({
        kind: 'range-image',
        sheetId: req.sheetId,
        range: req.range,
        bytes: FAKE_PNG_BYTES,
        width: 1,
        height: 1,
        mimeType: 'image/png',
      }),
    )
    const backend = makeMinimalBackend({ exportRangeAsImage: spy })
    // 4 × 4 cells × 96 × 24 defaults = 36,864 pixels — well below the
    // default cap. With maxPixels=10, that same rect now exceeds.
    const result = await encodeSelectionAsImage(
      {
        sheetId: 'sheet-x',
        rect: { startRow: 0, startCol: 0, endRow: 3, endCol: 3 },
        maxPixels: 10,
      },
      backend,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok=false')
    expect(result.reason).toBe('too-large')
    expect(result.limit).toBe(10)
    expect(spy).not.toHaveBeenCalled()
  })

  test('host-provided per-cell sizes feed the estimate', async () => {
    // 10 × 10 cells × 1px × 1px overrides = 100 pixels. Default cap.
    const spy = jest.fn(
      async (req: RangeImageExportRequest): Promise<RangeImageExportResult> => ({
        kind: 'range-image',
        sheetId: req.sheetId,
        range: req.range,
        bytes: FAKE_PNG_BYTES,
        width: 10,
        height: 10,
        mimeType: 'image/png',
      }),
    )
    const backend = makeMinimalBackend({ exportRangeAsImage: spy })
    const result = await encodeSelectionAsImage(
      {
        sheetId: 'sheet-x',
        rect: { startRow: 0, startCol: 0, endRow: 9, endCol: 9 },
        estimatedColWidthPx: 1,
        estimatedRowHeightPx: 1,
      },
      backend,
    )
    expect(result.ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('lastCopyAsAtom — image variant', () => {
  test('accepts the {kind: image, mimeType, blob} variant', () => {
    const store = createStore()
    const blob = new Blob([FAKE_PNG_BYTES], { type: 'image/png' })
    const snap: CopyAsImageResult = { kind: 'image', mimeType: 'image/png', blob }
    store.setter(lastCopyAsAtom, snap)
    const got = store.getter(lastCopyAsAtom)
    expect(got).not.toBeNull()
    expect(got!.kind).toBe('image')
    // Narrow + verify the blob round-tripped.
    if (got && got.kind === 'image') {
      expect(got.blob).toBe(blob)
      expect(got.mimeType).toBe('image/png')
    }
  })

  test('continues to accept the legacy text triple (kind omitted)', () => {
    const store = createStore()
    const snap: CopyAsTextResult = { html: '<table></table>', plainText: 'a', markdown: '| a |' }
    store.setter(lastCopyAsAtom, snap)
    const got = store.getter(lastCopyAsAtom)
    expect(got).not.toBeNull()
    // No kind on the text variant → undefined, NOT 'image'.
    expect(got!.kind).toBeUndefined()
  })
})
