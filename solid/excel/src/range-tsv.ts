type SparseRangeCell = {
  row: number
  col: number
  kind: 'number' | 'text' | 'boolean' | 'error' | 'formula'
  value: string | number | boolean
}

type SparseRangeBounds = {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

function sparseCellField(cell: SparseRangeCell): string {
  if (cell.kind === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  return String(cell.value)
}

export function sparseRangeToTSV(cells: SparseRangeCell[], range: SparseRangeBounds): string {
  const fields = new Map<string, string>()
  for (const cell of cells) {
    if (
      cell.row < range.startRow ||
      cell.row > range.endRow ||
      cell.col < range.startCol ||
      cell.col > range.endCol
    ) {
      continue
    }
    fields.set(`${cell.row}:${cell.col}`, sparseCellField(cell))
  }

  const rows: string[] = []
  for (let row = range.startRow; row <= range.endRow; row++) {
    const out: string[] = []
    for (let col = range.startCol; col <= range.endCol; col++) {
      out.push(fields.get(`${row}:${col}`) ?? '')
    }
    rows.push(out.join('\t'))
  }
  return rows.join('\n')
}
