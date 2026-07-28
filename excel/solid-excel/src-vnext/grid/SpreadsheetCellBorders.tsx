/** @jsxImportSource solid-js */

import type {
  SpreadsheetBorders,
  SpreadsheetBorderSide,
  SpreadsheetBorderSpec,
} from '@einfach/spreadsheet-ui-core'
import { For } from 'solid-js'

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const
const DEFAULT_BORDER_COLOR = '#000000'

interface RenderedBorder {
  side: SpreadsheetBorderSide
  spec: SpreadsheetBorderSpec
  line: string
}

function getBorderLine(spec: SpreadsheetBorderSpec | undefined): string | undefined {
  if (!spec || spec.style === 'none') return undefined

  const color = spec.color ?? DEFAULT_BORDER_COLOR
  switch (spec.style) {
    case 'thin':
      return `1px solid ${color}`
    case 'medium':
      return `2px solid ${color}`
    case 'thick':
      return `3px solid ${color}`
    case 'dashed':
      return `1px dashed ${color}`
    case 'dotted':
      return `1px dotted ${color}`
    case 'double':
      return `3px double ${color}`
  }
}

function getBorderStyle(side: SpreadsheetBorderSide, line: string): Record<string, string> {
  const style: Record<string, string> = {
    position: 'absolute',
    'pointer-events': 'none',
    'z-index': '1',
  }

  if (side === 'top' || side === 'bottom') {
    style.left = '0'
    style.right = '0'
    style[side] = '0'
    style[`border-${side}`] = line
  } else {
    style.top = '0'
    style.bottom = '0'
    style[side] = '0'
    style[`border-${side}`] = line
  }

  return style
}

export function SpreadsheetCellBorders(props: { borders: SpreadsheetBorders | undefined }) {
  const renderedBorders = (): RenderedBorder[] => {
    const borders = props.borders
    if (!borders) return []

    const result: RenderedBorder[] = []
    for (const side of BORDER_SIDES) {
      const spec = borders[side]
      const line = getBorderLine(spec)
      if (spec && line) result.push({ side, spec, line })
    }
    return result
  }

  return (
    <For each={renderedBorders()}>
      {({ side, spec, line }) => (
        <span
          aria-hidden="true"
          class={`spreadsheet-grid-cell-border spreadsheet-grid-cell-border-${side}`}
          data-cell-border-side={side}
          data-border-style={spec.style}
          data-border-color={spec.color ?? DEFAULT_BORDER_COLOR}
          style={getBorderStyle(side, line)}
        />
      )}
    </For>
  )
}
