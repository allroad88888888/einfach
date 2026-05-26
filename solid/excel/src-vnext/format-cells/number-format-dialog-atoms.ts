import { atom } from '@einfach/core'
import type {
  CellRange,
  SpreadsheetCellFormat,
  SpreadsheetNumberFormat,
} from '@einfach/spreadsheet-ui-core'

export type NumberFormatDialogKind = 'currency' | 'dateTime' | 'number'

export interface CurrencyFormatOption {
  id: string
  labelKey: string
  symbol: string
  pos?: 'before' | 'after'
}

export interface PatternFormatOption {
  id: string
  exampleKey: string
  pattern: string
  numberFormat: SpreadsheetNumberFormat
}

export const CURRENCY_FORMAT_OPTIONS: readonly CurrencyFormatOption[] = [
  { id: 'cny', labelKey: 'numberFormatDialog.currency.cny', symbol: '¥' },
  { id: 'usd', labelKey: 'numberFormatDialog.currency.usd', symbol: '$' },
  { id: 'eur', labelKey: 'numberFormatDialog.currency.eur', symbol: '€' },
  { id: 'gbp', labelKey: 'numberFormatDialog.currency.gbp', symbol: '£' },
  { id: 'hkd', labelKey: 'numberFormatDialog.currency.hkd', symbol: '$' },
  { id: 'jpy', labelKey: 'numberFormatDialog.currency.jpy', symbol: '¥' },
  { id: 'all', labelKey: 'numberFormatDialog.currency.all', symbol: 'Lek' },
  { id: 'rsd', labelKey: 'numberFormatDialog.currency.rsd', symbol: 'din' },
  { id: 'afn', labelKey: 'numberFormatDialog.currency.afn', symbol: 'Af', pos: 'after' },
  { id: 'ars', labelKey: 'numberFormatDialog.currency.ars', symbol: '$' },
  { id: 'aed', labelKey: 'numberFormatDialog.currency.aed', symbol: 'dh' },
  { id: 'awg', labelKey: 'numberFormatDialog.currency.awg', symbol: 'Afl' },
  { id: 'omr', labelKey: 'numberFormatDialog.currency.omr', symbol: 'Rial' },
  { id: 'egp', labelKey: 'numberFormatDialog.currency.egp', symbol: '£' },
  { id: 'etb', labelKey: 'numberFormatDialog.currency.etb', symbol: 'Birr' },
  { id: 'aoa', labelKey: 'numberFormatDialog.currency.aoa', symbol: 'Kz' },
  { id: 'aud', labelKey: 'numberFormatDialog.currency.aud', symbol: '$' },
  { id: 'mop', labelKey: 'numberFormatDialog.currency.mop', symbol: 'MOP' },
  { id: 'bbd', labelKey: 'numberFormatDialog.currency.bbd', symbol: '$' },
  { id: 'pgk', labelKey: 'numberFormatDialog.currency.pgk', symbol: 'PGK' },
  { id: 'bsd', labelKey: 'numberFormatDialog.currency.bsd', symbol: '$' },
  { id: 'pkr', labelKey: 'numberFormatDialog.currency.pkr', symbol: 'Rs' },
  { id: 'pyg', labelKey: 'numberFormatDialog.currency.pyg', symbol: 'Gs', pos: 'after' },
  { id: 'bhd', labelKey: 'numberFormatDialog.currency.bhd', symbol: 'din' },
  { id: 'pab', labelKey: 'numberFormatDialog.currency.pab', symbol: 'B/' },
  { id: 'brl', labelKey: 'numberFormatDialog.currency.brl', symbol: 'R$' },
  { id: 'byn', labelKey: 'numberFormatDialog.currency.byn', symbol: 'р', pos: 'after' },
  { id: 'bmd', labelKey: 'numberFormatDialog.currency.bmd', symbol: '$' },
  { id: 'bgn', labelKey: 'numberFormatDialog.currency.bgn', symbol: 'lev' },
  { id: 'isk', labelKey: 'numberFormatDialog.currency.isk', symbol: 'kr' },
  { id: 'bam', labelKey: 'numberFormatDialog.currency.bam', symbol: 'KM' },
  { id: 'pln', labelKey: 'numberFormatDialog.currency.pln', symbol: 'zł', pos: 'after' },
  { id: 'bob', labelKey: 'numberFormatDialog.currency.bob', symbol: 'Bs' },
  { id: 'bzd', labelKey: 'numberFormatDialog.currency.bzd', symbol: '$' },
  { id: 'bwp', labelKey: 'numberFormatDialog.currency.bwp', symbol: 'P' },
  { id: 'btn', labelKey: 'numberFormatDialog.currency.btn', symbol: 'Nu' },
  { id: 'bif', labelKey: 'numberFormatDialog.currency.bif', symbol: 'FBu' },
  { id: 'dkk', labelKey: 'numberFormatDialog.currency.dkk', symbol: 'kr', pos: 'after' },
  { id: 'xcd', labelKey: 'numberFormatDialog.currency.xcd', symbol: '$' },
  { id: 'dop', labelKey: 'numberFormatDialog.currency.dop', symbol: 'RD$' },
  { id: 'rub', labelKey: 'numberFormatDialog.currency.rub', symbol: '₽', pos: 'after' },
  { id: 'cfa', labelKey: 'numberFormatDialog.currency.cfa', symbol: 'CFA' },
  { id: 'php', labelKey: 'numberFormatDialog.currency.php', symbol: '₱' },
  { id: 'cad', labelKey: 'numberFormatDialog.currency.cad', symbol: '$' },
  { id: 'chf', labelKey: 'numberFormatDialog.currency.chf', symbol: 'CHF' },
  { id: 'sek', labelKey: 'numberFormatDialog.currency.sek', symbol: 'kr', pos: 'after' },
  { id: 'sgd', labelKey: 'numberFormatDialog.currency.sgd', symbol: '$' },
  { id: 'twd', labelKey: 'numberFormatDialog.currency.twd', symbol: 'NT$' },
  { id: 'nzd', labelKey: 'numberFormatDialog.currency.nzd', symbol: '$' },
  { id: 'inr', labelKey: 'numberFormatDialog.currency.inr', symbol: '₹' },
  { id: 'idr', labelKey: 'numberFormatDialog.currency.idr', symbol: 'Rp' },
  { id: 'vnd', labelKey: 'numberFormatDialog.currency.vnd', symbol: '₫', pos: 'after' },
]

export const DATE_TIME_FORMAT_OPTIONS: readonly PatternFormatOption[] = [
  {
    id: 'date-iso',
    exampleKey: 'numberFormatDialog.dateTime.example.dateIso',
    pattern: 'yyyy-MM-dd',
    numberFormat: { kind: 'date', pattern: 'yyyy-MM-dd' },
  },
  {
    id: 'date-slash',
    exampleKey: 'numberFormatDialog.dateTime.example.dateSlash',
    pattern: 'yyyy/MM/dd',
    numberFormat: { kind: 'date', pattern: 'yyyy/MM/dd' },
  },
  {
    id: 'date-cn',
    exampleKey: 'numberFormatDialog.dateTime.example.dateChinese',
    pattern: 'yyyy年M月d日',
    numberFormat: { kind: 'date', pattern: 'yyyy年M月d日' },
  },
  {
    id: 'date-month-day-padded',
    exampleKey: 'numberFormatDialog.dateTime.example.dateMonthDayPadded',
    pattern: 'MM-dd',
    numberFormat: { kind: 'date', pattern: 'MM-dd' },
  },
  {
    id: 'date-month-day',
    exampleKey: 'numberFormatDialog.dateTime.example.dateMonthDay',
    pattern: 'M-d',
    numberFormat: { kind: 'date', pattern: 'M-d' },
  },
  {
    id: 'date-cn-month-day',
    exampleKey: 'numberFormatDialog.dateTime.example.dateChineseMonthDay',
    pattern: 'M"月"d"日"',
    numberFormat: { kind: 'date', pattern: 'M"月"d"日"' },
  },
  {
    id: 'time-seconds',
    exampleKey: 'numberFormatDialog.dateTime.example.timeSeconds',
    pattern: 'h:mm:ss',
    numberFormat: { kind: 'time', pattern: 'h:mm:ss' },
  },
  {
    id: 'time-24',
    exampleKey: 'numberFormatDialog.dateTime.example.time24',
    pattern: 'h:mm',
    numberFormat: { kind: 'time', pattern: 'h:mm' },
  },
  {
    id: 'time-ampm-padded',
    exampleKey: 'numberFormatDialog.dateTime.example.timeAmPmPadded',
    pattern: 'AM/PM hh:mm',
    numberFormat: { kind: 'time', pattern: 'AM/PM hh:mm' },
  },
  {
    id: 'time-ampm',
    exampleKey: 'numberFormatDialog.dateTime.example.timeAmPm',
    pattern: 'AM/PM h:mm',
    numberFormat: { kind: 'time', pattern: 'AM/PM h:mm' },
  },
  {
    id: 'time-ampm-seconds',
    exampleKey: 'numberFormatDialog.dateTime.example.timeAmPmSeconds',
    pattern: 'AM/PM h:mm:ss',
    numberFormat: { kind: 'time', pattern: 'AM/PM h:mm:ss' },
  },
  {
    id: 'time-cn-ampm-padded',
    exampleKey: 'numberFormatDialog.dateTime.example.timeCnAmPmPadded',
    pattern: '上午/下午 hh:mm',
    numberFormat: { kind: 'time', pattern: 'AM/PM hh:mm' },
  },
  {
    id: 'time-cn-ampm',
    exampleKey: 'numberFormatDialog.dateTime.example.timeCnAmPm',
    pattern: '上午/下午 h:mm',
    numberFormat: { kind: 'time', pattern: 'AM/PM h:mm' },
  },
  {
    id: 'time-cn-ampm-seconds',
    exampleKey: 'numberFormatDialog.dateTime.example.timeCnAmPmSeconds',
    pattern: '上午/下午 h:mm:ss',
    numberFormat: { kind: 'time', pattern: 'AM/PM h:mm:ss' },
  },
  {
    id: 'datetime-month-day-ampm',
    exampleKey: 'numberFormatDialog.dateTime.example.dateTimeMonthDayAmPm',
    pattern: 'MM-dd AM/PM hh:mm',
    numberFormat: { kind: 'custom', pattern: 'MM-dd AM/PM hh:mm' },
  },
  {
    id: 'datetime-month-day-cn-ampm',
    exampleKey: 'numberFormatDialog.dateTime.example.dateTimeMonthDayCnAmPm',
    pattern: 'MM-dd 上午/下午 hh:mm',
    numberFormat: { kind: 'custom', pattern: 'MM-dd AM/PM hh:mm' },
  },
  {
    id: 'datetime-24',
    exampleKey: 'numberFormatDialog.dateTime.example.dateTime24',
    pattern: 'yyyy-MM-dd HH:mm',
    numberFormat: { kind: 'custom', pattern: 'yyyy-MM-dd HH:mm' },
  },
  {
    id: 'datetime-12',
    exampleKey: 'numberFormatDialog.dateTime.example.dateTime12',
    pattern: 'yyyy-MM-dd h:mm AM/PM',
    numberFormat: { kind: 'custom', pattern: 'yyyy-MM-dd h:mm AM/PM' },
  },
]

export const NUMBER_FORMAT_OPTIONS: readonly PatternFormatOption[] = [
  {
    id: 'integer',
    exampleKey: 'numberFormatDialog.number.example.integer',
    pattern: '0',
    numberFormat: { kind: 'number', digits: 0, thousands: false },
  },
  {
    id: 'decimal',
    exampleKey: 'numberFormatDialog.number.example.decimal',
    pattern: '0.00',
    numberFormat: { kind: 'number', digits: 2, thousands: false },
  },
  {
    id: 'thousands',
    exampleKey: 'numberFormatDialog.number.example.thousands',
    pattern: '#,##0',
    numberFormat: { kind: 'number', digits: 0, thousands: true },
  },
  {
    id: 'thousands-decimal',
    exampleKey: 'numberFormatDialog.number.example.thousandsDecimal',
    pattern: '#,##0.00',
    numberFormat: { kind: 'number', digits: 2, thousands: true },
  },
  {
    id: 'parens-integer',
    exampleKey: 'numberFormatDialog.number.example.parensInteger',
    pattern: '#,##0_);(#,##0)',
    numberFormat: { kind: 'number', digits: 0, thousands: true, negative: 'parens' },
  },
  {
    id: 'red-parens-integer',
    exampleKey: 'numberFormatDialog.number.example.redParensInteger',
    pattern: '#,##0_);[Red](#,##0)',
    numberFormat: { kind: 'number', digits: 0, thousands: true, negative: 'red-parens' },
  },
  {
    id: 'parens-decimal',
    exampleKey: 'numberFormatDialog.number.example.parensDecimal',
    pattern: '#,##0.00_);(#,##0.00)',
    numberFormat: { kind: 'number', digits: 2, thousands: true, negative: 'parens' },
  },
  {
    id: 'red-parens-decimal',
    exampleKey: 'numberFormatDialog.number.example.redParensDecimal',
    pattern: '#,##0.00_);[Red](#,##0.00)',
    numberFormat: { kind: 'number', digits: 2, thousands: true, negative: 'red-parens' },
  },
  {
    id: 'currency-parens-integer',
    exampleKey: 'numberFormatDialog.number.example.currencyParensInteger',
    pattern: '$#,##0_);($#,##0)',
    numberFormat: { kind: 'currency', symbol: '$', digits: 0, negative: 'parens' },
  },
  {
    id: 'currency-red-parens-integer',
    exampleKey: 'numberFormatDialog.number.example.currencyRedParensInteger',
    pattern: '$#,##0_);[Red]($#,##0)',
    numberFormat: { kind: 'currency', symbol: '$', digits: 0, negative: 'red-parens' },
  },
  {
    id: 'currency-parens-decimal',
    exampleKey: 'numberFormatDialog.number.example.currencyParensDecimal',
    pattern: '$#,##0.00_);($#,##0.00)',
    numberFormat: { kind: 'currency', symbol: '$', digits: 2, negative: 'parens' },
  },
  {
    id: 'currency-red-parens-decimal',
    exampleKey: 'numberFormatDialog.number.example.currencyRedParensDecimal',
    pattern: '$#,##0.00_);[Red]($#,##0.00)',
    numberFormat: { kind: 'currency', symbol: '$', digits: 2, negative: 'red-parens' },
  },
  {
    id: 'text',
    exampleKey: 'numberFormatDialog.number.example.text',
    pattern: '@',
    numberFormat: { kind: 'text' },
  },
  {
    id: 'percent',
    exampleKey: 'numberFormatDialog.number.example.percent',
    pattern: '0%',
    numberFormat: { kind: 'percent', digits: 0 },
  },
  {
    id: 'percent-decimal',
    exampleKey: 'numberFormatDialog.number.example.percentDecimal',
    pattern: '0.00%',
    numberFormat: { kind: 'percent', digits: 2 },
  },
  {
    id: 'scientific',
    exampleKey: 'numberFormatDialog.number.example.scientific',
    pattern: '0.00E+00',
    numberFormat: { kind: 'scientific', digits: 2 },
  },
  {
    id: 'scientific-short',
    exampleKey: 'numberFormatDialog.number.example.scientificShort',
    pattern: '##0.0E+0',
    numberFormat: { kind: 'scientific', digits: 1 },
  },
  {
    id: 'fraction-one',
    exampleKey: 'numberFormatDialog.number.example.fractionOne',
    pattern: '# ?/?',
    numberFormat: { kind: 'fraction', denominator: 'one-digit' },
  },
  {
    id: 'fraction-two',
    exampleKey: 'numberFormatDialog.number.example.fractionTwo',
    pattern: '# ??/??',
    numberFormat: { kind: 'fraction', denominator: 'two-digit' },
  },
  {
    id: 'accounting-cny',
    exampleKey: 'numberFormatDialog.number.example.accountingCny',
    pattern: '_ ¥#,##0_ ;_ ¥-#,##0_ ;_ ¥"-"_ ;_ @_ ',
    numberFormat: { kind: 'accounting', symbol: '¥', digits: 0 },
  },
  {
    id: 'accounting',
    exampleKey: 'numberFormatDialog.number.example.accounting',
    pattern: '_ #,##0_ ;_ -#,##0_ ;_ "-"_ ;_ @_ ',
    numberFormat: { kind: 'accounting', symbol: '', digits: 0 },
  },
  {
    id: 'accounting-cny-decimal',
    exampleKey: 'numberFormatDialog.number.example.accountingCnyDecimal',
    pattern: '_ ¥#,##0.00_ ;_ ¥-#,##0.00_ ;_ ¥"-"??_ ;_ @_ ',
    numberFormat: { kind: 'accounting', symbol: '¥', digits: 2 },
  },
  {
    id: 'accounting-decimal',
    exampleKey: 'numberFormatDialog.number.example.accountingDecimal',
    pattern: '_ #,##0.00_ ;_ -#,##0.00_ ;_ "-"??_ ;_ @_ ',
    numberFormat: { kind: 'accounting', symbol: '', digits: 2 },
  },
]

export interface OpenNumberFormatDialogInput {
  kind: NumberFormatDialogKind
  sheetId: string
  range: CellRange
  initialFormat?: SpreadsheetCellFormat | null
}

export interface NumberFormatDialogOpenState {
  status: 'open'
  kind: NumberFormatDialogKind
  sheetId: string
  range: CellRange
  baseFormat: SpreadsheetCellFormat
  selectedId: string
  digits: number
}

export interface NumberFormatDialogClosedState {
  status: 'closed'
}

export type NumberFormatDialogState =
  | NumberFormatDialogOpenState
  | NumberFormatDialogClosedState

export interface PatchNumberFormatDialogInput {
  selectedId?: string
  digits?: number
}

const DEFAULT_SELECTED_ID: Record<NumberFormatDialogKind, string> = {
  currency: CURRENCY_FORMAT_OPTIONS[0].id,
  dateTime: DATE_TIME_FORMAT_OPTIONS[0].id,
  number: NUMBER_FORMAT_OPTIONS[1].id,
}

function cloneRange(range: CellRange): CellRange {
  return { ...range }
}

function cloneNumberFormat(format: SpreadsheetNumberFormat): SpreadsheetNumberFormat {
  return { ...format } as SpreadsheetNumberFormat
}

function cloneCellFormat(format: SpreadsheetCellFormat | undefined | null): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...(format ?? {}) }
  if (format?.numberFormat) clone.numberFormat = cloneNumberFormat(format.numberFormat)
  if (format?.borders) clone.borders = { ...format.borders }
  return clone
}

function currentDigits(format: SpreadsheetNumberFormat | undefined): number {
  if (!format) return 2
  if (format.kind === 'currency' || format.kind === 'accounting') return format.digits ?? 2
  return 2
}

function formatPattern(format: SpreadsheetNumberFormat): string | null {
  if (format.kind === 'date' || format.kind === 'time' || format.kind === 'custom') {
    return format.pattern ?? null
  }
  return null
}

function chooseCurrencyId(format: SpreadsheetNumberFormat | undefined): string {
  if (!format || (format.kind !== 'currency' && format.kind !== 'accounting')) {
    return DEFAULT_SELECTED_ID.currency
  }
  const symbol = format.symbol ?? '$'
  return (
    CURRENCY_FORMAT_OPTIONS.find((option) => option.symbol === symbol)?.id ??
    DEFAULT_SELECTED_ID.currency
  )
}

function chooseDateTimeId(format: SpreadsheetNumberFormat | undefined): string {
  if (!format) return DEFAULT_SELECTED_ID.dateTime
  const pattern = formatPattern(format)
  if (!pattern) return DEFAULT_SELECTED_ID.dateTime
  const match = DATE_TIME_FORMAT_OPTIONS.find((option) => option.pattern === pattern)
  return match?.id ?? DEFAULT_SELECTED_ID.dateTime
}

function chooseNumberId(format: SpreadsheetNumberFormat | undefined): string {
  if (!format) return DEFAULT_SELECTED_ID.number
  if (format.kind === 'number' || format.kind === 'decimal') {
    const digits = format.digits ?? 2
    const thousands = format.thousands ?? false
    const match = NUMBER_FORMAT_OPTIONS.find((option) => {
      const candidate = option.numberFormat
      return (
        candidate.kind === 'number' &&
        candidate.digits === digits &&
        (candidate.thousands ?? false) === thousands
      )
    })
    return match?.id ?? DEFAULT_SELECTED_ID.number
  }
  if (format.kind === 'percent' || format.kind === 'percentage') {
    const digits = format.digits ?? 0
    const match = NUMBER_FORMAT_OPTIONS.find((option) => {
      const candidate = option.numberFormat
      return candidate.kind === 'percent' && candidate.digits === digits
    })
    return match?.id ?? DEFAULT_SELECTED_ID.number
  }
  if (format.kind === 'scientific') return 'scientific'
  if (format.kind === 'text') return 'text'
  if (format.kind === 'custom') {
    const match = NUMBER_FORMAT_OPTIONS.find((option) => option.pattern === format.pattern)
    return match?.id ?? DEFAULT_SELECTED_ID.number
  }
  return DEFAULT_SELECTED_ID.number
}

function chooseSelectedId(
  kind: NumberFormatDialogKind,
  format: SpreadsheetNumberFormat | undefined,
): string {
  if (kind === 'currency') return chooseCurrencyId(format)
  if (kind === 'dateTime') return chooseDateTimeId(format)
  return chooseNumberId(format)
}

function optionFormatForState(state: NumberFormatDialogOpenState): SpreadsheetNumberFormat {
  if (state.kind === 'currency') {
    const option =
      CURRENCY_FORMAT_OPTIONS.find((candidate) => candidate.id === state.selectedId) ??
      CURRENCY_FORMAT_OPTIONS[0]
    if (option.pos === 'after') {
      const decimals = state.digits > 0 ? `.${'0'.repeat(state.digits)}` : ''
      return { kind: 'custom', pattern: `#,##0${decimals} "${option.symbol}"` }
    }
    return { kind: 'currency', symbol: option.symbol, digits: state.digits }
  }

  const options = state.kind === 'dateTime' ? DATE_TIME_FORMAT_OPTIONS : NUMBER_FORMAT_OPTIONS
  const option =
    options.find((candidate) => candidate.id === state.selectedId) ??
    options.find((candidate) => candidate.id === DEFAULT_SELECTED_ID[state.kind]) ??
    options[0]
  return cloneNumberFormat(option.numberFormat)
}

function formatForState(state: NumberFormatDialogOpenState): SpreadsheetCellFormat {
  return {
    ...cloneCellFormat(state.baseFormat),
    numberFormat: optionFormatForState(state),
  }
}

export const numberFormatDialogAtom = atom<NumberFormatDialogState>({ status: 'closed' })
numberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.state'

export const openNumberFormatDialogAtom = atom(
  null,
  (_get, set, input: OpenNumberFormatDialogInput) => {
    const baseFormat = cloneCellFormat(input.initialFormat)
    set(numberFormatDialogAtom, {
      status: 'open',
      kind: input.kind,
      sheetId: input.sheetId,
      range: cloneRange(input.range),
      baseFormat,
      selectedId: chooseSelectedId(input.kind, baseFormat.numberFormat),
      digits: currentDigits(baseFormat.numberFormat),
    })
  },
)
openNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.open'

export const patchNumberFormatDialogAtom = atom(
  null,
  (get, set, patch: PatchNumberFormatDialogInput) => {
    const state = get(numberFormatDialogAtom)
    if (state.status !== 'open') return
    const digits =
      patch.digits === undefined ? state.digits : Math.max(0, Math.min(20, Math.round(patch.digits)))
    set(numberFormatDialogAtom, {
      ...state,
      selectedId: patch.selectedId ?? state.selectedId,
      digits,
    })
  },
)
patchNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.patch'

export const numberFormatDialogSavePayloadAtom = atom((get) => {
  const state = get(numberFormatDialogAtom)
  if (state.status !== 'open') return null
  return {
    sheetId: state.sheetId,
    range: state.range,
    format: formatForState(state),
  }
})
numberFormatDialogSavePayloadAtom.debugLabel = 'spreadsheet.numberFormatDialog.savePayload'

export const closeNumberFormatDialogAtom = atom(null, (_get, set) => {
  set(numberFormatDialogAtom, { status: 'closed' })
})
closeNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.close'

export const saveNumberFormatDialogAtom = atom(null, (_get, set) => {
  set(numberFormatDialogAtom, { status: 'closed' })
})
saveNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.save'
