import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../../src'
import { createGetFamilyAtomById } from '../../src/utils/createFamilyAtomById'

describe('createGetFamilyAtomById - set 方法', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('基本功能', () => {
    test('getFamilyAtomById 应该有 set 方法', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      expect(typeof getFamilyAtomById.set).toBe('function')
    })

    test('使用 set 方法后应该能获取到手动设置的 atom', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const customAtom = atom({ count: 999, custom: true })
      const params = { count: 10 }

      // 使用 set 方法手动设置缓存
      getFamilyAtomById.set('user1', params, customAtom as any)

      // 获取应该返回手动设置的 atom
      const retrievedAtom = getFamilyAtomById('user1', params)
      expect(retrievedAtom).toBe(customAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 999, custom: true })
    })

    test('set 方法应该能设置多个不同的 id 和 params 组合', () => {
      type ParamsType = { count: number; type: string }
      const getFamilyAtomById = createGetFamilyAtomById<ParamsType>({
        defaultState: { count: 0, type: 'default' },
        debuggerKey: 'set-family',
      })

      const atom1 = atom({ count: 111, id: 'user1' })
      const atom2 = atom({ count: 222, id: 'user2' })
      const atom3 = atom({ count: 333, id: 'user1_special' })

      const params1 = { count: 10, type: 'normal' }
      const params2 = { count: 20, type: 'admin' }

      // 设置多个不同的组合
      getFamilyAtomById.set('user1', params1, atom1 as any)
      getFamilyAtomById.set('user2', params1, atom2 as any)
      getFamilyAtomById.set('user1', params2, atom3 as any)

      // 验证每个组合都能正确获取
      expect(getFamilyAtomById('user1', params1)).toBe(atom1)
      expect(getFamilyAtomById('user2', params1)).toBe(atom2)
      expect(getFamilyAtomById('user1', params2)).toBe(atom3)

      expect(store.getter(getFamilyAtomById('user1', params1))).toEqual({ count: 111, id: 'user1' })
      expect(store.getter(getFamilyAtomById('user2', params1))).toEqual({ count: 222, id: 'user2' })
      expect(store.getter(getFamilyAtomById('user1', params2))).toEqual({
        count: 333,
        id: 'user1_special',
      })
    })
  })

  describe('参数处理', () => {
    test('set 方法应该正确处理 undefined params', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const customAtom = atom({ count: 888, undefined_params: true })

      // 使用 undefined params 设置
      getFamilyAtomById.set('user1', undefined as any, customAtom as any)

      // 通过不同方式获取应该都返回同一个 atom
      const atom1 = getFamilyAtomById('user1', undefined)
      const atom2 = getFamilyAtomById('user1')

      expect(atom1).toBe(customAtom)
      expect(atom2).toBe(customAtom)
      expect(store.getter(atom1)).toEqual({ count: 888, undefined_params: true })
    })

    test('set 方法应该能处理复杂的参数对象', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const complexParams = {
        count: 10,
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        boolean: true,
        null_value: null,
        undefined_value: undefined,
        func: () => 'test',
      }

      const customAtom = atom({ count: 999, complex: true })

      // 使用复杂参数对象设置
      getFamilyAtomById.set('user1', complexParams, customAtom as any)

      // 使用相同的参数对象引用应该能获取到设置的 atom
      const retrievedAtom = getFamilyAtomById('user1', complexParams)
      expect(retrievedAtom).toBe(customAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 999, complex: true })

      // 使用内容相同但引用不同的参数对象应该创建新的 atom
      const differentRefParams = {
        count: 10,
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        boolean: true,
        null_value: null,
        undefined_value: undefined,
        func: () => 'test',
      }
      const differentAtom = getFamilyAtomById('user1', differentRefParams)
      expect(differentAtom).not.toBe(customAtom) // 不是同一个 atom
      expect(store.getter(differentAtom)).toEqual({ count: 0 }) // 使用默认值
    })
  })

  describe('缓存覆盖', () => {
    test('set 方法应该能覆盖已存在的缓存', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const params = { count: 10 }

      // 先正常获取一个 atom
      const originalAtom = getFamilyAtomById('user1', params)
      expect(store.getter(originalAtom)).toEqual({ count: 0 })

      // 使用 set 方法覆盖缓存
      const newAtom = atom({ count: 555, overridden: true })
      getFamilyAtomById.set('user1', params, newAtom as any)

      // 再次获取应该返回新设置的 atom
      const retrievedAtom = getFamilyAtomById('user1', params)
      expect(retrievedAtom).toBe(newAtom)
      expect(retrievedAtom).not.toBe(originalAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 555, overridden: true })
    })

    test('set 方法在多次调用时应该更新缓存', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const params = { count: 10 }

      // 第一次设置
      const atom1 = atom({ count: 111, version: 1 })
      getFamilyAtomById.set('user1', params, atom1 as any)
      expect(getFamilyAtomById('user1', params)).toBe(atom1)

      // 第二次设置，覆盖第一次
      const atom2 = atom({ count: 222, version: 2 })
      getFamilyAtomById.set('user1', params, atom2 as any)
      expect(getFamilyAtomById('user1', params)).toBe(atom2)
      expect(getFamilyAtomById('user1', params)).not.toBe(atom1)

      // 第三次设置，再次覆盖
      const atom3 = atom({ count: 333, version: 3 })
      getFamilyAtomById.set('user1', params, atom3 as any)
      expect(getFamilyAtomById('user1', params)).toBe(atom3)
      expect(store.getter(getFamilyAtomById('user1', params))).toEqual({ count: 333, version: 3 })
    })

    test('set 方法应该能覆盖通过 createAtom 创建的 atom', () => {
      const createAtom = jest.fn((id: string, params?: { count: number }) => {
        return atom(params || { count: 1 })
      })

      const getFamilyAtomById = createGetFamilyAtomById({
        createAtom,
        debuggerKey: 'custom-family',
      })

      const params = { count: 5 }

      // 先通过 createAtom 创建 atom
      const createdAtom = getFamilyAtomById('user1', params)
      expect(createAtom).toHaveBeenCalledWith('user1', params)
      expect(store.getter(createdAtom)).toEqual({ count: 5 })

      // 使用 set 方法覆盖
      const customAtom = atom({ count: 999, set_override: true })
      getFamilyAtomById.set('user1', params, customAtom as any)

      // 再次获取应该返回 set 的 atom
      const retrievedAtom = getFamilyAtomById('user1', params)
      expect(retrievedAtom).toBe(customAtom)
      expect(retrievedAtom).not.toBe(createdAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 999, set_override: true })

      // createAtom 不应该再被调用
      expect(createAtom).toHaveBeenCalledTimes(1)
    })
  })

  describe('隔离性', () => {
    test('set 方法不应该影响其他 id 或 params', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const customAtom = atom({ count: 777, specific: true })
      const params1 = { count: 10 }
      const params2 = { count: 20 }

      // 只为特定的 id 和 params 设置
      getFamilyAtomById.set('user1', params1, customAtom as any)

      // 验证只有匹配的 id 和 params 返回自定义 atom
      expect(getFamilyAtomById('user1', params1)).toBe(customAtom)

      // 其他组合应该返回默认创建的 atom
      const otherAtom1 = getFamilyAtomById('user1', params2) // 相同id，不同params
      const otherAtom2 = getFamilyAtomById('user2', params1) // 不同id，相同params
      const otherAtom3 = getFamilyAtomById('user2', params2) // 不同id，不同params

      expect(otherAtom1).not.toBe(customAtom)
      expect(otherAtom2).not.toBe(customAtom)
      expect(otherAtom3).not.toBe(customAtom)

      expect(store.getter(otherAtom1)).toEqual({ count: 0 })
      expect(store.getter(otherAtom2)).toEqual({ count: 0 })
      expect(store.getter(otherAtom3)).toEqual({ count: 0 })
    })

    test('不同 getFamilyAtomById 实例之间的 set 操作应该相互独立', () => {
      type Family1ParamsType = { count: number; family: number }
      type Family2ParamsType = { count: number; family: number }

      const getFamilyAtomById1 = createGetFamilyAtomById<Family1ParamsType>({
        defaultState: { count: 0, family: 1 },
        debuggerKey: 'family-1',
      })

      const getFamilyAtomById2 = createGetFamilyAtomById<Family2ParamsType>({
        defaultState: { count: 0, family: 2 },
        debuggerKey: 'family-2',
      })

      const params1 = { count: 10, family: 1 }
      const params2 = { count: 10, family: 2 }
      const atom1 = atom({ count: 111, from_family: 1 })
      const atom2 = atom({ count: 222, from_family: 2 })

      // 在不同实例中设置相同的 id 和 params
      getFamilyAtomById1.set('user1', params1, atom1 as any)
      getFamilyAtomById2.set('user1', params2, atom2 as any)

      // 验证各自返回各自的 atom
      expect(getFamilyAtomById1('user1', params1)).toBe(atom1)
      expect(getFamilyAtomById2('user1', params2)).toBe(atom2)

      expect(store.getter(getFamilyAtomById1('user1', params1))).toEqual({
        count: 111,
        from_family: 1,
      })
      expect(store.getter(getFamilyAtomById2('user1', params2))).toEqual({
        count: 222,
        from_family: 2,
      })
    })
  })

  describe('与 override 机制的交互', () => {
    test('set 方法应该与 override 机制协同工作', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      // 添加一个 override 函数
      const overrideAtom = atom({ count: 333, from_override: true })
      const override = jest.fn((id: string, params?: any) => {
        if (id === 'override_test') return overrideAtom as any
        return undefined
      }) as any
      getFamilyAtomById.push(override)

      const params = { count: 10 }

      // 先通过 override 获取 atom
      const fromOverride = getFamilyAtomById('override_test', params)
      expect(fromOverride).toBe(overrideAtom)
      expect(override).toHaveBeenCalledTimes(1)

      // 使用 set 方法覆盖缓存（包括 override 的结果）
      const setAtom = atom({ count: 666, from_set: true })
      getFamilyAtomById.set('override_test', params, setAtom as any)

      // 再次获取应该返回 set 的 atom，而不是 override 的结果
      const fromCache = getFamilyAtomById('override_test', params)
      expect(fromCache).toBe(setAtom)
      expect(fromCache).not.toBe(overrideAtom)

      // override 函数不应该再被调用（因为缓存中已有结果）
      expect(override).toHaveBeenCalledTimes(1) // 仍然是1次
      expect(store.getter(fromCache)).toEqual({ count: 666, from_set: true })
    })

    test('set 方法设置后，新的 id 仍然会触发 override 函数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const overrideAtom = atom({ count: 444, from_override: true })
      const override = jest.fn((id: string, params?: any) => {
        if (id.startsWith('override_')) return overrideAtom as any
        return undefined
      }) as any
      getFamilyAtomById.push(override)

      const params = { count: 10 }
      const setAtom = atom({ count: 777, from_set: true })

      // 先使用 set 方法设置一个非 override 的 id
      getFamilyAtomById.set('normal_test', params, setAtom as any)
      expect(getFamilyAtomById('normal_test', params)).toBe(setAtom)
      expect(override).not.toHaveBeenCalled()

      // 然后获取一个会触发 override 的 id
      const overrideResult = getFamilyAtomById('override_test', params)
      expect(overrideResult).toBe(overrideAtom)
      expect(override).toHaveBeenCalledTimes(1)
      expect(override).toHaveBeenCalledWith('override_test', params)
    })

    test('set 方法可以预设 override 会处理的 id，避免 override 被调用', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const overrideAtom = atom({ count: 555, from_override: true })
      const override = jest.fn((id: string, params?: any) => {
        if (id === 'special') return overrideAtom as any
        return undefined
      }) as any
      getFamilyAtomById.push(override)

      const params = { count: 10 }
      const presetAtom = atom({ count: 888, preset: true })

      // 使用 set 方法预设一个本来会被 override 处理的 id
      getFamilyAtomById.set('special', params, presetAtom as any)

      // 获取该 id 应该返回预设的 atom，而不触发 override
      const result = getFamilyAtomById('special', params)
      expect(result).toBe(presetAtom)
      expect(result).not.toBe(overrideAtom)
      expect(override).not.toHaveBeenCalled() // override 函数不应该被调用
      expect(store.getter(result)).toEqual({ count: 888, preset: true })
    })
  })

  describe('性能和内存', () => {
    test('set 方法应该正确使用 WeakMap 缓存机制', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'set-family',
      })

      const params1 = { count: 10 }
      const params2 = { count: 20 }
      const atom1 = atom({ count: 111 })
      const atom2 = atom({ count: 222 })

      // 使用不同的参数对象设置
      getFamilyAtomById.set('user1', params1, atom1 as any)
      getFamilyAtomById.set('user1', params2, atom2 as any)

      // 验证使用相同参数引用能获取到正确的 atom
      expect(getFamilyAtomById('user1', params1)).toBe(atom1)
      expect(getFamilyAtomById('user1', params2)).toBe(atom2)

      // 使用不同引用但相同内容的参数对象应该创建新的 atom
      const params1Copy = { count: 10 }
      const differentAtom = getFamilyAtomById('user1', params1Copy)
      expect(differentAtom).not.toBe(atom1)
      expect(differentAtom).not.toBe(atom2)
    })

    test('set 方法应该能处理大量的 id 和 params 组合', () => {
      type ParamsType = { count: number; id: string }
      const getFamilyAtomById = createGetFamilyAtomById<ParamsType>({
        defaultState: { count: 0, id: 'default' },
        debuggerKey: 'set-family',
      })

      const atoms: any[] = []
      const paramsObjects: any[] = []

      // 创建大量的 id 和 params 组合
      for (let i = 0; i < 100; i++) {
        const params = { count: i, id: `user_${i}` }
        const testAtom = atom({ count: i * 10, index: i })

        paramsObjects.push(params)
        atoms.push(testAtom)

        getFamilyAtomById.set(`user_${i}`, params, testAtom as any)
      }

      // 验证所有设置的组合都能正确获取
      for (let i = 0; i < 100; i++) {
        const retrievedAtom = getFamilyAtomById(`user_${i}`, paramsObjects[i])
        expect(retrievedAtom).toBe(atoms[i])
        expect(store.getter(retrievedAtom)).toEqual({ count: i * 10, index: i })
      }
    })
  })

  describe('边界情况', () => {
    test('set 方法应该能处理空字符串作为 id', () => {
      type TestParamsType = { count: number; test: boolean }
      const getFamilyAtomById = createGetFamilyAtomById<TestParamsType>({
        defaultState: { count: 0, test: false },
        debuggerKey: 'set-family',
      })

      const emptyIdAtom = atom({ count: 999, empty_id: true })
      const params = { count: 0, test: true }

      getFamilyAtomById.set('', params, emptyIdAtom as any)

      const retrievedAtom = getFamilyAtomById('', params)
      expect(retrievedAtom).toBe(emptyIdAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 999, empty_id: true })
    })

    test('set 方法应该能处理特殊字符作为 id', () => {
      type SpecialParamsType = { count: number; special: boolean }
      const getFamilyAtomById = createGetFamilyAtomById<SpecialParamsType>({
        defaultState: { count: 0, special: false },
        debuggerKey: 'set-family',
      })

      const specialIds = [
        'user@domain.com',
        'user-name_123',
        'user.name',
        'user space',
        '用户名',
        '🚀',
        '\\backslash',
        '/slash',
      ]
      const atoms = specialIds.map((id, index) => atom({ count: index + 100, special_id: id }))
      const params = { count: 0, special: true }

      // 设置所有特殊 id
      specialIds.forEach((id, index) => {
        getFamilyAtomById.set(id, params, atoms[index] as any)
      })

      // 验证所有特殊 id 都能正确获取
      specialIds.forEach((id, index) => {
        const retrievedAtom = getFamilyAtomById(id, params)
        expect(retrievedAtom).toBe(atoms[index])
        expect(store.getter(retrievedAtom)).toEqual({ count: index + 100, special_id: id })
      })
    })

    test('set 方法应该能处理 null 和 undefined 在复杂参数中的情况', () => {
      type ComplexParamsType = {
        count: number
        null_value: null
        undefined_value: undefined
        zero: number
        false_value: boolean
        empty_string: string
        empty_array: never[]
        nested: {
          null_nested: null
          undefined_nested: undefined
        }
      }
      const getFamilyAtomById = createGetFamilyAtomById<ComplexParamsType>({
        defaultState: {
          count: 0,
          null_value: null,
          undefined_value: undefined,
          zero: 0,
          false_value: false,
          empty_string: '',
          empty_array: [],
          nested: {
            null_nested: null,
            undefined_nested: undefined,
          },
        },
        debuggerKey: 'set-family',
      })

      const paramsWithNulls = {
        count: 0,
        null_value: null,
        undefined_value: undefined,
        zero: 0,
        false_value: false,
        empty_string: '',
        empty_array: [] as never[],
        nested: {
          null_nested: null,
          undefined_nested: undefined,
        },
      }

      const nullHandlingAtom = atom({ count: 999, handles_nulls: true })

      getFamilyAtomById.set('null_test', paramsWithNulls, nullHandlingAtom as any)

      const retrievedAtom = getFamilyAtomById('null_test', paramsWithNulls)
      expect(retrievedAtom).toBe(nullHandlingAtom)
      expect(store.getter(retrievedAtom)).toEqual({ count: 999, handles_nulls: true })
    })
  })
})
