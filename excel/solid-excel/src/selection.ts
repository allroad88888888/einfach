/** Cell coordinate. Both 0-based. */
export interface CellCoord {
  row: number
  col: number
}

/** 0-based col → letters: 0→A, 25→Z, 26→AA */
export function colToLetter(col: number): string {
  let result = ''
  let c = col
  do {
    result = String.fromCharCode(65 + (c % 26)) + result
    c = Math.floor(c / 26) - 1
  } while (c >= 0)
  return result
}

/** Letters → 0-based col index. Returns -1 on invalid input. */
export function letterToCol(letters: string): number {
  if (!letters) return -1
  let col = 0
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64 // 'A' → 1
    if (code < 1 || code > 26) return -1
    col = col * 26 + code
  }
  return col - 1
}

/** Build cell address from coord: (0,0) → "A1" */
export function coordToAddr(c: CellCoord): string {
  return `${colToLetter(c.col)}${c.row + 1}`
}

/** Parse "A1" → coord, or null on invalid input. */
export function addrToCoord(addr: string): CellCoord | null {
  const m = addr.trim().match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return null
  const col = letterToCol(m[1])
  if (col < 0) return null
  const row = parseInt(m[2], 10) - 1
  if (!Number.isFinite(row) || row < 0) return null
  return { row, col }
}

/** Clamp a coord to a [0, rows)×[0, cols) bounds. */
export function clampCoord(c: CellCoord, rows: number, cols: number): CellCoord {
  return {
    row: Math.max(0, Math.min(rows - 1, c.row)),
    col: Math.max(0, Math.min(cols - 1, c.col)),
  }
}
