import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  capturePasteSpecialCapabilityAtom,
  copyClipboardAtom,
  dispatchKeyboardInputAtom,
  openPasteSpecialAtom,
  pasteSpecialCapabilityAtom,
  pasteSpecialOpenAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
  setWorkspaceActiveSheetAtom,
  type PasteSpecialControllerPort,
} from '../src'

/**
 * The keyboard package stays a pure intent translator. These tests model the
 * host's intent route and prove that its gate reads Core's canonical
 * capability before opening a Paste Special session.
 */
describe('paste-special keyboard wiring', () => {
  function seedPasteSpecialContext(store: ReturnType<typeof createStore>) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
    })
  }

  test('unsupported canonical capability leaves Ctrl+Alt+V inert', () => {
    const store = createStore()
    seedPasteSpecialContext(store)

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.pasteSpecial' })
    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(false)

    if (intent.type === 'clipboard.pasteSpecial' && store.getter(pasteSpecialCapabilityAtom)) {
      store.setter(openPasteSpecialAtom)
    }

    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })

  test('supported canonical capability lets Ctrl+Alt+V open without invoking transport', () => {
    const store = createStore()
    seedPasteSpecialContext(store)
    let pasteRangeCalls = 0
    const port: PasteSpecialControllerPort = {
      async pasteRange(request) {
        pasteRangeCalls += 1
        return {
          kind: 'paste-range',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: request.revision,
          affectedRange: request.target,
        }
      },
    }
    store.setter(capturePasteSpecialCapabilityAtom, port)

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'v',
      ctrlKey: true,
      altKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.pasteSpecial' })
    expect(store.getter(pasteSpecialCapabilityAtom)).toBe(true)

    if (intent.type === 'clipboard.pasteSpecial' && store.getter(pasteSpecialCapabilityAtom)) {
      store.setter(openPasteSpecialAtom)
    }

    expect(store.getter(pasteSpecialOpenAtom)).toBe(true)
    expect(pasteRangeCalls).toBe(0)
  })

  test('plain Ctrl+V does not trigger paste-special', () => {
    const store = createStore()
    seedPasteSpecialContext(store)

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: 'v',
      ctrlKey: true,
    })
    expect(intent).toEqual({ type: 'clipboard.paste' })
    expect(store.getter(pasteSpecialOpenAtom)).toBe(false)
  })
})
