import { atom } from '@einfach/core'
import type { CapturedFormat, FormatPainterState } from './types'

export * from './types'

export const formatPainterStateAtom = atom<FormatPainterState>('idle')
formatPainterStateAtom.debugLabel = 'spreadsheet.formatPainter.state'

export const formatPainterClipboardAtom = atom<CapturedFormat | null>(null)
formatPainterClipboardAtom.debugLabel = 'spreadsheet.formatPainter.clipboard'

export const armFormatPainterAtom = atom(
  null,
  (_get, set, captured: CapturedFormat) => {
    set(formatPainterClipboardAtom, captured)
    set(formatPainterStateAtom, 'armed')
  },
)
armFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.arm'

export const armFormatPainterStickyAtom = atom(
  null,
  (_get, set, captured: CapturedFormat) => {
    set(formatPainterClipboardAtom, captured)
    set(formatPainterStateAtom, 'sticky')
  },
)
armFormatPainterStickyAtom.debugLabel = 'spreadsheet.formatPainter.armSticky'

export const exitFormatPainterAtom = atom(
  null,
  (_get, set) => {
    set(formatPainterStateAtom, 'idle')
    set(formatPainterClipboardAtom, null)
  },
)
exitFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.exit'

export const applyFormatPainterAtom = atom(
  (get) => get(formatPainterClipboardAtom),
  (get, set): boolean => {
    const state = get(formatPainterStateAtom)
    const clipboard = get(formatPainterClipboardAtom)
    if (state === 'idle' || clipboard === null) {
      return false
    }
    if (state === 'armed') {
      set(formatPainterStateAtom, 'idle')
      set(formatPainterClipboardAtom, null)
    }
    return true
  },
)
applyFormatPainterAtom.debugLabel = 'spreadsheet.formatPainter.apply'
