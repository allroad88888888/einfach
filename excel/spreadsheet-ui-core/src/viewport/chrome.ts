import { atom, type Atom } from '@einfach/core'

// View chrome visibility toggles. Default to true (everything visible).
// Wired up to View menu items: Show Gridlines / Show Headings / Show Formula Bar.

const viewportShowGridlinesBackingAtom = atom<boolean>(true)
viewportShowGridlinesBackingAtom.debugLabel = 'spreadsheet.viewport.showGridlinesBacking'

export const viewportShowGridlinesAtom: Atom<boolean> = atom((get) =>
  get(viewportShowGridlinesBackingAtom),
)
viewportShowGridlinesAtom.debugLabel = 'spreadsheet.viewport.showGridlines'

const viewportShowHeadingsBackingAtom = atom<boolean>(true)
viewportShowHeadingsBackingAtom.debugLabel = 'spreadsheet.viewport.showHeadingsBacking'

export const viewportShowHeadingsAtom: Atom<boolean> = atom((get) =>
  get(viewportShowHeadingsBackingAtom),
)
viewportShowHeadingsAtom.debugLabel = 'spreadsheet.viewport.showHeadings'

const viewportShowFormulaBarBackingAtom = atom<boolean>(true)
viewportShowFormulaBarBackingAtom.debugLabel = 'spreadsheet.viewport.showFormulaBarBacking'

export const viewportShowFormulaBarAtom: Atom<boolean> = atom((get) =>
  get(viewportShowFormulaBarBackingAtom),
)
viewportShowFormulaBarAtom.debugLabel = 'spreadsheet.viewport.showFormulaBar'

export const toggleGridlinesAtom = atom(
  (get) => get(viewportShowGridlinesBackingAtom),
  (get, set) => {
    set(viewportShowGridlinesBackingAtom, !get(viewportShowGridlinesBackingAtom))
  },
)
toggleGridlinesAtom.debugLabel = 'spreadsheet.viewport.toggleGridlines'

export const toggleHeadingsAtom = atom(
  (get) => get(viewportShowHeadingsBackingAtom),
  (get, set) => {
    set(viewportShowHeadingsBackingAtom, !get(viewportShowHeadingsBackingAtom))
  },
)
toggleHeadingsAtom.debugLabel = 'spreadsheet.viewport.toggleHeadings'

export const toggleFormulaBarAtom = atom(
  (get) => get(viewportShowFormulaBarBackingAtom),
  (get, set) => {
    set(viewportShowFormulaBarBackingAtom, !get(viewportShowFormulaBarBackingAtom))
  },
)
toggleFormulaBarAtom.debugLabel = 'spreadsheet.viewport.toggleFormulaBar'
