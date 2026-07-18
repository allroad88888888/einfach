import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import type { DisplayCell } from '../src/backend/types'
import {
  copyAsErrorAtom,
  encodeSelectionAsHtml,
  encodeSelectionAsMarkdown,
  encodeSelectionAsPlainText,
  encodeSelectionForClipboard,
  lastCopyAsAtom,
  publishCopyAsResultAtom,
  reportCopyAsStatusAtom,
} from '../src/copy-as'

function rect(startRow: number, startCol: number, endRow: number, endCol: number) {
  return { startRow, startCol, endRow, endCol }
}

function cell(
  row: number,
  col: number,
  displayValue: string,
  extras: Partial<DisplayCell> = {},
): DisplayCell {
  return { row, col, displayValue, ...extras }
}

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const LAST_RESULT_IS_READ_ONLY: AtomHasPublicWrite<typeof lastCopyAsAtom> = false
const COPY_AS_STATUS_IS_READ_ONLY: AtomHasPublicWrite<typeof copyAsErrorAtom> = false

describe('copy-as / atoms', () => {
  test('public state is read-only and commands keep stores isolated', () => {
    const firstStore = createStore()
    const secondStore = createStore()
    expect(firstStore.getter(lastCopyAsAtom)).toBeNull()
    expect(firstStore.getter(copyAsErrorAtom)).toBeNull()
    expect([LAST_RESULT_IS_READ_ONLY, COPY_AS_STATUS_IS_READ_ONLY]).toEqual([false, false])
    expect('write' in lastCopyAsAtom).toBe(false)
    expect('write' in copyAsErrorAtom).toBe(false)

    const snap = { html: '<table></table>', plainText: 'a', markdown: '| a |' }
    firstStore.setter(publishCopyAsResultAtom, snap)
    firstStore.setter(reportCopyAsStatusAtom, { kind: 'fallback-plain-only' })
    expect(firstStore.getter(lastCopyAsAtom)).toEqual(snap)
    expect(firstStore.getter(copyAsErrorAtom)).toEqual({ kind: 'fallback-plain-only' })
    expect(secondStore.getter(lastCopyAsAtom)).toBeNull()
    expect(secondStore.getter(copyAsErrorAtom)).toBeNull()

    const unsafeSet = firstStore.setter as unknown as (target: unknown, value: unknown) => unknown
    expect(() => unsafeSet(lastCopyAsAtom, null)).toThrow(TypeError)
    expect(() => unsafeSet(copyAsErrorAtom, null)).toThrow(TypeError)
    expect(firstStore.getter(lastCopyAsAtom)).toEqual(snap)
    expect(firstStore.getter(copyAsErrorAtom)).toEqual({ kind: 'fallback-plain-only' })

    firstStore.setter(reportCopyAsStatusAtom, null)
    expect(firstStore.getter(copyAsErrorAtom)).toBeNull()
  })
})

describe('copy-as / basic 2x2 mixed types', () => {
  const input = {
    rect: rect(0, 0, 1, 1),
    cells: [
      cell(0, 0, 'Name'),
      cell(0, 1, 'Score'),
      cell(1, 0, 'Ada'),
      cell(1, 1, '42', { valueKind: 'number' }),
    ],
  }

  test('html renders a 2x2 table with content in each cell', () => {
    const html = encodeSelectionAsHtml(input)
    expect(html.startsWith('<table')).toBe(true)
    expect(html.endsWith('</table>')).toBe(true)
    // Four cells, two rows.
    expect(html.match(/<tr/g)?.length).toBe(2)
    expect(html.match(/<td/g)?.length).toBe(4)
    expect(html).toContain('>Name<')
    expect(html).toContain('>Score<')
    expect(html).toContain('>Ada<')
    expect(html).toContain('>42<')
  })

  test('markdown renders header + separator + body row', () => {
    const md = encodeSelectionAsMarkdown(input)
    const lines = md.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('| Name | Score |')
    expect(lines[1]).toMatch(/^\|\s+---\s+\|\s+---\s+\|$/)
    expect(lines[2]).toBe('| Ada | 42 |')
  })

  test('plain text renders tab-separated columns + newline rows', () => {
    const plain = encodeSelectionAsPlainText(input)
    expect(plain).toBe('Name\tScore\nAda\t42')
  })

  test('encodeSelectionForClipboard bundles all three flavours', () => {
    const out = encodeSelectionForClipboard(input)
    expect(out.html).toBe(encodeSelectionAsHtml(input))
    expect(out.plainText).toBe(encodeSelectionAsPlainText(input))
    expect(out.markdown).toBe(encodeSelectionAsMarkdown(input))
  })
})

describe('copy-as / empty cells', () => {
  test('html emits empty <td></td> for missing cell in middle', () => {
    const input = {
      rect: rect(0, 0, 0, 2),
      cells: [cell(0, 0, 'A'), cell(0, 2, 'C')],
    }
    const html = encodeSelectionAsHtml(input)
    // Three <td> tags total — middle one has empty content.
    expect(html.match(/<td/g)?.length).toBe(3)
    expect(html).toContain('>A</td>')
    expect(html).toContain('>C</td>')
    expect(html).toMatch(/<td[^>]*><\/td>/)
  })

  test('markdown emits blank cell for missing column', () => {
    const input = {
      rect: rect(0, 0, 0, 2),
      cells: [cell(0, 0, 'A'), cell(0, 2, 'C')],
    }
    const md = encodeSelectionAsMarkdown(input)
    expect(md.split('\n')[0]).toBe('| A |  | C |')
  })

  test('plain text emits empty tab-delimited column', () => {
    const input = {
      rect: rect(0, 0, 0, 2),
      cells: [cell(0, 0, 'A'), cell(0, 2, 'C')],
    }
    expect(encodeSelectionAsPlainText(input)).toBe('A\t\tC')
  })
})

describe('copy-as / HTML escaping', () => {
  test('<script> in display value is escaped, not interpreted', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, '<script>alert(1)</script>')],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('quote and ampersand characters are escaped', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'A & "B" \'C\'')],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('A &amp; &quot;B&quot; &#39;C&#39;')
  })
})

describe('copy-as / pipe escaping', () => {
  test('markdown escapes inner | as \\|', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'left|right')],
    }
    expect(encodeSelectionAsMarkdown(input).split('\n')[0]).toBe('| left\\|right |')
  })

  test('plain text passes | through verbatim', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'left|right')],
    }
    expect(encodeSelectionAsPlainText(input)).toBe('left|right')
  })
})

describe('copy-as / newlines inside cells', () => {
  const input = {
    rect: rect(0, 0, 0, 0),
    cells: [cell(0, 0, 'line1\nline2')],
  }

  test('html replaces \\n with <br>', () => {
    expect(encodeSelectionAsHtml(input)).toContain('line1<br>line2')
  })

  test('markdown replaces \\n with <br>', () => {
    expect(encodeSelectionAsMarkdown(input).split('\n')[0]).toBe('| line1<br>line2 |')
  })

  test('plain text replaces \\n with single space', () => {
    expect(encodeSelectionAsPlainText(input)).toBe('line1 line2')
  })

  test('plain text replaces inner \\t with single space', () => {
    const inputTab = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'a\tb')],
    }
    expect(encodeSelectionAsPlainText(inputTab)).toBe('a b')
  })
})

describe('copy-as / formatting', () => {
  test('bold + italic + color projected to inline css in html', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'styled', {
          format: {
            bold: true,
            italic: true,
            fgColor: '#ff0000',
            bgColor: '#ffff00',
            fontFamily: 'Arial',
            fontSize: 14,
          },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('font-weight: bold')
    expect(html).toContain('font-style: italic')
    expect(html).toContain('color: #ff0000')
    expect(html).toContain('background-color: #ffff00')
    expect(html).toContain('font-family: Arial')
    expect(html).toContain('font-size: 14pt')
  })

  test('underline + strikethrough combine into text-decoration', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { underline: true, strikethrough: true },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('text-decoration: underline line-through')
  })

  test('alignment maps to text-align / vertical-align', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { align: 'center', verticalAlign: 'center' },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('text-align: center')
    expect(html).toContain('vertical-align: middle')
  })

  test('markdown wraps bold+italic around the cell text', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'big', { format: { bold: true, italic: true } }),
      ],
    }
    expect(encodeSelectionAsMarkdown(input).split('\n')[0]).toBe('| ***big*** |')
  })

  test('markdown drops unsupported formatting silently', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { underline: true, strikethrough: true, fgColor: '#ff0000' },
        }),
      ],
    }
    expect(encodeSelectionAsMarkdown(input).split('\n')[0]).toBe('| x |')
  })

  test('plain text ignores formatting entirely', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { bold: true } })],
    }
    expect(encodeSelectionAsPlainText(input)).toBe('x')
  })
})

describe('copy-as / merge cells', () => {
  const input = {
    rect: rect(0, 0, 1, 1),
    cells: [
      cell(0, 0, 'M', { mergedSpan: { rows: 2, cols: 2 } }),
    ],
  }

  test('html emits rowspan + colspan on anchor and skips covered cells', () => {
    const html = encodeSelectionAsHtml(input)
    expect(html.match(/<td/g)?.length).toBe(1)
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('colspan="2"')
    expect(html).toContain('>M</td>')
  })

  test('markdown shows content in top-left, blank in covered cells', () => {
    const md = encodeSelectionAsMarkdown(input)
    const lines = md.split('\n')
    expect(lines[0]).toBe('| M |  |')
    expect(lines[2]).toBe('|  |  |')
  })

  test('plain text leaves covered cell columns blank, anchor on top-left', () => {
    expect(encodeSelectionAsPlainText(input)).toBe('M\t\n\t')
  })
})

describe('copy-as / sparse rectangle', () => {
  test('rect iterated, not the cells array — empty cells materialised', () => {
    const input = {
      rect: rect(0, 0, 2, 2),
      cells: [cell(1, 1, 'mid')],
    }
    const html = encodeSelectionAsHtml(input)
    // 3 rows × 3 cols = 9 tds.
    expect(html.match(/<td/g)?.length).toBe(9)
    expect(html).toContain('>mid</td>')

    const md = encodeSelectionAsMarkdown(input)
    const lines = md.split('\n')
    expect(lines).toHaveLength(4) // header + sep + 2 body rows
    expect(lines[0]).toBe('|  |  |  |')
    expect(lines[2]).toBe('|  | mid |  |')
    expect(lines[3]).toBe('|  |  |  |')

    const plain = encodeSelectionAsPlainText(input)
    expect(plain).toBe('\t\t\n\tmid\t\n\t\t')
  })
})

describe('copy-as / mixed merge + formatting', () => {
  test('anchor carries style and rowspan/colspan together', () => {
    const input = {
      rect: rect(0, 0, 1, 1),
      cells: [
        cell(0, 0, 'Hi', {
          mergedSpan: { rows: 2, cols: 2 },
          format: { bold: true, bgColor: '#eeeeee' },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html.match(/<td/g)?.length).toBe(1)
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('colspan="2"')
    expect(html).toContain('font-weight: bold')
    expect(html).toContain('background-color: #eeeeee')
    expect(html).toContain('>Hi</td>')
  })
})

describe('copy-as / single cell', () => {
  test('1x1 rect renders a one-row, one-col table everywhere', () => {
    const input = {
      rect: rect(5, 7, 5, 7),
      cells: [cell(5, 7, 'solo')],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html.match(/<tr/g)?.length).toBe(1)
    expect(html.match(/<td/g)?.length).toBe(1)
    expect(html).toContain('>solo</td>')

    expect(encodeSelectionAsMarkdown(input)).toBe('| solo |\n| --- |')
    expect(encodeSelectionAsPlainText(input)).toBe('solo')
  })
})

describe('copy-as / CSS-injection defence', () => {
  test('color values that try to inject extra declarations are dropped', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { fgColor: 'red; background-image: url(x)' },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).not.toContain('background-image')
    // The malicious `color` value also fails the whitelist → no `color:` decl.
    expect(html).not.toMatch(/color:\s*red;/i)
  })

  test('bgColor that closes the attribute and injects a script is rejected', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { bgColor: '"><script>alert(1)</script>' },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
    // The style="…" attribute must still be well-formed.
    expect(html).toMatch(/<td [^>]*style="[^"]*"[^>]*>/)
  })

  test('fontFamily containing CSS punctuation is dropped', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { fontFamily: 'Arial"; padding: 999px' },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).not.toContain('font-family:')
    expect(html).not.toContain('padding: 999px')
  })

  test('valid hex / rgb / named colors and font-family stacks pass through', () => {
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: {
            fgColor: '#ff00ff',
            bgColor: 'rgb(255, 0, 0)',
            fontFamily: 'Arial, sans-serif',
            fontSize: 14,
          },
        }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('color: #ff00ff')
    expect(html).toContain('background-color: rgb(255, 0, 0)')
    expect(html).toContain('font-family: Arial, sans-serif')
    expect(html).toContain('font-size: 14pt')
  })

  test('rgba with alpha 0..1 is accepted; out-of-range alpha is rejected', () => {
    const ok = encodeSelectionAsHtml({
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { fgColor: 'rgba(0, 128, 255, 0.5)' } })],
    })
    expect(ok).toContain('color: rgba(0, 128, 255, 0.5)')

    const bad = encodeSelectionAsHtml({
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { fgColor: 'rgba(0, 0, 0, 2)' } })],
    })
    expect(bad).not.toMatch(/color:\s*rgba/i)
  })

  test('rgb with channel out of 0..255 is rejected', () => {
    const html = encodeSelectionAsHtml({
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { fgColor: 'rgb(999, 0, 0)' } })],
    })
    expect(html).not.toMatch(/color:\s*rgb/i)
  })

  test('font-size is numeric only — non-finite / negative dropped', () => {
    const html = encodeSelectionAsHtml({
      rect: rect(0, 0, 0, 0),
      cells: [
        cell(0, 0, 'x', {
          format: { fontSize: Number.POSITIVE_INFINITY },
        }),
      ],
    })
    expect(html).not.toContain('font-size:')

    const html2 = encodeSelectionAsHtml({
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { fontSize: -1 } })],
    })
    expect(html2).not.toContain('font-size:')
  })

  test('style="…" payload is HTML-attribute-escaped (defence-in-depth)', () => {
    // Even though whitelists reject `"` outright today, verify the attribute
    // escape covers `&` and `"` should anything ever slip through.
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'x', { format: { fgColor: '#ff0000' } })],
    }
    const html = encodeSelectionAsHtml(input)
    // No raw `&` outside `&amp;` etc. inside any style="…" payload.
    const styleMatches = html.match(/style="([^"]*)"/g) ?? []
    for (const s of styleMatches) {
      const inside = s.slice('style="'.length, -1)
      // Should never have an unescaped `&` that isn't part of an entity, or
      // a literal `"`.
      expect(inside).not.toMatch(/&(?!(?:amp|lt|gt|quot|#\d+);)/)
      expect(inside).not.toContain('"')
    }
  })
})

describe('copy-as / merge clipping (HTML)', () => {
  test('anchor in rect, span extends outside → clipped to rect', () => {
    // 3x3 merge anchored at (0,0), but rect is only the 2x2 top-left slice.
    const input = {
      rect: rect(0, 0, 1, 1),
      cells: [cell(0, 0, 'X', { mergedSpan: { rows: 3, cols: 3 } })],
    }
    const html = encodeSelectionAsHtml(input)
    // Only one <td> (anchor), and its span is clipped to 2x2.
    expect(html.match(/<td/g)?.length).toBe(1)
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('colspan="2"')
    expect(html).toContain('>X</td>')
    // No oversize span leaking outside the rect.
    expect(html).not.toContain('rowspan="3"')
    expect(html).not.toContain('colspan="3"')
  })

  test('anchor outside rect, covered cells inside → synthetic anchor at intersection', () => {
    // Merge A1:C3 (rows 0..2, cols 0..2); selection B2:D4 (rows 1..3, cols 1..3).
    // Intersection: rows 1..2, cols 1..2 → synthetic 2x2 anchor at (1,1),
    // rendered blank (anchor's content is outside the selection).
    const input = {
      rect: rect(1, 1, 3, 3),
      cells: [
        // Covered cells inside the rect carry mergeAnchor pointing to (0,0).
        cell(1, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(1, 2, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(2, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(2, 2, '', { mergeAnchor: { row: 0, col: 0 } }),
        // Non-merge cells filling the rest of the selection so we can count.
        cell(1, 3, 'a'),
        cell(2, 3, 'b'),
        cell(3, 1, 'c'),
        cell(3, 2, 'd'),
        cell(3, 3, 'e'),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    // Expect 6 tds: 1 synthetic merge anchor + 5 free cells (a..e).
    expect(html.match(/<td/g)?.length).toBe(6)
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('colspan="2"')
    // Synthetic anchor must be blank — no content leaked from outside rect.
    // (No content matching the missing anchor cell — but there's no source
    // value for it anyway, so we just ensure the rect cells (a..e) made it.)
    expect(html).toContain('>a</td>')
    expect(html).toContain('>e</td>')
  })

  test('full overlap — anchor + entire span in rect → unchanged span', () => {
    const input = {
      rect: rect(0, 0, 2, 2),
      cells: [cell(0, 0, 'Full', { mergedSpan: { rows: 3, cols: 3 } })],
    }
    const html = encodeSelectionAsHtml(input)
    expect(html.match(/<td/g)?.length).toBe(1)
    expect(html).toContain('rowspan="3"')
    expect(html).toContain('colspan="3"')
    expect(html).toContain('>Full</td>')
  })

  test('adjacent merges — anchor-in + anchor-out — both handled', () => {
    // Merge A: anchored at (0,0), span 2x2, fully inside rect.
    // Merge B: anchored at (0,3) (OUTSIDE the rect on the right), span 1x2,
    //          only its left covered cell (0,3) would normally be in rect…
    //          but the rect ends at col 2, so we'll choose Merge B anchored
    //          at (0,2) inside the rect for simplicity and add a separate
    //          "anchor outside on the left" merge to cover the case.
    //
    // Simpler scenario: rect = (1..2, 0..3).
    //   - Merge A: anchored at (0,0), span 3x2 → clipped anchor at (1,0),
    //     span 2x2, rendered blank.
    //   - Merge B: anchored at (1,2), span 2x2, fully inside rect → keeps
    //     its content + 2x2 span.
    const input = {
      rect: rect(1, 0, 2, 3),
      cells: [
        // Merge A covered cells inside rect.
        cell(1, 0, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(1, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(2, 0, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(2, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
        // Merge B anchor inside rect.
        cell(1, 2, 'B', { mergedSpan: { rows: 2, cols: 2 } }),
      ],
    }
    const html = encodeSelectionAsHtml(input)
    // Two clipped tds total.
    expect(html.match(/<td/g)?.length).toBe(2)
    // Merge B anchor with content.
    expect(html).toContain('>B</td>')
    // Both spans show 2x2 (rowspan / colspan attribute repeats).
    const rowspanMatches = html.match(/rowspan="2"/g) ?? []
    const colspanMatches = html.match(/colspan="2"/g) ?? []
    expect(rowspanMatches.length).toBe(2)
    expect(colspanMatches.length).toBe(2)
  })
})

describe('copy-as / merge handling (Markdown)', () => {
  test('covered cell with mergeAnchor outside rect → blank, no leakage', () => {
    // Merge anchored at (0,0) spans (0..1, 0..1). Selection is only the
    // bottom-right covered cell at (1,1). Anchor not in projection.
    const input = {
      rect: rect(1, 1, 1, 1),
      cells: [
        cell(1, 1, 'LEAK', { mergeAnchor: { row: 0, col: 0 } }),
      ],
    }
    const md = encodeSelectionAsMarkdown(input)
    expect(md.split('\n')[0]).toBe('|  |')
    expect(md).not.toContain('LEAK')
  })

  test('anchor inside rect, covered inside → anchor writes content, covered blank', () => {
    const input = {
      rect: rect(0, 0, 1, 1),
      cells: [
        cell(0, 0, 'A', { mergedSpan: { rows: 2, cols: 2 } }),
        cell(0, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(1, 0, '', { mergeAnchor: { row: 0, col: 0 } }),
        cell(1, 1, '', { mergeAnchor: { row: 0, col: 0 } }),
      ],
    }
    const md = encodeSelectionAsMarkdown(input)
    const lines = md.split('\n')
    expect(lines[0]).toBe('| A |  |')
    expect(lines[2]).toBe('|  |  |')
  })

  test('anchor inside rect, covered outside rect → covered N/A, anchor still writes', () => {
    // Merge anchored at (0,0), span 1x2; rect is (0..0, 0..0) only.
    const input = {
      rect: rect(0, 0, 0, 0),
      cells: [cell(0, 0, 'A', { mergedSpan: { rows: 1, cols: 2 } })],
    }
    const md = encodeSelectionAsMarkdown(input)
    expect(md.split('\n')[0]).toBe('| A |')
  })

  test('non-merged cells with no mergeAnchor are untouched', () => {
    const input = {
      rect: rect(0, 0, 0, 1),
      cells: [cell(0, 0, 'A'), cell(0, 1, 'B')],
    }
    const md = encodeSelectionAsMarkdown(input)
    expect(md.split('\n')[0]).toBe('| A | B |')
  })
})

describe('copy-as / decoration hints', () => {
  test('columnWidths and rowHeights threaded into html', () => {
    const input = {
      rect: rect(0, 0, 1, 1),
      cells: [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(1, 0, 'c'), cell(1, 1, 'd')],
      columnWidths: new Map<number, number>([
        [0, 80],
        [1, 120],
      ]),
      rowHeights: new Map<number, number>([
        [0, 30],
        [1, 24],
      ]),
    }
    const html = encodeSelectionAsHtml(input)
    expect(html).toContain('<colgroup>')
    expect(html).toContain('<col style="width: 80px">')
    expect(html).toContain('<col style="width: 120px">')
    expect(html).toContain('<tr style="height: 30px">')
    expect(html).toContain('<tr style="height: 24px">')
  })
})
