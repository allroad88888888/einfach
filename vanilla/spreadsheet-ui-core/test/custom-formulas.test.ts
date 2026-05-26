import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  BUILTIN_FORMULA_NAMES,
  ENGINE_BUILTIN_FORMULA_NAMES,
  customFormulaRegistryAtom,
  registerCustomFormulaAtom,
  unregisterCustomFormulaAtom,
  validateCustomFormulaName,
  type CustomFormulaArg,
  type CustomFormulaFn,
} from '../src/custom-formulas'

describe('custom-formulas: registry', () => {
  test('initial registry is empty', () => {
    const store = createStore()
    expect(store.getter(customFormulaRegistryAtom).size).toBe(0)
  })

  test('register adds the entry keyed by name', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })
    const registry = store.getter(customFormulaRegistryAtom)
    expect(registry.size).toBe(1)
    const entry = registry.get('MYTAX')
    expect(entry?.name).toBe('MYTAX')
    expect(entry?.source).toBe('return args[0] * 0.2')
  })

  test('unregister removes the entry', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })
    store.setter(unregisterCustomFormulaAtom, 'MYTAX')
    expect(store.getter(customFormulaRegistryAtom).has('MYTAX')).toBe(false)
  })

  test('unregister is a no-op when name is absent', () => {
    const store = createStore()
    const before = store.getter(customFormulaRegistryAtom)
    store.setter(unregisterCustomFormulaAtom, 'NEVER_REGISTERED')
    // Same reference would be ideal but the contract is just "no
    // throw, no shape change". Compare size + key set instead.
    const after = store.getter(customFormulaRegistryAtom)
    expect(after.size).toBe(before.size)
  })

  test('re-registering an existing name replaces the entry (last-write-wins)', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'GREET',
      source: "return 'hi ' + args[0]",
    })
    store.setter(registerCustomFormulaAtom, {
      name: 'GREET',
      source: "return 'hello, ' + args[0]",
      description: 'friendly greeting',
    })
    const entry = store.getter(customFormulaRegistryAtom).get('GREET')
    expect(entry?.source).toBe("return 'hello, ' + args[0]")
    expect(entry?.description).toBe('friendly greeting')
    expect(store.getter(customFormulaRegistryAtom).size).toBe(1)
  })

  test('register stores description + paramLabels when provided', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'CELSIUS',
      source: 'return (args[0] - 32) * 5 / 9',
      description: 'Convert Fahrenheit to Celsius',
      paramLabels: ['fahrenheit'],
    })
    const entry = store.getter(customFormulaRegistryAtom).get('CELSIUS')
    expect(entry?.description).toBe('Convert Fahrenheit to Celsius')
    expect(entry?.paramLabels).toEqual(['fahrenheit'])
  })

  test('register copies paramLabels so caller mutation does not leak in', () => {
    const store = createStore()
    const labels = ['amount']
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
      paramLabels: labels,
    })
    labels.push('rate')
    expect(store.getter(customFormulaRegistryAtom).get('MYTAX')?.paramLabels).toEqual([
      'amount',
    ])
  })
})

describe('custom-formulas: validation', () => {
  test.each([
    'A',
    'A1',
    'A_B',
    'A.B',
    'MYTAX',
    'CELSIUS',
    'X1_2.3',
  ])('valid name: %s', (name) => {
    expect(validateCustomFormulaName(name)).toEqual({ ok: true })
  })

  test.each([
    ['', 'name-empty'],
    ['sum', 'name-format'],
    ['1A', 'name-format'],
    ['_A', 'name-format'],
    ['.A', 'name-format'],
    ['A-B', 'name-format'],
    ['A B', 'name-format'],
    ['mytax', 'name-format'],
  ])('invalid name: %s -> %s', (name, reason) => {
    const result = validateCustomFormulaName(name)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe(reason)
  })

  test('shadowing a built-in is rejected', () => {
    // Sanity check the seed list actually populated.
    expect(BUILTIN_FORMULA_NAMES.has('SUM')).toBe(true)
    const result = validateCustomFormulaName('SUM')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('name-shadows-builtin')
  })

  test('register with invalid format throws', () => {
    const store = createStore()
    expect(() =>
      store.setter(registerCustomFormulaAtom, {
        name: 'sum',
        source: 'return args[0]',
      }),
    ).toThrow(/sum.*A-Z/)
  })

  test('register with empty name throws', () => {
    const store = createStore()
    expect(() =>
      store.setter(registerCustomFormulaAtom, {
        name: '',
        source: 'return 0',
      }),
    ).toThrow(/empty/)
  })

  test('register with built-in name throws', () => {
    const store = createStore()
    expect(() =>
      store.setter(registerCustomFormulaAtom, {
        name: 'SUM',
        source: 'return 0',
      }),
    ).toThrow(/shadows/)
  })

  test('a failed register does NOT mutate the registry', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })
    expect(() =>
      store.setter(registerCustomFormulaAtom, {
        name: 'bad name',
        source: 'return 0',
      }),
    ).toThrow()
    expect(store.getter(customFormulaRegistryAtom).size).toBe(1)
    expect(store.getter(customFormulaRegistryAtom).has('MYTAX')).toBe(true)
  })
})

describe('custom-formulas: debug labels', () => {
  test('atoms follow the spreadsheet.customFormulas.<name> convention', () => {
    expect(customFormulaRegistryAtom.debugLabel).toBe('spreadsheet.customFormulas.registry')
    expect(registerCustomFormulaAtom.debugLabel).toBe('spreadsheet.customFormulas.register')
    expect(unregisterCustomFormulaAtom.debugLabel).toBe(
      'spreadsheet.customFormulas.unregister',
    )
  })
})

// MED #4 — UI's `validateCustomFormulaName` must reject every name the
// Rust evaluator dispatches via `is_builtin_function_name`, not just
// the small IntelliSense seed list. The engine-mirror list (auto-
// generated by `scripts/extract-builtin-names.mjs`) covers all of
// them; these tests guard against regression if anyone replaces the
// union with the old seed-only set.
describe('custom-formulas: engine-builtin shadowing', () => {
  test('ENGINE_BUILTIN_FORMULA_NAMES includes the canonical builtins', () => {
    // Sanity check on the auto-generated mirror.
    expect(ENGINE_BUILTIN_FORMULA_NAMES.length).toBeGreaterThan(300)
    for (const name of ['SUM', 'IF', 'LAMBDA', 'LET', 'IFERROR', 'XLOOKUP', 'MAP', 'REDUCE']) {
      expect(ENGINE_BUILTIN_FORMULA_NAMES).toContain(name)
    }
  })

  test('BUILTIN_FORMULA_NAMES is the union of engine + seed lists', () => {
    for (const name of ENGINE_BUILTIN_FORMULA_NAMES) {
      expect(BUILTIN_FORMULA_NAMES.has(name)).toBe(true)
    }
  })

  test.each([
    'LAMBDA',
    'LET',
    'IFERROR',
    'IFNA',
    'XLOOKUP',
    'XMATCH',
    'MAP',
    'REDUCE',
    'BYROW',
    'BYCOL',
    'LINEST',
    'NETWORKDAYS.INTL',
  ])('engine-only built-in is rejected: %s', (name) => {
    const result = validateCustomFormulaName(name)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('name-shadows-builtin')
  })

  test('engine-only built-in register throws with shadow error', () => {
    const store = createStore()
    expect(() =>
      store.setter(registerCustomFormulaAtom, { name: 'LAMBDA', source: 'return 0' }),
    ).toThrow(/shadows/)
    expect(() =>
      store.setter(registerCustomFormulaAtom, { name: 'XLOOKUP', source: 'return 0' }),
    ).toThrow(/shadows/)
  })
})

// MED #7 — TS contract permits a 2-D array arg for range inputs. Make
// sure the type compiles AND that a callback typed against
// `CustomFormulaFn` can consume a `Value::Array`-style payload.
describe('custom-formulas: array-arg shape (MED #7)', () => {
  test('callback typed as CustomFormulaFn accepts a nested-array arg', () => {
    const sumsq: CustomFormulaFn = (args) => {
      const a = args[0]
      const xs = Array.isArray(a) ? (a as ReadonlyArray<ReadonlyArray<number>>).flat() : [a]
      return xs.reduce<number>((s, v) => s + Number(v) * Number(v), 0)
    }
    // Simulate `Value::Array` marshaling.
    const out = sumsq([[[1, 2, 3]] as ReadonlyArray<ReadonlyArray<number>>])
    expect(out).toBe(14)
  })

  test('CustomFormulaArg permits a 2-D readonly array at the type level', () => {
    const arrArg: CustomFormulaArg = [
      [1, 'two', null],
      [true, 3, null],
    ]
    expect(Array.isArray(arrArg)).toBe(true)
    expect((arrArg as ReadonlyArray<ReadonlyArray<unknown>>)[0][1]).toBe('two')
  })
})

// LOW #14 — registry stays in sync with the WASM-side case-insensitive
// lookup. Register enforces the upper-case format rule (so the AS-WRITTEN
// spelling matches engine convention); unregister normalizes incoming
// names so hosts that bind to a free-text input can pass either case
// without leaking the upper-case entry.
describe('custom-formulas: case-insensitive register/unregister (LOW #14)', () => {
  test('register stores the name verbatim as upper-case', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return Number(args[0]) * 0.2',
    })
    const reg = store.getter(customFormulaRegistryAtom)
    expect(reg.has('MYTAX')).toBe(true)
    expect(reg.get('MYTAX')?.name).toBe('MYTAX')
  })

  test('register with lower-case still rejects (format rule)', () => {
    const store = createStore()
    expect(() =>
      store.setter(registerCustomFormulaAtom, {
        name: 'mytax',
        source: 'return 0',
      }),
    ).toThrow(/A-Z/)
  })

  test('unregister with lower-case name removes the upper-case entry', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return 0',
    })
    store.setter(unregisterCustomFormulaAtom, 'mytax')
    expect(store.getter(customFormulaRegistryAtom).has('MYTAX')).toBe(false)
  })

  test('unregister with whitespace-padded name still resolves', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return 0',
    })
    store.setter(unregisterCustomFormulaAtom, '  MYTAX  ')
    expect(store.getter(customFormulaRegistryAtom).size).toBe(0)
  })

  test('unregister of an already-gone name is a no-op (no throw)', () => {
    const store = createStore()
    expect(() =>
      store.setter(unregisterCustomFormulaAtom, 'mytax'),
    ).not.toThrow()
    expect(store.getter(customFormulaRegistryAtom).size).toBe(0)
  })

  test('re-register with same name replaces in place, no duplicate', () => {
    const store = createStore()
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: "return 'a'",
    })
    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: "return 'b'",
    })
    const reg = store.getter(customFormulaRegistryAtom)
    expect(reg.size).toBe(1)
    expect(reg.get('MYTAX')?.source).toBe("return 'b'")
  })
})
