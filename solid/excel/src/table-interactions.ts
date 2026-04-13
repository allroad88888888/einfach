import { createSignal } from 'solid-js'
import { colIndexToLetters, parseAddr, shiftFormulaInput } from './js-sheet/index'
import type { SheetStore } from './sheet-store'
import type { WorkbookSnapshot } from './types'
import type { WorkbookStore } from './workbook-store'

export type SelectionRange = {
  anchor: string
  focus: string
}

export type ClipboardSnapshot = {
  width: number
  height: number
  sourceTopLeft: string
  cells: Array<{
    addr: string
    rowOffset: number
    colOffset: number
    input: string
  }>
  preferInternalPaste: boolean
}

export type HistoryEntry = {
  kind: string
  focusAddr?: string
  undo: () => void
  redo: () => void
}

type TableStore = SheetStore | WorkbookStore
type SizeGetter = number | (() => number)

type SelectionEdges = {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

function addrFromCoords(row: number, col: number): string {
  return `${colIndexToLetters(col)}${row + 1}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getRangeBounds(range: SelectionRange) {
  const anchor = parseAddr(range.anchor)
  const focus = parseAddr(range.focus)
  return {
    minRow: Math.min(anchor.row, focus.row),
    maxRow: Math.max(anchor.row, focus.row),
    minCol: Math.min(anchor.col, focus.col),
    maxCol: Math.max(anchor.col, focus.col),
  }
}

function getRangeAddresses(range: SelectionRange): string[] {
  const { minRow, maxRow, minCol, maxCol } = getRangeBounds(range)
  const addresses: string[] = []
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      addresses.push(addrFromCoords(row, col))
    }
  }
  return addresses
}

function sameSnapshot(
  left: Array<{ addr: string; input: string }>,
  right: Array<{ addr: string; input: string }>,
) {
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry.addr === right[index].addr && entry.input === right[index].input)
}

function buildClipboardSnapshot(store: TableStore, range: SelectionRange): ClipboardSnapshot {
  const { minRow, minCol } = getRangeBounds(range)
  const addresses = getRangeAddresses(range)

  return {
    width: getRangeBounds(range).maxCol - minCol + 1,
    height: getRangeBounds(range).maxRow - minRow + 1,
    sourceTopLeft: addrFromCoords(minRow, minCol),
    preferInternalPaste: true,
    cells: addresses.map((addr) => {
      const coords = parseAddr(addr)
      return {
        addr,
        rowOffset: coords.row - minRow,
        colOffset: coords.col - minCol,
        input: store.getInput(addr),
      }
    }),
  }
}

function snapshotToTSV(snapshot: ClipboardSnapshot): string {
  const rows = Array.from({ length: snapshot.height }, () => Array.from({ length: snapshot.width }, () => ''))
  for (const cell of snapshot.cells) {
    rows[cell.rowOffset][cell.colOffset] = cell.input
  }
  return rows.map((row) => row.join('\t')).join('\n')
}

function parseTSV(text: string): ClipboardSnapshot {
  const normalized = text.replace(/\r\n/g, '\n')
  const rows = normalized.split('\n')
  if (rows.length > 1 && rows[rows.length - 1] === '') {
    rows.pop()
  }

  const matrix = rows.map((row) => row.split('\t'))
  const width = Math.max(...matrix.map((row) => row.length), 1)

  return {
    width,
    height: Math.max(matrix.length, 1),
    sourceTopLeft: 'A1',
    preferInternalPaste: false,
    cells: matrix.flatMap((row, rowIndex) =>
      row.map((input, colIndex) => ({
        addr: addrFromCoords(rowIndex, colIndex),
        rowOffset: rowIndex,
        colOffset: colIndex,
        input,
      })),
    ),
  }
}

async function writeClipboardText(text: string) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    }
  } catch {
    // Ignore clipboard permission errors in tests or unsupported environments.
  }
}

async function readClipboardText(): Promise<string | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText()
    }
  } catch {
    return null
  }
  return null
}

export function createTableInteractions(store: TableStore, rows: SizeGetter, cols: SizeGetter) {
  const initialSelection = 'A1'
  const [selectedCell, setSelectedCell] = createSignal(initialSelection)
  const [selectionRange, setSelectionRange] = createSignal<SelectionRange>({
    anchor: initialSelection,
    focus: initialSelection,
  })
  const [editingCell, setEditingCell] = createSignal<string | null>(null)
  const [clipboard, setClipboard] = createSignal<ClipboardSnapshot | null>(null)
  const [undoStack, setUndoStack] = createSignal<HistoryEntry[]>([])
  const [redoStack, setRedoStack] = createSignal<HistoryEntry[]>([])

  const rowCount = () => typeof rows === 'function' ? rows() : rows
  const colCount = () => typeof cols === 'function' ? cols() : cols

  function selectionTopLeft() {
    const bounds = getRangeBounds(selectionRange())
    return addrFromCoords(bounds.minRow, bounds.minCol)
  }

  function currentAddresses() {
    return getRangeAddresses(selectionRange())
  }

  function pushHistory(entry: HistoryEntry) {
    setUndoStack((stack) => [...stack, entry])
    setRedoStack([])
  }

  function pushInputHistory(
    kind: string,
    before: Array<{ addr: string; input: string }>,
    after: Array<{ addr: string; input: string }>,
    focusAddr?: string,
  ) {
    if (sameSnapshot(before, after)) return
    pushHistory({
      kind,
      focusAddr,
      undo: () => {
        store.batchSetInputs(before)
      },
      redo: () => {
        store.batchSetInputs(after)
      },
    })
  }

  function recordSnapshotChange(
    kind: string,
    before: WorkbookSnapshot,
    after: WorkbookSnapshot,
    focusAddr?: string,
  ) {
    const snapshotStore = store as WorkbookStore
    if (!snapshotStore.restoreSnapshot) return
    pushHistory({
      kind,
      focusAddr,
      undo: () => snapshotStore.restoreSnapshot(before),
      redo: () => snapshotStore.restoreSnapshot(after),
    })
  }

  function select(addr: string, extend = false) {
    setSelectedCell(addr)
    if (extend) {
      setSelectionRange((current) => ({
        anchor: current.anchor,
        focus: addr,
      }))
    } else {
      setSelectionRange({
        anchor: addr,
        focus: addr,
      })
    }
  }

  function moveSelection(rowDelta: number, colDelta: number, extend = false) {
    const base = parseAddr(selectedCell())
    const nextRow = clamp(base.row + rowDelta, 0, rowCount() - 1)
    const nextCol = clamp(base.col + colDelta, 0, colCount() - 1)
    select(addrFromCoords(nextRow, nextCol), extend)
  }

  function isSelected(addr: string) {
    return selectedCell() === addr
  }

  function isInSelection(addr: string) {
    const coords = parseAddr(addr)
    const bounds = getRangeBounds(selectionRange())
    return (
      coords.row >= bounds.minRow
      && coords.row <= bounds.maxRow
      && coords.col >= bounds.minCol
      && coords.col <= bounds.maxCol
    )
  }

  function selectionEdges(addr: string): SelectionEdges {
    const coords = parseAddr(addr)
    const bounds = getRangeBounds(selectionRange())
    return {
      top: coords.row === bounds.minRow,
      right: coords.col === bounds.maxCol,
      bottom: coords.row === bounds.maxRow,
      left: coords.col === bounds.minCol,
    }
  }

  function commitEdit(addr: string, input: string) {
    const before = store.getInputSnapshot([addr])
    store.batchSetInputs([{ addr, input }])
    const after = store.getInputSnapshot([addr])
    pushInputHistory('edit', before, after, addr)
    setEditingCell(null)
    select(addr)
  }

  function cancelEdit() {
    setEditingCell(null)
  }

  function clearSelection() {
    const addresses = currentAddresses()
    const before = store.getInputSnapshot(addresses)
    const updates = addresses.map((addr) => ({ addr, input: '' }))
    store.batchSetInputs(updates)
    const after = store.getInputSnapshot(addresses)
    pushInputHistory('clear', before, after, addresses[0])
  }

  async function copySelection() {
    const snapshot = buildClipboardSnapshot(store, selectionRange())
    setClipboard(snapshot)
    await writeClipboardText(snapshotToTSV(snapshot))
  }

  async function cutSelection() {
    const snapshot = buildClipboardSnapshot(store, selectionRange())
    setClipboard(snapshot)
    await writeClipboardText(snapshotToTSV(snapshot))

    const addresses = snapshot.cells.map((cell) => cell.addr)
    const before = store.getInputSnapshot(addresses)
    const updates = addresses.map((addr) => ({ addr, input: '' }))
    store.batchSetInputs(updates)
    const after = store.getInputSnapshot(addresses)
    pushInputHistory('cut', before, after, addresses[0])
  }

  async function pasteSelection() {
    let snapshot = clipboard()
    if (!snapshot?.preferInternalPaste) {
      const text = await readClipboardText()
      if (text !== null) {
        snapshot = parseTSV(text)
      }
    }

    if (!snapshot) return

    const source = parseAddr(snapshot.sourceTopLeft)
    const target = parseAddr(selectionTopLeft())
    const rowDelta = target.row - source.row
    const colDelta = target.col - source.col

    const updates = snapshot.cells.map((cell) => {
      const targetAddr = addrFromCoords(target.row + cell.rowOffset, target.col + cell.colOffset)
      const input = cell.input.startsWith('=')
        ? (snapshot.preferInternalPaste ? shiftFormulaInput(cell.input, rowDelta, colDelta) ?? cell.input : cell.input)
        : cell.input
      return {
        addr: targetAddr,
        input,
      }
    })

    const before = store.getInputSnapshot(updates.map((update) => update.addr))
    store.batchSetInputs(updates)
    const after = store.getInputSnapshot(updates.map((update) => update.addr))
    pushInputHistory('paste', before, after, updates[0]?.addr)

    setClipboard(snapshot ? { ...snapshot, preferInternalPaste: false } : null)
    select(selectionTopLeft())
  }

  function applyHistory(direction: 'undo' | 'redo') {
    if (direction === 'undo') {
      const stack = undoStack()
      const entry = stack[stack.length - 1]
      if (!entry) return
      entry.undo()
      setUndoStack(stack.slice(0, -1))
      setRedoStack((current) => [...current, entry])
      select(entry.focusAddr ?? selectedCell())
      return
    }

    const stack = redoStack()
    const entry = stack[stack.length - 1]
    if (!entry) return
    entry.redo()
    setRedoStack(stack.slice(0, -1))
    setUndoStack((current) => [...current, entry])
    select(entry.focusAddr ?? selectedCell())
  }

  return {
    selectedCell,
    selectionRange,
    editingCell,
    select,
    moveSelection,
    isSelected,
    isInSelection,
    selectionEdges,
    setEditingCell,
    commitEdit,
    cancelEdit,
    clearSelection,
    copySelection,
    cutSelection,
    pasteSelection,
    recordSnapshotChange,
    selectionTopLeft,
    undo() {
      applyHistory('undo')
    },
    redo() {
      applyHistory('redo')
    },
  }
}
