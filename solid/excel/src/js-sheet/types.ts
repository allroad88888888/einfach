export type CellType = 'number' | 'text' | 'boolean' | 'null' | 'error'

export type CellRecord = {
  type: CellType
  value: number | string | boolean | null
}

export type CellRef = {
  addr: string
  absCol: boolean
  absRow: boolean
  invalid?: boolean
  sheetName?: string
}

export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error'; value: string }
  | { kind: 'cell'; ref: CellRef }
  | { kind: 'range'; start: CellRef; end: CellRef }
  | {
      kind: 'binop'
      op: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>='
      left: Expr
      right: Expr
    }
  | { kind: 'negate'; expr: Expr }
  | { kind: 'func'; name: string; args: Expr[] }
