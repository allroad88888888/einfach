import { describe, expect, test } from '@jest/globals'
import type { DisplayCell } from '../src/backend/types'
import type {
  DisplayCellRichValue,
  RichTextValue,
} from '../src/rich-types/types'
import {
  getDisplayCellText,
  getRichValueText,
  isHyperlinkValue,
  isRichTextValue,
} from '../src/rich-types'

describe('rich-types', () => {
  describe('DisplayCell typechecking', () => {
    test('hyperlink richValue is accepted alongside displayValue string', () => {
      const cell: DisplayCell = {
        row: 0,
        col: 0,
        displayValue: 'Example',
        richValue: { kind: 'hyperlink', url: 'https://example.com', label: 'Example' },
      }
      expect(cell.displayValue).toBe('Example')
      expect(cell.richValue).toBeDefined()
    })

    test('rich-text richValue with optional formats typechecks', () => {
      const cell: DisplayCell = {
        row: 1,
        col: 0,
        displayValue: 'Hello world',
        richValue: {
          kind: 'rich-text',
          runs: [
            { text: 'Hello ', format: { bold: true, color: '#ff0000' } },
            { text: 'world' },
          ],
        },
      }
      const rv = cell.richValue as RichTextValue
      expect(rv.runs).toHaveLength(2)
      expect(rv.runs[0].format?.bold).toBe(true)
      expect(rv.runs[1].format).toBeUndefined()
    })

    test('richValue is optional — DisplayCell without it is valid', () => {
      const cell: DisplayCell = { row: 0, col: 0, displayValue: 'plain' }
      expect(cell.richValue).toBeUndefined()
    })
  })

  describe('getRichValueText', () => {
    test('hyperlink returns label', () => {
      const v: DisplayCellRichValue = { kind: 'hyperlink', url: 'https://x.com', label: 'X' }
      expect(getRichValueText(v)).toBe('X')
    })

    test('rich-text returns concatenated run text', () => {
      const v: DisplayCellRichValue = {
        kind: 'rich-text',
        runs: [{ text: 'foo' }, { text: 'bar', format: { italic: true } }],
      }
      expect(getRichValueText(v)).toBe('foobar')
    })

    test('number returns String(value)', () => {
      const v: DisplayCellRichValue = { kind: 'number', value: 42 }
      expect(getRichValueText(v)).toBe('42')
    })

    test('boolean returns String(value)', () => {
      expect(getRichValueText({ kind: 'boolean', value: true })).toBe('true')
      expect(getRichValueText({ kind: 'boolean', value: false })).toBe('false')
    })

    test('error returns message', () => {
      const v: DisplayCellRichValue = { kind: 'error', code: '#REF!', message: 'Invalid reference' }
      expect(getRichValueText(v)).toBe('Invalid reference')
    })
  })

  describe('getDisplayCellText', () => {
    test('falls back to displayValue when richValue is absent', () => {
      const cell: DisplayCell = { row: 0, col: 0, displayValue: 'plain text' }
      expect(getDisplayCellText(cell)).toBe('plain text')
    })

    test('prefers richValue text when present', () => {
      const cell: DisplayCell = {
        row: 0,
        col: 0,
        displayValue: 'fallback',
        richValue: { kind: 'hyperlink', url: 'https://a.com', label: 'A link' },
      }
      expect(getDisplayCellText(cell)).toBe('A link')
    })

    test('prefers rich-text concatenation over displayValue', () => {
      const cell: DisplayCell = {
        row: 0,
        col: 0,
        displayValue: 'old',
        richValue: { kind: 'rich-text', runs: [{ text: 'new' }, { text: ' value' }] },
      }
      expect(getDisplayCellText(cell)).toBe('new value')
    })
  })

  describe('type guards', () => {
    test('isHyperlinkValue discriminates correctly', () => {
      const h: DisplayCellRichValue = { kind: 'hyperlink', url: 'https://b.com', label: 'B' }
      const t: DisplayCellRichValue = { kind: 'rich-text', runs: [] }
      expect(isHyperlinkValue(h)).toBe(true)
      expect(isHyperlinkValue(t)).toBe(false)
      if (isHyperlinkValue(h)) {
        expect(h.url).toBe('https://b.com')
      }
    })

    test('isRichTextValue discriminates correctly', () => {
      const t: DisplayCellRichValue = { kind: 'rich-text', runs: [{ text: 'x' }] }
      const h: DisplayCellRichValue = { kind: 'hyperlink', url: 'https://c.com', label: 'C' }
      expect(isRichTextValue(t)).toBe(true)
      expect(isRichTextValue(h)).toBe(false)
      if (isRichTextValue(t)) {
        expect(t.runs[0].text).toBe('x')
      }
    })
  })
})
