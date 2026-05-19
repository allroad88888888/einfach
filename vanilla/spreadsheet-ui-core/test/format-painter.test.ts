import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  applyFormatPainterAtom,
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  exitFormatPainterAtom,
  formatPainterClipboardAtom,
  formatPainterStateAtom,
} from '../src/format-painter'
import type { CapturedFormat } from '../src/format-painter'

function sampleFormat(): CapturedFormat {
  return {
    format: {
      bold: true,
      italic: false,
      align: 'right',
      fontSize: 14,
      fgColor: '#112233',
      bgColor: '#ffeecc',
      underline: true,
      wrap: true,
      numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
      borders: {
        top: { style: 'thin', color: '#000000' },
        bottom: { style: 'medium' },
      },
    },
  }
}

describe('format-painter', () => {
  test('initial state is idle with empty clipboard', () => {
    const store = createStore()
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  test('armFormatPainterAtom captures payload and transitions to armed', () => {
    const store = createStore()
    const captured = sampleFormat()
    store.setter(armFormatPainterAtom, captured)
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    expect(store.getter(formatPainterClipboardAtom)).toEqual(captured)
  })

  test('captured payload preserves the full SpreadsheetCellFormat shape', () => {
    const store = createStore()
    const captured = sampleFormat()
    store.setter(armFormatPainterAtom, captured)
    const clip = store.getter(formatPainterClipboardAtom)
    expect(clip).not.toBeNull()
    expect(clip!.format.bold).toBe(true)
    expect(clip!.format.align).toBe('right')
    expect(clip!.format.numberFormat).toEqual({ kind: 'currency', symbol: '$', digits: 2 })
    expect(clip!.format.borders?.top?.style).toBe('thin')
    expect(clip!.format.bgColor).toBe('#ffeecc')
    expect(clip!.format.fgColor).toBe('#112233')
  })

  test('armFormatPainterStickyAtom transitions to sticky', () => {
    const store = createStore()
    store.setter(armFormatPainterStickyAtom, sampleFormat())
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
  })

  test('applyFormatPainterAtom in armed mode returns true and exits to idle', () => {
    const store = createStore()
    store.setter(armFormatPainterAtom, sampleFormat())
    const applied = store.setter(applyFormatPainterAtom)
    expect(applied).toBe(true)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  test('applyFormatPainterAtom in sticky mode stays sticky and keeps clipboard', () => {
    const store = createStore()
    store.setter(armFormatPainterStickyAtom, sampleFormat())
    const first = store.setter(applyFormatPainterAtom)
    const second = store.setter(applyFormatPainterAtom)
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
  })

  test('applyFormatPainterAtom while idle returns false and stays idle', () => {
    const store = createStore()
    const applied = store.setter(applyFormatPainterAtom)
    expect(applied).toBe(false)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
  })

  test('exitFormatPainterAtom resets state and clipboard from armed', () => {
    const store = createStore()
    store.setter(armFormatPainterAtom, sampleFormat())
    store.setter(exitFormatPainterAtom)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  test('exitFormatPainterAtom resets state and clipboard from sticky', () => {
    const store = createStore()
    store.setter(armFormatPainterStickyAtom, sampleFormat())
    store.setter(exitFormatPainterAtom)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  test('captured payload accepts an optional conditionalFormat', () => {
    const store = createStore()
    const captured: CapturedFormat = {
      format: { bold: true },
      conditionalFormat: { bgColor: '#ff0000' },
    }
    store.setter(armFormatPainterAtom, captured)
    expect(store.getter(formatPainterClipboardAtom)?.conditionalFormat).toEqual({
      bgColor: '#ff0000',
    })
  })

  test('re-arming overwrites the captured clipboard', () => {
    const store = createStore()
    store.setter(armFormatPainterAtom, { format: { bold: true } })
    store.setter(armFormatPainterAtom, { format: { italic: true } })
    expect(store.getter(formatPainterClipboardAtom)).toEqual({ format: { italic: true } })
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
  })
})
