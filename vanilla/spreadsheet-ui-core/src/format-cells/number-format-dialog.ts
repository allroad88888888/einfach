import { atom } from '@einfach/core'
import type { AtomEntity } from '@einfach/core'
import type { CellRange } from '../shared'
import type { SpreadsheetCellFormat, SpreadsheetNumberFormat } from '../backend'
import type {
  FormatCellsDialogId,
  FormatCellsBackendCapabilities,
  FormatCellsBackendCapabilitySource,
  FormatCellsLocalAcknowledgement,
  FormatCellsReadVisibleProjectionPort,
  FormatCellsSaveAttempt,
  FormatCellsSavePhase,
  FormatCellsSaveRequest,
  FormatCellsSaveResult,
  FormatCellsSetFormatRangePort,
  RunFormatCellsSaveInput,
} from './types'

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
  sessionId: number
  phase: FormatCellsSavePhase
  requestId: number | null
  pending: boolean
  error: string | null
  baseFormat: SpreadsheetCellFormat
  selectedId: string
  digits: number
}

export interface NumberFormatDialogClosedState {
  status: 'closed'
}

export type NumberFormatDialogState = NumberFormatDialogOpenState | NumberFormatDialogClosedState

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

interface SaveOpenState {
  readonly status: 'open'
  readonly sheetId: string
  readonly range: CellRange
  readonly sessionId: number
  readonly phase: FormatCellsSavePhase
  readonly requestId: number | null
  readonly pending: boolean
  readonly error: string | null
}

interface SaveLaunch {
  readonly token: object
  readonly operationId: string
  readonly sessionId: number
  readonly requestId: number
  readonly reentered: boolean
  readonly launched: boolean
  readonly sensitive: boolean
}

interface SaveController<State extends SaveOpenState | { readonly status: 'closed' }> {
  readonly runAtom: ReturnType<
    typeof atom<null, [RunFormatCellsSaveInput?], Promise<FormatCellsSaveResult>>
  >
  readonly ledgerAtom: AtomEntity<readonly FormatCellsSaveAttempt[]>
  readonly blockedAtom: AtomEntity<boolean>
}

export const FORMAT_CELLS_SAVE_LEDGER_MAX = 32

const INTRINSIC_REFLECT_APPLY = Reflect.apply
const INTRINSIC_REFLECT_GET = Reflect.get

interface FormatCellsCapabilityCaptureReservation {
  readonly kind: 'capturing-format-cells-capabilities'
  readonly token: object
}

const formatCellsCapabilityCaptureReservationAtom =
  atom<FormatCellsCapabilityCaptureReservation | null>(null)

const EMPTY_FORMAT_CELLS_BACKEND_CAPABILITIES: Readonly<FormatCellsBackendCapabilities> =
  Object.freeze({})

function captureFormatCellsBackendCapability<TArgs extends unknown[], TResult>(
  source: FormatCellsBackendCapabilitySource,
  key: 'setFormatRange' | 'readVisibleProjection',
): ((...args: TArgs) => TResult) | undefined {
  let capability: unknown
  try {
    capability = INTRINSIC_REFLECT_GET(source, key)
  } catch {
    return undefined
  }
  if (typeof capability !== 'function') return undefined
  return Object.freeze(
    (...args: TArgs): TResult => INTRINSIC_REFLECT_APPLY(capability, source, args) as TResult,
  )
}

/**
 * Capture backend capabilities exactly once under a per-store synchronous lock.
 * Wrappers preserve the provider receiver without consulting a potentially
 * poisoned `.bind` property. Throwing getters degrade to unavailable ports.
 */
export const captureFormatCellsBackendCapabilitiesAtom = atom(
  null,
  (
    get,
    set,
    source: FormatCellsBackendCapabilitySource,
  ): Readonly<FormatCellsBackendCapabilities> => {
    if (get(formatCellsCapabilityCaptureReservationAtom) !== null) {
      return EMPTY_FORMAT_CELLS_BACKEND_CAPABILITIES
    }
    const reservation: FormatCellsCapabilityCaptureReservation = Object.freeze({
      kind: 'capturing-format-cells-capabilities',
      token: Object.freeze({}),
    })
    set(formatCellsCapabilityCaptureReservationAtom, reservation)
    try {
      const setFormatRange = captureFormatCellsBackendCapability<
        Parameters<FormatCellsSetFormatRangePort>,
        ReturnType<FormatCellsSetFormatRangePort>
      >(source, 'setFormatRange')
      const readVisibleProjection = captureFormatCellsBackendCapability<
        Parameters<FormatCellsReadVisibleProjectionPort>,
        ReturnType<FormatCellsReadVisibleProjectionPort>
      >(source, 'readVisibleProjection')
      return Object.freeze({ setFormatRange, readVisibleProjection })
    } finally {
      if (get(formatCellsCapabilityCaptureReservationAtom) === reservation) {
        set(formatCellsCapabilityCaptureReservationAtom, null)
      }
    }
  },
)
captureFormatCellsBackendCapabilitiesAtom.debugLabel =
  'spreadsheet.formatCells.captureBackendCapabilities'

function nextSafeIdentity(current: number): number | null {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) return null
  return current + 1
}

function sameRange(left: CellRange, right: CellRange): boolean {
  return (
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.colStart === right.colStart &&
    left.colEnd === right.colEnd
  )
}

function isValidRange(range: CellRange): boolean {
  return (
    Number.isSafeInteger(range.rowStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colStart) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowStart >= 0 &&
    range.colStart >= 0 &&
    range.rowEnd >= range.rowStart &&
    range.colEnd >= range.colStart
  )
}

function safeErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error && error.message.length > 0) return error.message
    if (typeof error === 'string' && error.length > 0) return error
  } catch {
    return 'Format save failed with an unreadable error'
  }
  return 'Format save failed'
}

function freezeJsonSnapshot<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
    Object.freeze(candidate)
  }
  freeze(clone)
  return clone
}

function reserveLedgerSlot(
  ledger: readonly FormatCellsSaveAttempt[],
): FormatCellsSaveAttempt[] | null {
  const next = [...ledger]
  while (next.length >= FORMAT_CELLS_SAVE_LEDGER_MAX) {
    const acknowledgedIndex = next.findIndex((attempt) => attempt.status === 'local-acknowledged')
    if (acknowledgedIndex < 0) return null
    next.splice(acknowledgedIndex, 1)
  }
  return next
}

function snapshotLocalAcknowledgement(
  value: unknown,
  request: FormatCellsSaveRequest,
): {
  readonly acknowledgement: FormatCellsLocalAcknowledgement | null
  readonly error: string | null
} {
  if (value === null || typeof value !== 'object') {
    return { acknowledgement: null, error: 'Format save acknowledgement must be an object' }
  }
  try {
    const record = value as Record<string, unknown>
    const kind = record.kind
    const dialog = record.dialog
    const sheetId = record.sheetId
    const rangeValue = record.range
    const sessionId = record.sessionId
    const requestId = record.requestId
    if (kind !== 'local-acknowledged' || dialog !== request.dialog) {
      return { acknowledgement: null, error: 'Format save acknowledgement kind did not match' }
    }
    if (sheetId !== request.sheetId) {
      return { acknowledgement: null, error: 'Format save acknowledgement sheet did not match' }
    }
    if (
      typeof sessionId !== 'number' ||
      !Number.isSafeInteger(sessionId) ||
      sessionId !== request.sessionId ||
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== request.requestId
    ) {
      return { acknowledgement: null, error: 'Format save acknowledgement identity did not match' }
    }
    if (rangeValue === null || typeof rangeValue !== 'object') {
      return { acknowledgement: null, error: 'Format save acknowledgement range was invalid' }
    }
    const rangeRecord = rangeValue as Record<string, unknown>
    const range: CellRange = {
      rowStart: rangeRecord.rowStart as number,
      rowEnd: rangeRecord.rowEnd as number,
      colStart: rangeRecord.colStart as number,
      colEnd: rangeRecord.colEnd as number,
    }
    if (!isValidRange(range) || !sameRange(range, request.range)) {
      return { acknowledgement: null, error: 'Format save acknowledgement range did not match' }
    }
    return {
      acknowledgement: Object.freeze({
        kind: 'local-acknowledged',
        dialog: request.dialog,
        sheetId: request.sheetId,
        range: Object.freeze({ ...range }),
        sessionId,
        requestId,
      }),
      error: null,
    }
  } catch {
    return {
      acknowledgement: null,
      error: 'Format save acknowledgement was invalid or unreadable',
    }
  }
}

function snapshotSourceRanges(value: unknown): readonly CellRange[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) return null
  try {
    const ranges: CellRange[] = []
    for (const candidate of [...value]) {
      if (candidate === null || typeof candidate !== 'object') return null
      const record = candidate as Record<string, unknown>
      const range: CellRange = {
        rowStart: record.rowStart as number,
        rowEnd: record.rowEnd as number,
        colStart: record.colStart as number,
        colEnd: record.colEnd as number,
      }
      if (!isValidRange(range)) return null
      ranges.push(Object.freeze(range))
    }
    return Object.freeze(ranges)
  } catch {
    return null
  }
}

function validateBackendAcknowledgement(
  value: unknown,
  request: FormatCellsSaveRequest,
  sourceRange: CellRange,
): string | null {
  if (value === null || typeof value !== 'object') {
    return 'Format range acknowledgement must be an object'
  }
  try {
    const record = value as Record<string, unknown>
    const sheetId = record.sheetId
    const requestId = record.requestId
    const affectedRangeValue = record.affectedRange
    if (sheetId !== request.sheetId) {
      return 'Format range acknowledgement sheet did not match'
    }
    if (
      typeof requestId !== 'number' ||
      !Number.isSafeInteger(requestId) ||
      requestId !== request.requestId
    ) {
      return 'Format range acknowledgement request id did not match'
    }
    if (affectedRangeValue !== undefined) {
      if (affectedRangeValue === null || typeof affectedRangeValue !== 'object') {
        return 'Format range acknowledgement affected range was invalid'
      }
      const rangeRecord = affectedRangeValue as Record<string, unknown>
      const affectedRange: CellRange = {
        rowStart: rangeRecord.rowStart as number,
        rowEnd: rangeRecord.rowEnd as number,
        colStart: rangeRecord.colStart as number,
        colEnd: rangeRecord.colEnd as number,
      }
      if (!isValidRange(affectedRange) || !sameRange(affectedRange, sourceRange)) {
        return 'Format range acknowledgement affected a different range'
      }
    }
    return null
  } catch {
    return 'Format range acknowledgement was invalid or unreadable'
  }
}

function runWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('Format save timed out'))
    }, timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function settleLedger(
  ledger: readonly FormatCellsSaveAttempt[],
  operationId: string,
  status: 'local-acknowledged' | 'outcome-unknown',
  error?: string,
): readonly FormatCellsSaveAttempt[] {
  return Object.freeze(
    ledger.map((attempt) =>
      attempt.operationId === operationId && attempt.status === 'pending'
        ? Object.freeze({ ...attempt, status, ...(error === undefined ? {} : { error }) })
        : attempt,
    ),
  )
}

function matchesOwnedState<State extends SaveOpenState | { readonly status: 'closed' }>(
  state: State,
  request: FormatCellsSaveRequest,
): state is Extract<State, SaveOpenState> {
  return (
    state.status === 'open' &&
    state.pending &&
    state.sheetId === request.sheetId &&
    state.sessionId === request.sessionId &&
    state.requestId === request.requestId &&
    sameRange(state.range, request.range)
  )
}

/** Shared Core-owned save coordinator used by both Format Cells dialogs. */
export function createFormatCellsSaveController<
  State extends SaveOpenState | { readonly status: 'closed' },
>(
  dialog: FormatCellsDialogId,
  sourceAtom: AtomEntity<State>,
  formatForOpenState: (state: Extract<State, SaveOpenState>) => SpreadsheetCellFormat,
): SaveController<State> {
  const ledgerSourceAtom = atom<readonly FormatCellsSaveAttempt[]>(Object.freeze([]))
  const requestSequenceAtom = atom(0)
  const launchAtom = atom<SaveLaunch | null>(null)
  const ledgerAtom = atom((get) => get(ledgerSourceAtom))
  const blockedAtom = atom((get) => {
    const state = get(sourceAtom)
    return (
      get(ledgerSourceAtom).some((attempt) => attempt.status === 'outcome-unknown') ||
      (state.status === 'open' && (state.pending || state.phase === 'outcome-unknown-blocked'))
    )
  })

  const runAtom = atom(
    null,
    async (get, set, input?: RunFormatCellsSaveInput): Promise<FormatCellsSaveResult> => {
      if (get(formatCellsCapabilityCaptureReservationAtom) !== null) return 'blocked'
      const activeLaunch = get(launchAtom)
      if (activeLaunch !== null) {
        if (activeLaunch.sensitive) {
          set(launchAtom, Object.freeze({ ...activeLaunch, reentered: true }))
        }
        return 'blocked'
      }
      const initial = get(sourceAtom)
      if (initial.status !== 'open' || initial.pending) return 'blocked'
      if (
        initial.phase === 'outcome-unknown-blocked' ||
        get(ledgerSourceAtom).some((attempt) => attempt.status === 'outcome-unknown')
      ) {
        set(sourceAtom, {
          ...initial,
          phase: 'outcome-unknown-blocked',
          pending: false,
          error: initial.error ?? 'Format save is blocked by an operation with an unknown outcome',
        } as State)
        return 'blocked'
      }

      const launchToken = Object.freeze({})
      const capture: SaveLaunch = Object.freeze({
        token: launchToken,
        operationId: '',
        sessionId: initial.sessionId,
        requestId: 0,
        reentered: false,
        launched: false,
        sensitive: true,
      })
      set(launchAtom, capture)
      const currentLaunch = (): SaveLaunch | null => {
        const current = get(launchAtom)
        return current?.token === launchToken ? current : null
      }
      const updateLaunch = (patch: Partial<SaveLaunch>): boolean => {
        const current = currentLaunch()
        if (current === null) return false
        set(launchAtom, Object.freeze({ ...current, ...patch, token: launchToken }))
        return true
      }
      const releaseLaunch = (): void => {
        if (currentLaunch() !== null) set(launchAtom, null)
      }
      const wasReentered = (): boolean => currentLaunch()?.reentered === true
      const validating = {
        ...initial,
        phase: 'validating' as const,
        pending: true,
        requestId: null,
        error: null,
      }
      set(sourceAtom, validating as State)

      let resolveSourceRanges: unknown
      let setFormatRange: unknown
      let refreshProjection: unknown
      let timeoutValue: unknown
      try {
        resolveSourceRanges = input?.resolveSourceRanges
        setFormatRange = input?.setFormatRange
        refreshProjection = input?.refreshProjection
        timeoutValue = input?.timeoutMs
      } catch {
        resolveSourceRanges = null
        setFormatRange = null
        refreshProjection = null
        timeoutValue = null
      } finally {
        updateLaunch({ sensitive: false })
      }
      if (wasReentered() || currentLaunch() === null || get(sourceAtom) !== (validating as State)) {
        const reentered = wasReentered()
        if (reentered && get(sourceAtom) === (validating as State)) {
          set(sourceAtom, {
            ...validating,
            phase: 'error-open',
            pending: false,
            error: 'Format save port capture was reentrant',
          } as State)
        }
        releaseLaunch()
        return reentered ? 'error-open' : 'stale'
      }
      if (
        typeof resolveSourceRanges !== 'function' ||
        typeof setFormatRange !== 'function' ||
        typeof refreshProjection !== 'function'
      ) {
        set(sourceAtom, {
          ...validating,
          phase: 'error-open',
          pending: false,
          error: 'Format save ports are unavailable',
        } as State)
        releaseLaunch()
        return 'error-open'
      }
      if (initial.sheetId.length === 0 || !isValidRange(initial.range)) {
        set(sourceAtom, {
          ...validating,
          phase: 'error-open',
          pending: false,
          error: 'Format save target is invalid',
        } as State)
        releaseLaunch()
        return 'error-open'
      }

      let format: SpreadsheetCellFormat
      try {
        format = freezeJsonSnapshot(
          formatForOpenState(initial as unknown as Extract<State, SaveOpenState>),
        )
      } catch {
        set(sourceAtom, {
          ...validating,
          phase: 'error-open',
          pending: false,
          error: 'Format save draft could not be snapshotted',
        } as State)
        releaseLaunch()
        return 'error-open'
      }
      const nextLedger = reserveLedgerSlot(get(ledgerSourceAtom))
      const requestId = nextSafeIdentity(get(requestSequenceAtom))
      if (nextLedger === null || requestId === null) {
        set(sourceAtom, {
          ...validating,
          phase: 'error-open',
          pending: false,
          error:
            nextLedger === null
              ? 'Format save journal is full of unresolved attempts'
              : 'Format save request identity space is exhausted',
        } as State)
        releaseLaunch()
        return 'error-open'
      }

      const range = Object.freeze({ ...initial.range })
      const request: FormatCellsSaveRequest = Object.freeze({
        kind: 'save-format-range',
        dialog,
        sheetId: initial.sheetId,
        range,
        format,
        sessionId: initial.sessionId,
        requestId,
      })
      const operationId = `${dialog}-${initial.sessionId}-${requestId}`
      updateLaunch({ operationId, requestId })
      const attempt: FormatCellsSaveAttempt = Object.freeze({
        operationId,
        dialog,
        sheetId: initial.sheetId,
        range,
        sessionId: initial.sessionId,
        requestId,
        status: 'pending',
      })
      const pending = {
        ...validating,
        requestId,
      }
      set(requestSequenceAtom, requestId)
      set(ledgerSourceAtom, Object.freeze([...nextLedger, attempt]))
      set(sourceAtom, pending as State)

      await Promise.resolve()
      if (
        currentLaunch() === null ||
        !matchesOwnedState(get(sourceAtom), request) ||
        wasReentered()
      ) {
        set(
          ledgerSourceAtom,
          Object.freeze(get(ledgerSourceAtom).filter((entry) => entry.operationId !== operationId)),
        )
        releaseLaunch()
        return 'stale'
      }
      const published = {
        ...(get(sourceAtom) as unknown as Extract<State, SaveOpenState>),
        phase: 'pending-published' as const,
      }
      set(sourceAtom, published as State)
      updateLaunch({ launched: true })

      let result: unknown
      let timedOut = false
      let mutationMayHaveStarted = false
      try {
        const pipeline = (async (): Promise<FormatCellsLocalAcknowledgement> => {
          let rangesPromise: Promise<unknown>
          updateLaunch({ sensitive: true })
          try {
            rangesPromise = Promise.resolve(
              INTRINSIC_REFLECT_APPLY(resolveSourceRanges, undefined, [
                request.sheetId,
                request.range,
              ]),
            )
          } finally {
            updateLaunch({ sensitive: false })
          }
          const rangesValue = await rangesPromise
          updateLaunch({ sensitive: true })
          let sourceRanges: readonly CellRange[] | null
          try {
            sourceRanges = snapshotSourceRanges(rangesValue)
          } finally {
            updateLaunch({ sensitive: false })
          }
          if (sourceRanges === null || wasReentered()) {
            throw new Error(
              wasReentered()
                ? 'Format source-range resolution was reentrant'
                : 'Format source-range resolution returned invalid ranges',
            )
          }
          for (const sourceRange of sourceRanges) {
            if (timedOut || !matchesOwnedState(get(sourceAtom), request)) {
              throw new Error('Format save target changed during source-range dispatch')
            }
            const backendRequest = Object.freeze({
              kind: 'set-format-range' as const,
              sheetId: request.sheetId,
              range: sourceRange,
              format: request.format,
              requestId: request.requestId,
            })
            let acknowledgementPromise: Promise<unknown>
            updateLaunch({ sensitive: true })
            try {
              // This assignment is the write boundary. Once the provider is
              // invoked it may have mutated before throwing, rejecting or
              // returning an unreadable acknowledgement, so Core must retain
              // outcome-unknown backpressure from this point onward.
              mutationMayHaveStarted = true
              acknowledgementPromise = Promise.resolve(
                INTRINSIC_REFLECT_APPLY(setFormatRange, undefined, [backendRequest]),
              )
            } finally {
              updateLaunch({ sensitive: false })
            }
            const acknowledgementValue = await acknowledgementPromise
            updateLaunch({ sensitive: true })
            let acknowledgementError: string | null
            try {
              acknowledgementError = validateBackendAcknowledgement(
                acknowledgementValue,
                request,
                sourceRange,
              )
            } finally {
              updateLaunch({ sensitive: false })
            }
            if (acknowledgementError !== null || wasReentered()) {
              throw new Error(
                wasReentered()
                  ? 'Format range acknowledgement was reentrant'
                  : acknowledgementError!,
              )
            }
          }
          if (timedOut || !matchesOwnedState(get(sourceAtom), request)) {
            throw new Error('Format save target changed before projection refresh')
          }
          let refreshPromise: Promise<unknown>
          updateLaunch({ sensitive: true })
          try {
            refreshPromise = Promise.resolve(
              INTRINSIC_REFLECT_APPLY(refreshProjection, undefined, [request.sheetId]),
            )
          } finally {
            updateLaunch({ sensitive: false })
          }
          await refreshPromise
          if (timedOut || wasReentered()) {
            throw new Error(
              timedOut ? 'Format save timed out' : 'Format projection refresh was reentrant',
            )
          }
          return Object.freeze({
            kind: 'local-acknowledged',
            dialog: request.dialog,
            sheetId: request.sheetId,
            range: request.range,
            sessionId: request.sessionId,
            requestId: request.requestId,
          })
        })()
        const timeoutMs =
          typeof timeoutValue === 'number' &&
          Number.isSafeInteger(timeoutValue) &&
          timeoutValue > 0 &&
          timeoutValue <= 60_000
            ? timeoutValue
            : 15_000
        result = await runWithTimeout(pipeline, timeoutMs, () => {
          timedOut = true
        })
      } catch (error) {
        const message = safeErrorMessage(error)
        if (!mutationMayHaveStarted) {
          set(
            ledgerSourceAtom,
            Object.freeze(
              get(ledgerSourceAtom).filter((entry) => entry.operationId !== operationId),
            ),
          )
          const current = get(sourceAtom)
          const ownsCurrent = matchesOwnedState(current, request)
          if (ownsCurrent) {
            set(sourceAtom, {
              ...current,
              phase: 'error-open',
              requestId: null,
              pending: false,
              error: message,
            } as State)
          }
          releaseLaunch()
          return ownsCurrent ? 'error-open' : 'stale'
        }
        set(
          ledgerSourceAtom,
          settleLedger(get(ledgerSourceAtom), operationId, 'outcome-unknown', message),
        )
        const current = get(sourceAtom)
        if (matchesOwnedState(current, request)) {
          set(sourceAtom, {
            ...current,
            phase: 'outcome-unknown-blocked',
            pending: false,
            error: message,
          } as State)
        }
        releaseLaunch()
        return 'outcome-unknown'
      }

      updateLaunch({ sensitive: true })
      let snapshot: ReturnType<typeof snapshotLocalAcknowledgement>
      try {
        snapshot = snapshotLocalAcknowledgement(result, request)
      } finally {
        updateLaunch({ sensitive: false })
      }
      if (wasReentered() || snapshot.acknowledgement === null) {
        const message = wasReentered()
          ? 'Format save acknowledgement triggered a reentrant dispatch'
          : (snapshot.error ?? 'Format save acknowledgement was invalid')
        set(
          ledgerSourceAtom,
          settleLedger(get(ledgerSourceAtom), operationId, 'outcome-unknown', message),
        )
        const current = get(sourceAtom)
        if (matchesOwnedState(current, request)) {
          set(sourceAtom, {
            ...current,
            phase: 'outcome-unknown-blocked',
            pending: false,
            error: message,
          } as State)
        }
        releaseLaunch()
        return 'outcome-unknown'
      }

      set(ledgerSourceAtom, settleLedger(get(ledgerSourceAtom), operationId, 'local-acknowledged'))
      const current = get(sourceAtom)
      const ownsCurrent = matchesOwnedState(current, request)
      if (ownsCurrent) set(sourceAtom, { status: 'closed' } as State)
      releaseLaunch()
      return ownsCurrent ? 'local-acknowledged' : 'stale'
    },
  )

  return { runAtom, ledgerAtom, blockedAtom }
}

const numberFormatDialogSourceAtom = atom<NumberFormatDialogState>({ status: 'closed' })
const numberFormatDialogSessionSequenceAtom = atom(0)

export const numberFormatDialogAtom = atom((get) => get(numberFormatDialogSourceAtom))
numberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.state'

export const openNumberFormatDialogAtom = atom(
  null,
  (get, set, input: OpenNumberFormatDialogInput) => {
    const baseFormat = cloneCellFormat(input.initialFormat)
    const sessionId = nextSafeIdentity(get(numberFormatDialogSessionSequenceAtom))
    if (sessionId === null) return
    set(numberFormatDialogSessionSequenceAtom, sessionId)
    set(numberFormatDialogSourceAtom, {
      status: 'open',
      kind: input.kind,
      sheetId: input.sheetId,
      range: cloneRange(input.range),
      sessionId,
      phase: 'editing',
      requestId: null,
      pending: false,
      error: null,
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
    const state = get(numberFormatDialogSourceAtom)
    if (state.status !== 'open' || state.pending || state.phase === 'outcome-unknown-blocked')
      return
    const digits =
      patch.digits === undefined
        ? state.digits
        : Math.max(0, Math.min(20, Math.round(patch.digits)))
    set(numberFormatDialogSourceAtom, {
      ...state,
      phase: 'editing',
      error: null,
      selectedId: patch.selectedId ?? state.selectedId,
      digits,
    })
  },
)
patchNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.patch'

export const numberFormatDialogSavePayloadAtom = atom((get) => {
  const state = get(numberFormatDialogSourceAtom)
  if (state.status !== 'open') return null
  return {
    sheetId: state.sheetId,
    range: state.range,
    format: formatForState(state),
  }
})
numberFormatDialogSavePayloadAtom.debugLabel = 'spreadsheet.numberFormatDialog.savePayload'

export const closeNumberFormatDialogAtom = atom(null, (_get, set) => {
  set(numberFormatDialogSourceAtom, { status: 'closed' })
})
closeNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.close'

const numberFormatSaveController = createFormatCellsSaveController(
  'number-format',
  numberFormatDialogSourceAtom,
  formatForState,
)

export const numberFormatDialogSaveLedgerAtom = numberFormatSaveController.ledgerAtom
numberFormatDialogSaveLedgerAtom.debugLabel = 'spreadsheet.numberFormatDialog.saveLedger'
export const numberFormatDialogSaveBlockedAtom = numberFormatSaveController.blockedAtom
numberFormatDialogSaveBlockedAtom.debugLabel = 'spreadsheet.numberFormatDialog.saveBlocked'
export const runNumberFormatDialogSaveAtom = numberFormatSaveController.runAtom
runNumberFormatDialogSaveAtom.debugLabel = 'spreadsheet.numberFormatDialog.runSave'

export const saveNumberFormatDialogAtom = atom(null, (_get, set, input?: RunFormatCellsSaveInput) =>
  set(runNumberFormatDialogSaveAtom, input),
)
saveNumberFormatDialogAtom.debugLabel = 'spreadsheet.numberFormatDialog.save'
