import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  encodeSelectionAsImage,
  lastCopyAsAtom,
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
  test('returns null when backend.exportRangeAsImage is missing', async () => {
    const backend = makeMinimalBackend()
    const blob = await encodeSelectionAsImage(
      { sheetId: 'sheet-1', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } },
      backend,
    )
    expect(blob).toBeNull()
  })

  test('returns null when backend returns empty bytes', async () => {
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
    const blob = await encodeSelectionAsImage(
      { sheetId: 'sheet-1', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } },
      backend,
    )
    expect(blob).toBeNull()
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
    const blob = await encodeSelectionAsImage(
      { sheetId: 'sheet-x', rect: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, scale: 2 },
      backend,
    )
    expect(blob).not.toBeNull()
    expect(blob!.type).toBe('image/png')
    // jsdom's Blob lacks `arrayBuffer()`; `size` is the most we can assert
    // about the payload without reading it back. The size === input bytes
    // confirms the encoder didn't drop or re-encode anything.
    expect(blob!.size).toBe(FAKE_PNG_BYTES.byteLength)
    // And the encoder forwarded the rect → range conversion + scale verbatim.
    expect(spy).toHaveBeenCalledTimes(1)
    const call = spy.mock.calls[0]![0]
    expect(call.kind).toBe('export-range-image')
    expect(call.sheetId).toBe('sheet-x')
    expect(call.format).toBe('png')
    expect(call.scale).toBe(2)
    expect(call.range).toEqual({ rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 })
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
