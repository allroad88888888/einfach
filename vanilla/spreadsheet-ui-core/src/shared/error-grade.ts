import type { SpreadsheetError, SpreadsheetErrorSeverity, SpreadsheetErrorSource } from './types'

const LEGACY_SOURCE: Record<string, SpreadsheetErrorSource> = {
  BACKEND_ERROR: 'transport',
  CANCELLED: 'transport',
  INVALID_FORMULA: 'parse',
  FORMULA_CYCLE: 'runtime',
  OUT_OF_BOUNDS: 'validation',
}

const LEGACY_SEVERITY: Record<string, SpreadsheetErrorSeverity> = {
  CANCELLED: 'warning',
  OUT_OF_BOUNDS: 'warning',
}

export function gradeSpreadsheetError(
  input: SpreadsheetError,
): Required<Pick<SpreadsheetError, 'code' | 'message' | 'severity' | 'source'>> & { hint?: string } {
  return {
    code: input.code,
    message: input.message,
    severity: input.severity ?? LEGACY_SEVERITY[input.code] ?? 'error',
    source: input.source ?? LEGACY_SOURCE[input.code] ?? 'unknown',
    hint: input.hint,
  }
}
