import { atom } from '@einfach/core'

// View chrome visibility toggles. Default to true (everything visible).
// Wired up to View menu items: Show Gridlines / Show Headings / Show Formula Bar.

export const viewportShowGridlinesAtom = atom<boolean>(true)
viewportShowGridlinesAtom.debugLabel = 'spreadsheet.viewport.showGridlines'

export const viewportShowHeadingsAtom = atom<boolean>(true)
viewportShowHeadingsAtom.debugLabel = 'spreadsheet.viewport.showHeadings'

export const viewportShowFormulaBarAtom = atom<boolean>(true)
viewportShowFormulaBarAtom.debugLabel = 'spreadsheet.viewport.showFormulaBar'

export const toggleGridlinesAtom = atom(
  (get) => get(viewportShowGridlinesAtom),
  (get, set) => {
    set(viewportShowGridlinesAtom, !get(viewportShowGridlinesAtom))
  },
)
toggleGridlinesAtom.debugLabel = 'spreadsheet.viewport.toggleGridlines'

export const toggleHeadingsAtom = atom(
  (get) => get(viewportShowHeadingsAtom),
  (get, set) => {
    set(viewportShowHeadingsAtom, !get(viewportShowHeadingsAtom))
  },
)
toggleHeadingsAtom.debugLabel = 'spreadsheet.viewport.toggleHeadings'

export const toggleFormulaBarAtom = atom(
  (get) => get(viewportShowFormulaBarAtom),
  (get, set) => {
    set(viewportShowFormulaBarAtom, !get(viewportShowFormulaBarAtom))
  },
)
toggleFormulaBarAtom.debugLabel = 'spreadsheet.viewport.toggleFormulaBar'
