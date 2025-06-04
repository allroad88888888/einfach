import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../../src'
import { createGetFamilyAtomById } from '../../src/utils/createFamilyAtomById'

describe('createGetFamilyAtomById', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('基本功能', () => {
    test('应该使用 defaultState 创建一个家族 atom', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'test-family',
      })

      const atom1 = getFamilyAtomById('user1')
      const atom2 = getFamilyAtomById('user2')

      expect(store.getter(atom1)).toEqual({ count: 0 })
      expect(store.getter(atom2)).toEqual({ count: 0 })
      expect(atom1).not.toBe(atom2) // 不同 id 应该是不同的 atom
    })

    test('应该使用 createAtom 创建自定义的家族 atom', () => {
      const createAtom = jest.fn((id: string, params?: { count: number }) => {
        return atom(params || { count: 1 })
      })

      const getFamilyAtomById = createGetFamilyAtomById({
        createAtom,
        debuggerKey: 'custom-family',
      })

      const atom1 = getFamilyAtomById('user1')
      const atom2 = getFamilyAtomById('user2', { count: 5 })

      expect(createAtom).toHaveBeenCalledWith('user1', undefined)
      expect(createAtom).toHaveBeenCalledWith('user2', { count: 5 })
      expect(store.getter(atom1)).toEqual({ count: 1 })
      expect(store.getter(atom2)).toEqual({ count: 5 })
    })

    test('应该设置正确的 debugLabel', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'test-family',
      })

      const atom1 = getFamilyAtomById('user1')
      expect(atom1.debugLabel).toBe('test-family-user1')
    })
  })

  describe('缓存功能', () => {
    test('应该缓存相同 id 的 atom（无参数）', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'cache-family',
      })

      const atom1 = getFamilyAtomById('user1')
      const atom1Again = getFamilyAtomById('user1')

      expect(atom1).toBe(atom1Again) // 应该是同一个实例

      // 修改一个应该影响另一个
      store.setter(atom1, { count: 5 })
      expect(store.getter(atom1Again)).toEqual({ count: 5 })
    })

    test('应该缓存相同 id 和 params 的 atom', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'cache-family',
      })

      const params = { count: 10 }
      const atom1 = getFamilyAtomById('user1', params)
      const atom1Again = getFamilyAtomById('user1', params)

      expect(atom1).toBe(atom1Again) // 应该是同一个实例
    })

    test('应该为不同的 params 创建不同的 atom', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'cache-family',
      })

      const params1 = { count: 10 }
      const params2 = { count: 20 }
      const atom1 = getFamilyAtomById('user1', params1)
      const atom2 = getFamilyAtomById('user1', params2)

      expect(atom1).not.toBe(atom2) // 不同参数应该是不同的 atom
    })

    test('应该正确处理 undefined params', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'cache-family',
      })

      const atom1 = getFamilyAtomById('user1', undefined)
      const atom2 = getFamilyAtomById('user1')
      const atom3 = getFamilyAtomById('user1', undefined)

      expect(atom1).toBe(atom2) // undefined 参数应该等同于无参数
      expect(atom1).toBe(atom3) // 所有 undefined 参数应该共享同一个实例
    })
  })

  describe('override 功能', () => {
    test('getFamilyAtomById 应该有 override 数组和 push 方法', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      expect(Array.isArray(getFamilyAtomById.override)).toBe(true) // override 应该是数组
      expect(getFamilyAtomById.override.length).toBe(0) // 初始数组应该为空
      expect(typeof getFamilyAtomById.push).toBe('function') // 应该有 push 方法
    })

    test('应该可以使用 push 方法添加 override 函数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const overrideFunc1 = jest.fn(() => undefined) as any
      const overrideFunc2 = jest.fn(() => undefined) as any

      getFamilyAtomById.push(overrideFunc1)
      expect(getFamilyAtomById.override.length).toBe(1)
      expect(getFamilyAtomById.override[0]).toBe(overrideFunc1)

      getFamilyAtomById.push(overrideFunc2)
      expect(getFamilyAtomById.override.length).toBe(2)
      expect(getFamilyAtomById.override[1]).toBe(overrideFunc2)
    })

    test('当第一个 override 返回非 undefined 值时应该优先使用，不执行后续函数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const customAtom = atom({ count: 999 })
      const firstOverride = jest.fn((id: string) => {
        if (id === 'special') return customAtom as any
        return undefined
      }) as any

      const secondOverride = jest.fn((id: string) => {
        if (id === 'normal') return atom({ count: 888 }) as any // 对 normal 返回自定义值
        return undefined // 对其他 id 返回 undefined
      }) as any

      getFamilyAtomById.push(firstOverride)
      getFamilyAtomById.push(secondOverride)

      const specialAtom = getFamilyAtomById('special')
      const normalAtom = getFamilyAtomById('normal')

      expect(specialAtom).toBe(customAtom)
      expect(store.getter(specialAtom)).toEqual({ count: 999 })
      expect(store.getter(normalAtom)).toEqual({ count: 888 }) // 第二个 override 的返回值

      // 验证第一个 override 被调用
      expect(firstOverride).toHaveBeenCalledWith('special', undefined)
      expect(firstOverride).toHaveBeenCalledWith('normal', undefined)

      // 验证第二个 override 只在第一个返回 undefined 时被调用
      expect(secondOverride).not.toHaveBeenCalledWith('special', undefined) // 第一个已经返回了值
      expect(secondOverride).toHaveBeenCalledWith('normal', undefined) // 第一个返回了 undefined
    })

    test('当所有 override 都返回 undefined 时应该执行原逻辑', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const override1 = jest.fn(() => undefined) as any
      const override2 = jest.fn(() => undefined) as any
      const override3 = jest.fn(() => undefined) as any

      getFamilyAtomById.push(override1)
      getFamilyAtomById.push(override2)
      getFamilyAtomById.push(override3)

      const atom1 = getFamilyAtomById('user1')
      const atom2 = getFamilyAtomById('user1') // 第二次调用应该使用缓存

      expect(store.getter(atom1)).toEqual({ count: 0 })
      expect(atom1).toBe(atom2) // 应该使用缓存

      // 由于缓存机制，相同参数的第二次调用不会重新执行 override 函数
      expect(override1).toHaveBeenCalledTimes(1) // 只在第一次被调用
      expect(override2).toHaveBeenCalledTimes(1)
      expect(override3).toHaveBeenCalledTimes(1)

      // 测试不同参数会重新执行 override 函数
      const atom3 = getFamilyAtomById('user2')
      expect(override1).toHaveBeenCalledTimes(2) // 新的 id，重新执行
      expect(override2).toHaveBeenCalledTimes(2)
      expect(override3).toHaveBeenCalledTimes(2)
      expect(store.getter(atom3)).toEqual({ count: 0 }) // 验证 atom3 的值
    })

    test('override 函数应该按顺序执行直到有返回值', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const executionOrder: number[] = []

      const override1 = jest.fn((id: string) => {
        executionOrder.push(1)
        return undefined
      }) as any

      const override2 = jest.fn((id: string) => {
        executionOrder.push(2)
        if (id === 'special') return atom({ count: 222 }) as any
        return undefined
      }) as any

      const override3 = jest.fn((id: string) => {
        executionOrder.push(3)
        return atom({ count: 333 }) as any
      }) as any

      getFamilyAtomById.push(override1)
      getFamilyAtomById.push(override2)
      getFamilyAtomById.push(override3)

      const specialAtom = getFamilyAtomById('special')
      expect(store.getter(specialAtom)).toEqual({ count: 222 })
      expect(executionOrder).toEqual([1, 2]) // 第三个不应该被执行

      executionOrder.length = 0 // 清空执行顺序

      const normalAtom = getFamilyAtomById('normal')
      expect(store.getter(normalAtom)).toEqual({ count: 333 })
      expect(executionOrder).toEqual([1, 2, 3]) // 所有都应该被执行
    })

    test('override 函数应该接收正确的参数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const override1 = jest.fn(() => undefined) as any
      const override2 = jest.fn(() => undefined) as any

      getFamilyAtomById.push(override1)
      getFamilyAtomById.push(override2)

      const params = { count: 10 }
      getFamilyAtomById('user1', params)

      expect(override1).toHaveBeenCalledWith('user1', params)
      expect(override2).toHaveBeenCalledWith('user1', params)
    })

    test('可以动态添加新的 override 函数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      // 初始添加一个 override
      const firstOverride = jest.fn(() => undefined) as any
      getFamilyAtomById.push(firstOverride)

      const atom1 = getFamilyAtomById('test')
      expect(store.getter(atom1)).toEqual({ count: 0 })
      expect(firstOverride).toHaveBeenCalledTimes(1)

      // 动态添加第二个 override，这个会返回自定义 atom
      const customAtom = atom({ count: 555 })
      const secondOverride = jest.fn(() => customAtom as any) as any
      getFamilyAtomById.push(secondOverride)

      const atom2 = getFamilyAtomById('test2') // 使用不同的 id
      expect(atom2).toBe(customAtom)
      expect(store.getter(atom2)).toEqual({ count: 555 })
      expect(firstOverride).toHaveBeenCalledTimes(2) // 第一个还是会被调用（新的 id）
      expect(secondOverride).toHaveBeenCalledTimes(1) // 第二个被调用
    })

    test('清空 override 数组会影响新的调用，但不影响已缓存的结果', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const customAtom = atom({ count: 777 })
      const override = jest.fn(() => customAtom as any) as any
      getFamilyAtomById.push(override)

      const atom1 = getFamilyAtomById('test')
      expect(atom1).toBe(customAtom)

      // 清空 override 数组
      getFamilyAtomById.override.length = 0

      // 相同参数的调用仍然返回缓存的结果
      const atom1Again = getFamilyAtomById('test')
      expect(atom1Again).toBe(customAtom) // 缓存的结果

      // 但是新的 id 会使用默认逻辑
      const atom2 = getFamilyAtomById('test2')
      expect(atom2).not.toBe(customAtom)
      expect(store.getter(atom2)).toEqual({ count: 0 })
    })

    test('override 缓存机制验证', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const customAtom1 = atom({ count: 100 })
      const customAtom2 = atom({ count: 200 })

      const override = jest.fn((id: string) => {
        if (id === 'custom1') return customAtom1 as any
        if (id === 'custom2') return customAtom2 as any
        return undefined
      }) as any

      getFamilyAtomById.push(override)

      const result1 = getFamilyAtomById('custom1')
      const result2 = getFamilyAtomById('custom2')
      const result1Again = getFamilyAtomById('custom1') // 相同参数，应该使用缓存

      expect(result1).toBe(customAtom1)
      expect(result2).toBe(customAtom2)
      expect(result1Again).toBe(customAtom1) // 从缓存返回相同的 atom

      // 由于缓存机制，override 函数只被调用2次（custom1 和 custom2 各一次）
      expect(override).toHaveBeenCalledTimes(2) // 不是3次，因为第三次使用了缓存
    })

    test('支持复杂的 override 链，模拟中间件模式', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'override-family',
      })

      const logs: string[] = []

      // 第一个中间件：日志记录
      const loggingOverride = jest.fn((id: string, params?) => {
        logs.push(`访问: ${id}`)
        return undefined // 继续执行下一个
      }) as any

      // 第二个中间件：权限检查
      const authOverride = jest.fn((id: string, params?) => {
        if (id.startsWith('admin_')) {
          logs.push(`权限检查: ${id} - 拒绝`)
          return atom({ count: -1, error: 'Access Denied' }) as any
        }
        logs.push(`权限检查: ${id} - 通过`)
        return undefined // 继续执行下一个
      }) as any

      // 第三个中间件：特殊处理
      const specialOverride = jest.fn((id: string, params?) => {
        if (id === 'vip_user') {
          logs.push(`VIP处理: ${id}`)
          return atom({ count: 1000, vip: true }) as any
        }
        return undefined // 继续执行原逻辑
      }) as any

      getFamilyAtomById.push(loggingOverride)
      getFamilyAtomById.push(authOverride)
      getFamilyAtomById.push(specialOverride)

      // 测试普通用户
      const normalUser = getFamilyAtomById('normal_user')
      expect(store.getter(normalUser)).toEqual({ count: 0 })
      expect(logs).toContain('访问: normal_user')
      expect(logs).toContain('权限检查: normal_user - 通过')

      logs.length = 0 // 清空日志

      // 测试管理员用户（被拒绝）
      const adminUser = getFamilyAtomById('admin_user')
      expect(store.getter(adminUser)).toEqual({ count: -1, error: 'Access Denied' })
      expect(logs).toContain('访问: admin_user')
      expect(logs).toContain('权限检查: admin_user - 拒绝')
      expect(logs).not.toContain('VIP处理') // 不应该到达第三个中间件

      logs.length = 0 // 清空日志

      // 测试VIP用户
      const vipUser = getFamilyAtomById('vip_user')
      expect(store.getter(vipUser)).toEqual({ count: 1000, vip: true })
      expect(logs).toContain('访问: vip_user')
      expect(logs).toContain('权限检查: vip_user - 通过')
      expect(logs).toContain('VIP处理: vip_user')
    })
  })

  describe('类型系统', () => {
    test('应该正确处理不同的泛型参数', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: { count: 0 },
        debuggerKey: 'type-family',
      })

      // 测试默认类型
      const atom1 = getFamilyAtomById('test1')
      store.setter(atom1, { count: 5 })
      expect(store.getter(atom1)).toEqual({ count: 5 })

      // 测试带泛型的调用（编译时检查）
      type CustomType = { value: string }
      const atom2 = getFamilyAtomById<CustomType>('test2')
      // 注意：这里由于默认状态是 { count: 0 }，实际运行时仍然是该类型
      // 但类型系统会认为它是 CustomType
      expect(atom2).toBeDefined() // 验证 atom2 被正确创建
    })
  })

  describe('错误处理', () => {
    test('应该处理 params 不是对象的情况', () => {
      const getFamilyAtomById = createGetFamilyAtomById({
        defaultState: 0,
        debuggerKey: 'primitive-family',
      })

      // 当 params 不是对象时，应该能正常工作（通过类型断言）
      const atom1 = getFamilyAtomById('test1')
      const atom2 = getFamilyAtomById('test2')

      expect(store.getter(atom1)).toBe(0)
      expect(store.getter(atom2)).toBe(0)
      expect(atom1).not.toBe(atom2)
    })
  })
})
