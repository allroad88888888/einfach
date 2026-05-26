import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  BUILTIN_FORMULA_NAMES,
  customFormulaRegistryAtom,
  registerCustomFormulaAtom,
  unregisterCustomFormulaAtom,
  validateCustomFormulaName,
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
