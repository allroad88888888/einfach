import { atom } from '@einfach/core'
import { editingSessionAtom } from '../editing'
import { selectionAtom } from '../selection'
import { workspaceSessionAtom } from '../workspace'
import type {
  OpenToolbarDropdownInput,
  OpenToolbarPaletteInput,
  ToolbarActiveSurface,
  ToolbarAvailabilitySnapshot,
  ToolbarCommandAvailability,
  ToolbarDropdownKind,
  ToolbarFormatCommandInput,
  ToolbarFormatCommandIntent,
  ToolbarFormatCommandKind,
  ToolbarIntent,
  ToolbarPaletteKind,
  ToolbarUiState,
} from './types'

export * from './types'

export function createToolbarUiState(): ToolbarUiState {
  return {
    activeSurface: null,
  }
}

export function createToolbarSurfaceIntent(surface: ToolbarActiveSurface): ToolbarIntent {
  return {
    type: 'toolbar.surface.open',
    source: 'toolbar',
    surface,
  }
}

export function createToolbarFormatCommandIntent(
  input: ToolbarFormatCommandInput,
  snapshot: ToolbarAvailabilitySnapshot,
): ToolbarFormatCommandIntent | null {
  if (snapshot.sheetId === null) {
    return null
  }

  return {
    type: 'toolbar.format.command',
    source: 'toolbar',
    sheetId: snapshot.sheetId,
    selectionKind: snapshot.selectionKind,
    command: input.command,
    value: input.value ?? null,
  }
}

export function getToolbarCommandAvailability(
  snapshot: ToolbarAvailabilitySnapshot,
): ToolbarCommandAvailability {
  const isEditing = snapshot.editingMode === 'drafting'
  const hasSheet = snapshot.sheetId !== null
  const canFormatSelection =
    hasSheet && !isEditing && (snapshot.selectionKind === 'cell' || snapshot.selectionKind === 'range')
  const canStyleSelection = hasSheet && !isEditing && snapshot.selectionKind !== 'all'

  return {
    sheetId: snapshot.sheetId,
    selectionKind: snapshot.selectionKind,
    editingMode: snapshot.editingMode,
    bold: canStyleSelection,
    italic: canStyleSelection,
    textColor: canStyleSelection,
    fillColor: canStyleSelection,
    numberFormat: canFormatSelection,
    alignment: canStyleSelection,
    verticalAlignment: canStyleSelection,
    underline: canStyleSelection,
    strikethrough: canStyleSelection,
    wrap: canStyleSelection,
    rotation: canStyleSelection,
    indent: canStyleSelection,
    border: canStyleSelection,
    fontFamily: canStyleSelection,
    fontSize: canStyleSelection,
  }
}

export function isToolbarFormatCommandAvailable(
  command: ToolbarFormatCommandKind,
  availability: ToolbarCommandAvailability,
): boolean {
  switch (command) {
    case 'bold':
      return availability.bold
    case 'italic':
      return availability.italic
    case 'text-color':
      return availability.textColor
    case 'fill-color':
      return availability.fillColor
    case 'number-format':
      return availability.numberFormat
    case 'alignment':
      return availability.alignment
    case 'vertical-alignment':
      return availability.verticalAlignment
    case 'underline':
      return availability.underline
    case 'strikethrough':
      return availability.strikethrough
    case 'wrap':
      return availability.wrap
    case 'rotation':
      return availability.rotation
    case 'indent-increase':
    case 'indent-decrease':
      return availability.indent
    case 'border':
      return availability.border
    case 'font-family':
      return availability.fontFamily
    case 'font-size':
    case 'font-size-up':
    case 'font-size-down':
      return availability.fontSize
    default:
      return false
  }
}

export const toolbarUiStateAtom = atom<ToolbarUiState>(createToolbarUiState())
toolbarUiStateAtom.debugLabel = 'spreadsheet.toolbar.ui'

export const toolbarIntentAtom = atom<ToolbarIntent | null>(null)
toolbarIntentAtom.debugLabel = 'spreadsheet.toolbar.intent'

export const toolbarActiveSurfaceAtom = atom((get) => get(toolbarUiStateAtom).activeSurface)
toolbarActiveSurfaceAtom.debugLabel = 'spreadsheet.toolbar.activeSurface'

export const toolbarCommandAvailabilityAtom = atom((get): ToolbarCommandAvailability => {
  const selection = get(selectionAtom)
  const editing = get(editingSessionAtom)
  const workspace = get(workspaceSessionAtom)

  return getToolbarCommandAvailability({
    sheetId: workspace.activeSheetId ?? (selection.sheetId.length > 0 ? selection.sheetId : null),
    selectionKind: selection.kind,
    editingMode: editing.status,
  })
})
toolbarCommandAvailabilityAtom.debugLabel = 'spreadsheet.toolbar.commandAvailability'

export const openToolbarDropdownAtom = atom(
  (get) => get(toolbarUiStateAtom),
  (_get, set, input: OpenToolbarDropdownInput) => {
    const surface: ToolbarActiveSurface = {
      kind: 'dropdown',
      id: input.dropdown,
    }

    set(toolbarUiStateAtom, {
      activeSurface: surface,
    })
    set(toolbarIntentAtom, createToolbarSurfaceIntent(surface))
    return surface
  },
)
openToolbarDropdownAtom.debugLabel = 'spreadsheet.toolbar.openDropdown'

export const openToolbarPaletteAtom = atom(
  (get) => get(toolbarUiStateAtom),
  (_get, set, input: OpenToolbarPaletteInput) => {
    const surface: ToolbarActiveSurface = {
      kind: 'palette',
      id: input.palette,
    }

    set(toolbarUiStateAtom, {
      activeSurface: surface,
    })
    set(toolbarIntentAtom, createToolbarSurfaceIntent(surface))
    return surface
  },
)
openToolbarPaletteAtom.debugLabel = 'spreadsheet.toolbar.openPalette'

export const closeToolbarSurfaceAtom = atom(
  (get) => get(toolbarUiStateAtom),
  (_get, set) => {
    set(toolbarUiStateAtom, {
      activeSurface: null,
    })
    set(toolbarIntentAtom, {
      type: 'toolbar.surface.close',
      source: 'toolbar',
    })
    return null
  },
)
closeToolbarSurfaceAtom.debugLabel = 'spreadsheet.toolbar.closeSurface'

export const dispatchToolbarFormatCommandAtom = atom(
  (get) => get(toolbarIntentAtom),
  (get, set, input: ToolbarFormatCommandInput) => {
    const selection = get(selectionAtom)
    const workspace = get(workspaceSessionAtom)
    const availability = get(toolbarCommandAvailabilityAtom)
    const commandAvailable = isToolbarFormatCommandAvailable(input.command, availability)

    if (!commandAvailable) {
      return null
    }

    const intent = createToolbarFormatCommandIntent(
      {
        ...input,
        sheetId: input.sheetId ?? workspace.activeSheetId ?? (selection.sheetId.length > 0 ? selection.sheetId : null),
      },
      {
        sheetId: workspace.activeSheetId ?? (selection.sheetId.length > 0 ? selection.sheetId : null),
        selectionKind: selection.kind,
        editingMode: get(editingSessionAtom).status,
      },
    )

    if (intent === null) {
      return null
    }

    set(toolbarIntentAtom, intent)
    return intent
  },
)
dispatchToolbarFormatCommandAtom.debugLabel = 'spreadsheet.toolbar.dispatchFormatCommand'

export const clearToolbarIntentAtom = atom(
  (get) => get(toolbarIntentAtom),
  (_get, set) => {
    set(toolbarIntentAtom, null)
    return null
  },
)
clearToolbarIntentAtom.debugLabel = 'spreadsheet.toolbar.clearIntent'

export function isToolbarDropdownKind(value: ToolbarActiveSurface['id']): value is ToolbarDropdownKind {
  return value === 'alignment' || value === 'number-format' || value === 'border'
}

export function isToolbarPaletteKind(value: ToolbarActiveSurface['id']): value is ToolbarPaletteKind {
  return value === 'text-color' || value === 'fill-color'
}
