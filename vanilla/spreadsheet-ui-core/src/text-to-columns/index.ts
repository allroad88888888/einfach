import { atom } from '@einfach/core'
import type {
  ImportCellPlan,
  TextToColumnsColumnFormat,
  TextToColumnsCommitPlan,
  TextToColumnsDelimitedConfig,
  TextToColumnsDelimiter,
  TextToColumnsFixedConfig,
  TextToColumnsMode,
  TextToColumnsPreviewRow,
  TextToColumnsSourceRow,
  TextToColumnsTextQualifier,
  TextToColumnsWizardState,
} from './types'
import type { CellCoord } from '../shared'

export * from './types'

/**
 * Bounded cache caps: the preview pane shows at most the first
 * `TEXT_TO_COLUMNS_PREVIEW_CAP` source rows tokenized with the active
 * wizard config, and emits at most
 * `TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP` tokens across the whole preview
 * grid. The token cap protects the renderer against a single
 * pathological row carrying 10k+ delimiters — without it a 100-row
 * preview could explode into millions of DOM cells. When a row is
 * truncated mid-flight we append a `'…'` sentinel so the user can see
 * the cut visually. Documented in `text-to-columns/README.md`.
 */
export const TEXT_TO_COLUMNS_PREVIEW_CAP = 100
export const TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP = 500
/**
 * Sentinel appended to a row whose tokens were truncated by the token
 * cap. Renderers can show this verbatim — it carries no semantic value
 * and is not part of the commit plan.
 */
export const TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK = '…'

export const DEFAULT_DELIMITED_CONFIG: TextToColumnsDelimitedConfig = {
  delimiters: new Set<TextToColumnsDelimiter>(['tab']),
  otherChar: '',
  treatConsecutiveAsOne: false,
  textQualifier: '"',
}

export const DEFAULT_FIXED_CONFIG: TextToColumnsFixedConfig = {
  breakpoints: [],
}

export const INITIAL_WIZARD_STATE: TextToColumnsWizardState = {
  step: 'step-1',
  mode: 'delimited',
}

// --- source ---

/**
 * Lines of the source single-column selection (top-to-bottom). The host
 * dialog populates this immediately after `openTextToColumnsAtom` and
 * clears it on close. Storing it in an atom keeps per-instance dialog
 * state out of `let` locals so the Solid 1.9.12 Provider remount hazard
 * does not strand it.
 */
export const textToColumnsSourceAtom = atom<readonly TextToColumnsSourceRow[]>([])
textToColumnsSourceAtom.debugLabel = 'spreadsheet.textToColumns.source'

/**
 * Anchor coordinate (top-left of the source column). Used at commit time
 * to assemble the import plan.
 */
export const textToColumnsAnchorAtom = atom<CellCoord | null>(null)
textToColumnsAnchorAtom.debugLabel = 'spreadsheet.textToColumns.anchor'

export const textToColumnsSheetIdAtom = atom<string | null>(null)
textToColumnsSheetIdAtom.debugLabel = 'spreadsheet.textToColumns.sheetId'

// --- ui ---

export const textToColumnsOpenAtom = atom<boolean>(false)
textToColumnsOpenAtom.debugLabel = 'spreadsheet.textToColumns.open'

export const textToColumnsWizardAtom = atom<TextToColumnsWizardState>({
  ...INITIAL_WIZARD_STATE,
})
textToColumnsWizardAtom.debugLabel = 'spreadsheet.textToColumns.wizard'

// --- derived ---

export const textToColumnsPreviewAtom = atom((get): readonly TextToColumnsPreviewRow[] => {
  const source = get(textToColumnsSourceAtom)
  const wizard = get(textToColumnsWizardAtom)
  const config = effectiveConfig(wizard)
  const capped = source.slice(0, TEXT_TO_COLUMNS_PREVIEW_CAP)

  // Token-cap pass: cumulatively budget tokens across rows so a single
  // pathological row cannot blow the renderer. Once the budget is
  // exhausted we still emit subsequent rows (so the user keeps row
  // anchoring) but with an empty token list — except the first
  // truncated row, which gets a single `…` marker.
  const out: TextToColumnsPreviewRow[] = []
  let budget = TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP
  for (const row of capped) {
    if (budget <= 0) {
      out.push({ sourceRow: row.sourceRow, tokens: [] })
      continue
    }
    const tokens = tokenize(row.text, config)
    if (tokens.length <= budget) {
      out.push({ sourceRow: row.sourceRow, tokens })
      budget -= tokens.length
      continue
    }
    const sliced = tokens.slice(0, budget)
    sliced.push(TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK)
    out.push({ sourceRow: row.sourceRow, tokens: sliced })
    budget = 0
  }
  return out
})
textToColumnsPreviewAtom.debugLabel = 'spreadsheet.textToColumns.preview'

// --- commands ---

export interface OpenTextToColumnsPayload {
  sheetId: string
  anchor: CellCoord
  rows: readonly TextToColumnsSourceRow[]
}

export const openTextToColumnsAtom = atom(
  null,
  (_get, set, payload: OpenTextToColumnsPayload) => {
    set(textToColumnsSheetIdAtom, payload.sheetId)
    set(textToColumnsAnchorAtom, payload.anchor)
    set(textToColumnsSourceAtom, payload.rows.slice())
    set(textToColumnsWizardAtom, { ...INITIAL_WIZARD_STATE })
    set(textToColumnsOpenAtom, true)
  },
)
openTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.open.command'

export const closeTextToColumnsAtom = atom(null, (_get, set) => {
  set(textToColumnsOpenAtom, false)
  set(textToColumnsWizardAtom, { ...INITIAL_WIZARD_STATE })
  set(textToColumnsSourceAtom, [])
  set(textToColumnsAnchorAtom, null)
  set(textToColumnsSheetIdAtom, null)
})
closeTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.close'

/**
 * Write-only command. Returns the assembled `TextToColumnsCommitPlan` so
 * the host adapter can forward it through `importCellChunks`. Returns
 * `null` when the wizard is not on the final step or when source/anchor
 * are missing.
 */
export const confirmTextToColumnsAtom = atom(
  null,
  (get, _set): TextToColumnsCommitPlan | null => {
    const wizard = get(textToColumnsWizardAtom)
    const source = get(textToColumnsSourceAtom)
    const anchor = get(textToColumnsAnchorAtom)
    const sheetId = get(textToColumnsSheetIdAtom)
    if (!anchor || !sheetId) return null
    if (wizard.step !== 'step-3') return null

    const config: EffectiveConfig = {
      mode: wizard.mode,
      delimited: wizard.delimited,
      fixed: wizard.fixed,
    }
    const formats = wizard.formats
    const cells: ImportCellPlan[] = []
    const keepIndices: number[] = []
    for (let i = 0; i < formats.length; i += 1) {
      if (formats[i] !== 'skip') keepIndices.push(i)
    }

    // Always rewrite the full source column so undo restores the full text
    // in a single step. Tokens missing for a row land as empty strings.
    for (const row of source) {
      const tokens = tokenize(row.text, config)
      let outputCol = 0
      for (const sourceTokenIndex of keepIndices) {
        const fmt = formats[sourceTokenIndex]
        const token = tokens[sourceTokenIndex] ?? ''
        const cell: ImportCellPlan = {
          row: row.sourceRow,
          col: anchor.col + outputCol,
          input: token,
        }
        if (fmt === 'text') cell.preserveAsText = true
        // 'date' is currently degraded to 'general' (no preserveAsText)
        // because date parsing is not yet wired through the backend port.
        // The Step 3 UI surfaces this by disabling the Date option with a
        // tooltip. TODO(text-to-columns): emit a typed date cell when we
        // add a date input channel.
        cells.push(cell)
        outputCol += 1
      }
    }

    return {
      sheetId,
      anchor: { row: anchor.row, col: anchor.col },
      sourceRange: {
        rowStart: anchor.row,
        rowEnd: anchor.row + Math.max(0, source.length - 1),
        colStart: anchor.col,
        colEnd: anchor.col,
      },
      outputColumnCount: keepIndices.length,
      cells,
    }
  },
)
confirmTextToColumnsAtom.debugLabel = 'spreadsheet.textToColumns.commit'

// --- helpers ---

interface EffectiveConfig {
  mode: TextToColumnsMode
  delimited: TextToColumnsDelimitedConfig
  fixed: TextToColumnsFixedConfig
}

function effectiveConfig(state: TextToColumnsWizardState): EffectiveConfig {
  switch (state.step) {
    case 'step-1':
      return {
        mode: state.mode,
        delimited: DEFAULT_DELIMITED_CONFIG,
        fixed: DEFAULT_FIXED_CONFIG,
      }
    case 'step-2-delimited':
      return {
        mode: 'delimited',
        delimited: state.delimited,
        fixed: DEFAULT_FIXED_CONFIG,
      }
    case 'step-2-fixed':
      return {
        mode: 'fixed',
        delimited: DEFAULT_DELIMITED_CONFIG,
        fixed: state.fixed,
      }
    case 'step-3':
      return {
        mode: state.mode,
        delimited: state.delimited,
        fixed: state.fixed,
      }
  }
}

/**
 * Resolve a delimiter token to its literal character. `other` returns the
 * configured `otherChar` (already validated to length 1 by the dialog).
 */
function delimiterChar(
  delimiter: TextToColumnsDelimiter,
  otherChar: string,
): string {
  switch (delimiter) {
    case 'tab':
      return '\t'
    case 'semicolon':
      return ';'
    case 'comma':
      return ','
    case 'space':
      return ' '
    case 'other':
      return otherChar.length > 0 ? otherChar.charAt(0) : ''
  }
}

/**
 * Tokenize a single source row with the active wizard config. Pure: same
 * input ↔ same output. Used by both the preview and the commit-plan
 * builder.
 *
 * Delimited mode honors `textQualifier` (strips outer + unescapes doubled
 * inner quotes) and `treatConsecutiveAsOne` (collapses runs of delimiters
 * into a single split). Fixed mode slices by character offset, padding
 * with empty strings when the row is shorter than the rightmost breakpoint.
 */
export function tokenize(text: string, config: EffectiveConfig): string[] {
  if (config.mode === 'fixed') {
    return tokenizeFixed(text, config.fixed.breakpoints)
  }
  return tokenizeDelimited(text, config.delimited)
}

function tokenizeFixed(text: string, breakpoints: readonly number[]): string[] {
  if (breakpoints.length === 0) return [text]
  const sorted = [...breakpoints].sort((a, b) => a - b).filter((b) => b > 0)
  const cuts = [0, ...sorted]
  const tokens: string[] = []
  for (let i = 0; i < cuts.length; i += 1) {
    const start = cuts[i]
    const end = i + 1 < cuts.length ? cuts[i + 1] : text.length
    if (start >= text.length) {
      tokens.push('')
    } else {
      tokens.push(text.slice(start, Math.min(end, text.length)))
    }
  }
  return tokens
}

function tokenizeDelimited(text: string, config: TextToColumnsDelimitedConfig): string[] {
  const chars = new Set<string>()
  for (const d of config.delimiters) {
    const c = delimiterChar(d, config.otherChar)
    if (c.length > 0) chars.add(c)
  }
  if (chars.size === 0) return [text]

  const qualifier = config.textQualifier === 'none' ? '' : config.textQualifier
  const tokens: string[] = []
  let current = ''
  // Excel/Sheets semantics: the qualifier is only honored when it appears
  // at the start of a field (immediately after a delimiter or at row
  // start). Mid-field qualifier characters are kept as literals.
  let inQualifier = false
  let fieldStart = true
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    if (qualifier && ch === qualifier) {
      if (inQualifier) {
        // Doubled qualifier inside a qualified token escapes to one literal.
        if (text[i + 1] === qualifier) {
          current += qualifier
          i += 2
          continue
        }
        // Closing qualifier. Any subsequent non-delimiter characters are
        // appended verbatim until the next delimiter (Excel/Sheets behavior).
        inQualifier = false
        fieldStart = false
        i += 1
        continue
      }
      if (fieldStart) {
        // Opening qualifier at field start.
        inQualifier = true
        fieldStart = false
        i += 1
        continue
      }
      // Mid-field qualifier — treat as literal character.
      current += ch
      fieldStart = false
      i += 1
      continue
    }
    if (!inQualifier && chars.has(ch)) {
      tokens.push(current)
      current = ''
      i += 1
      if (config.treatConsecutiveAsOne) {
        while (i < text.length && chars.has(text[i])) i += 1
      }
      fieldStart = true
      continue
    }
    current += ch
    fieldStart = false
    i += 1
  }
  tokens.push(current)
  return tokens
}

// --- step navigation helpers (pure) ---

/**
 * Compute how many columns the preview produces under the current config.
 * Used by the dialog to size the Step 3 format selector. Mirrors the
 * commit-plan builder: max token count across the (capped) preview.
 */
export function previewColumnCount(rows: readonly TextToColumnsPreviewRow[]): number {
  let max = 1
  for (const row of rows) {
    if (row.tokens.length > max) max = row.tokens.length
  }
  return max
}

export function makeStepTwoState(
  mode: TextToColumnsMode,
  delimited?: TextToColumnsDelimitedConfig,
  fixed?: TextToColumnsFixedConfig,
): TextToColumnsWizardState {
  if (mode === 'delimited') {
    return {
      step: 'step-2-delimited',
      mode: 'delimited',
      delimited: delimited ?? { ...DEFAULT_DELIMITED_CONFIG },
    }
  }
  return {
    step: 'step-2-fixed',
    mode: 'fixed',
    fixed: fixed ?? { ...DEFAULT_FIXED_CONFIG },
  }
}

export function makeStepThreeState(
  mode: TextToColumnsMode,
  columnCount: number,
  delimited: TextToColumnsDelimitedConfig,
  fixed: TextToColumnsFixedConfig,
  prevFormats?: readonly TextToColumnsColumnFormat[],
): TextToColumnsWizardState {
  const formats: TextToColumnsColumnFormat[] = []
  for (let i = 0; i < columnCount; i += 1) {
    formats.push(prevFormats?.[i] ?? 'general')
  }
  return {
    step: 'step-3',
    mode,
    delimited,
    fixed,
    formats,
  }
}

export type { TextToColumnsTextQualifier }
