import type { FormulaFunctionSpec } from './types'

/**
 * Seed registry. Names must be upper-case. The order here is the
 * tiebreaker for ranking when multiple suggestions share the same
 * fragment-length score (registry order wins, so the most common
 * functions show up first).
 *
 * Keeping this list small on purpose — every name added here implies a
 * matching backend evaluator (otherwise the user gets `#NAME?` after
 * accepting). Expand alongside the static evaluator + worker engine.
 */
export const FORMULA_FUNCTION_SPECS: readonly FormulaFunctionSpec[] = [
  {
    name: 'SUM',
    args: [{ name: 'number1' }, { name: 'number2', optional: true, repeats: true }],
    summary: 'Adds all the numbers in a range of cells.',
  },
  {
    name: 'AVERAGE',
    args: [{ name: 'number1' }, { name: 'number2', optional: true, repeats: true }],
    summary: 'Returns the arithmetic mean of its arguments.',
  },
  {
    name: 'COUNT',
    args: [{ name: 'value1' }, { name: 'value2', optional: true, repeats: true }],
    summary: 'Counts the number of cells that contain numbers.',
  },
  {
    name: 'MIN',
    args: [{ name: 'number1' }, { name: 'number2', optional: true, repeats: true }],
    summary: 'Returns the smallest numeric value in the arguments.',
  },
  {
    name: 'MAX',
    args: [{ name: 'number1' }, { name: 'number2', optional: true, repeats: true }],
    summary: 'Returns the largest numeric value in the arguments.',
  },
  {
    name: 'IF',
    args: [
      { name: 'logical_test' },
      { name: 'value_if_true' },
      { name: 'value_if_false', optional: true },
    ],
    summary: 'Returns one value if the condition is true and another otherwise.',
  },
  {
    name: 'SUMIF',
    args: [
      { name: 'range' },
      { name: 'criteria' },
      { name: 'sum_range', optional: true },
    ],
    summary: 'Sums the cells in a range that meet a given criterion.',
  },
  {
    name: 'COUNTIF',
    args: [{ name: 'range' }, { name: 'criteria' }],
    summary: 'Counts the cells in a range that meet a given criterion.',
  },
  {
    name: 'ABS',
    args: [{ name: 'number' }],
    summary: 'Returns the absolute value of a number.',
  },
  {
    name: 'ROUND',
    args: [{ name: 'number' }, { name: 'num_digits' }],
    summary: 'Rounds a number to a specified number of digits.',
  },
  {
    name: 'CONCAT',
    args: [{ name: 'text1' }, { name: 'text2', optional: true, repeats: true }],
    summary: 'Joins several text strings into one.',
  },
  {
    name: 'AND',
    args: [{ name: 'logical1' }, { name: 'logical2', optional: true, repeats: true }],
    summary: 'Returns TRUE if all arguments are TRUE.',
  },
  {
    name: 'OR',
    args: [{ name: 'logical1' }, { name: 'logical2', optional: true, repeats: true }],
    summary: 'Returns TRUE if any argument is TRUE.',
  },
  {
    name: 'NOT',
    args: [{ name: 'logical' }],
    summary: 'Reverses the logical value of its argument.',
  },
  {
    name: 'LEN',
    args: [{ name: 'text' }],
    summary: 'Returns the number of characters in a text string.',
  },
  {
    name: 'LOWER',
    args: [{ name: 'text' }],
    summary: 'Converts text to lowercase.',
  },
  {
    name: 'UPPER',
    args: [{ name: 'text' }],
    summary: 'Converts text to uppercase.',
  },
  {
    name: 'TRIM',
    args: [{ name: 'text' }],
    summary: 'Removes extra spaces from a text string.',
  },
  {
    name: 'SQRT',
    args: [{ name: 'number' }],
    summary: 'Returns a positive square root.',
  },
  {
    name: 'MOD',
    args: [{ name: 'number' }, { name: 'divisor' }],
    summary: 'Returns the remainder after a number is divided by a divisor.',
  },
  {
    name: 'VLOOKUP',
    args: [
      { name: 'lookup_value' },
      { name: 'table_array' },
      { name: 'col_index_num' },
      { name: 'range_lookup', optional: true },
    ],
    summary: /* eslint-disable-next-line max-len */
      'Looks up a value in the first column of a range and returns a value from a column in the same row.',
  },
]

const SPEC_BY_NAME: Map<string, FormulaFunctionSpec> = new Map(
  FORMULA_FUNCTION_SPECS.map((spec) => [spec.name, spec]),
)

/**
 * Lookup by upper-case name. Returns undefined when unknown.
 */
export function getFormulaFunctionSpec(name: string): FormulaFunctionSpec | undefined {
  return SPEC_BY_NAME.get(name.toUpperCase())
}

/**
 * Render the spec's signature as a single line with optional/repeating
 * markers — `SUM(number1, [number2, ...])`. Used by the signature tooltip.
 */
export function renderFormulaFunctionSignature(spec: FormulaFunctionSpec): string {
  const parts: string[] = []
  for (const arg of spec.args) {
    const tail = arg.repeats ? `${arg.name}, ...` : arg.name
    parts.push(arg.optional ? `[${tail}]` : tail)
  }
  return `${spec.name}(${parts.join(', ')})`
}
