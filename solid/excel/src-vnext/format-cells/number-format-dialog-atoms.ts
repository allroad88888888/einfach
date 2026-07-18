/** Compatibility barrel: Number Format product state is owned by UI Core. */
export {
  CURRENCY_FORMAT_OPTIONS,
  DATE_TIME_FORMAT_OPTIONS,
  NUMBER_FORMAT_OPTIONS,
  captureFormatCellsBackendCapabilitiesAtom,
  closeNumberFormatDialogAtom,
  numberFormatDialogAtom,
  numberFormatDialogSaveBlockedAtom,
  numberFormatDialogSaveLedgerAtom,
  numberFormatDialogSavePayloadAtom,
  openNumberFormatDialogAtom,
  patchNumberFormatDialogAtom,
  runNumberFormatDialogSaveAtom,
  saveNumberFormatDialogAtom,
} from '@einfach/spreadsheet-ui-core'
export type {
  CurrencyFormatOption,
  NumberFormatDialogKind,
  NumberFormatDialogOpenState,
  NumberFormatDialogState,
  OpenNumberFormatDialogInput,
  PatchNumberFormatDialogInput,
  PatternFormatOption,
} from '@einfach/spreadsheet-ui-core'
