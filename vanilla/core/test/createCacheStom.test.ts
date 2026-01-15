import { describe, test, expect } from '@jest/globals'
import { atom, createStore } from '../src'
import { createCacheStom, createCacheStomById } from '../src/utils/createCacheStom'

describe('createCacheStom', () => {
  describe('基本缓存功能', () => {
    test('相同参数应该返回缓存的 atom 值', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createCount++
          return atom({ id, count: 0 })
        },
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('user1')
      const atom2 = getUserAtom('user1')

      // 读取两次，但只创建一次底层 atom
      store.getter(atom1)
      store.getter(atom2)

      expect(createCount).toBe(1)
    })

    test('不同参数应该创建不同的 atom', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createCount++
          return atom({ id })
        },
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('user1')
      const atom2 = getUserAtom('user2')

      store.getter(atom1)
      store.getter(atom2)

      expect(createCount).toBe(2)
      expect(store.getter(atom1)).toEqual({ id: 'user1' })
      expect(store.getter(atom2)).toEqual({ id: 'user2' })
    })

    test('缓存的 atom 应该共享状态', () => {
      const store = createStore()

      const getCountAtom = createCacheStom({
        createAtom: (id: string) => atom(0),
        debuggerKey: 'count',
      })

      const atom1 = getCountAtom('counter1')
      const atom2 = getCountAtom('counter1')

      store.setter(atom1, 10)
      expect(store.getter(atom2)).toBe(10)
    })
  })

  describe('Store 级别缓存隔离', () => {
    test('不同 Store 应该有独立的缓存', () => {
      const store1 = createStore()
      const store2 = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createCount++
          return atom({ id, data: null })
        },
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('user1')

      store1.getter(atom1)
      store2.getter(atom1)

      // 两个 store 各创建一次
      expect(createCount).toBe(2)
    })

    test('不同 Store 的缓存应该独立更新', () => {
      const store1 = createStore()
      const store2 = createStore()

      const getCountAtom = createCacheStom({
        createAtom: (id: string) => atom(0),
        debuggerKey: 'count',
      })

      const countAtom = getCountAtom('counter1')

      store1.setter(countAtom, 10)
      store2.setter(countAtom, 20)

      expect(store1.getter(countAtom)).toBe(10)
      expect(store2.getter(countAtom)).toBe(20)
    })
  })

  describe('LRU 缓存策略', () => {
    test('超过 maxSize 应该淘汰最久未使用的 atom', () => {
      const store = createStore()
      const createdIds: string[] = []

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createdIds.push(id)
          return atom({ id })
        },
        debuggerKey: 'user',
        maxSize: 2,
      })

      const atom1 = getUserAtom('user1')
      const atom2 = getUserAtom('user2')
      const atom3 = getUserAtom('user3')

      store.getter(atom1)
      store.getter(atom2)
      store.getter(atom3) // 应该淘汰 user1

      // 再次访问 user1，应该重新创建
      const atom1Again = getUserAtom('user1')
      store.getter(atom1Again)

      expect(createdIds).toEqual(['user1', 'user2', 'user3', 'user1'])
    })

    test('访问操作应该更新 LRU 顺序', () => {
      const store = createStore()
      const createdIds: string[] = []

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createdIds.push(id)
          return atom({ id })
        },
        debuggerKey: 'user',
        maxSize: 2,
      })

      const atom1 = getUserAtom('user1')
      const atom2 = getUserAtom('user2')

      store.getter(atom1)
      store.getter(atom2)

      // 再次访问 user1，更新其为最近使用
      store.getter(getUserAtom('user1'))

      // 添加 user3，应该淘汰 user2 而不是 user1
      const atom3 = getUserAtom('user3')
      store.getter(atom3)

      // 再次访问 user2，应该重新创建
      const atom2Again = getUserAtom('user2')
      store.getter(atom2Again)

      expect(createdIds).toEqual(['user1', 'user2', 'user3', 'user2'])
    })

    test('maxSize = Infinity 应该不限制缓存', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string) => {
          createCount++
          return atom({ id })
        },
        debuggerKey: 'user',
        maxSize: Infinity,
      })

      // 创建很多 atom
      for (let i = 0; i < 100; i++) {
        store.getter(getUserAtom(`user${i}`))
      }

      expect(createCount).toBe(100)

      // 再次访问，应该都从缓存获取
      for (let i = 0; i < 100; i++) {
        store.getter(getUserAtom(`user${i}`))
      }

      expect(createCount).toBe(100) // 没有增加
    })
  })

  describe('自定义 getCacheKey', () => {
    test('应该支持自定义缓存键生成函数', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string, type: string) => {
          createCount++
          return atom({ id, type })
        },
        getCacheKey: (id: string, type: string) => `${type}-${id}`,
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('1', 'admin')
      const atom2 = getUserAtom('1', 'user')

      store.getter(atom1)
      store.getter(atom2)

      // 虽然 id 相同，但 type 不同，应该创建两个 atom
      expect(createCount).toBe(2)
    })

    test('自定义 getCacheKey 应该正确缓存', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStom({
        createAtom: (id: string, type: string) => {
          createCount++
          return atom({ id, type })
        },
        getCacheKey: (id: string, type: string) => `${type}-${id}`,
        debuggerKey: 'user',
      })

      store.getter(getUserAtom('1', 'admin'))
      store.getter(getUserAtom('1', 'admin'))

      expect(createCount).toBe(1)
    })

    test('应该支持复杂类型作为缓存键', () => {
      const store = createStore()
      let createCount = 0

      const key1 = Symbol('key1')
      const key2 = Symbol('key2')

      const getDataAtom = createCacheStom<[symbol: symbol], any, symbol>({
        createAtom: (key: symbol) => {
          createCount++
          return atom({ key: key.toString() })
        },
        getCacheKey: (key: symbol) => key,
        debuggerKey: 'data',
      })

      store.getter(getDataAtom(key1))
      store.getter(getDataAtom(key1))
      store.getter(getDataAtom(key2))

      expect(createCount).toBe(2)
    })
  })

  describe('WritableAtom 支持', () => {
    test('应该支持 WritableAtom', () => {
      const store = createStore()

      // 创建独立的 primitive atom
      const countersMap = new Map<string, ReturnType<typeof atom<number>>>()

      const getCounterAtom = createCacheStom({
        createAtom: (id: string) => {
          const primitiveAtom = atom(0)
          countersMap.set(id, primitiveAtom)
          return atom(
            (get) => get(primitiveAtom),
            (get, set, update: number | ((prev: number) => number)) => {
              const prev = get(primitiveAtom)
              const next = typeof update === 'function' ? update(prev) : update
              set(primitiveAtom, next)
            },
          )
        },
        debuggerKey: 'counter',
      })

      const counter1 = getCounterAtom('c1')

      expect(store.getter(counter1)).toBe(0)

      store.setter(counter1, 10)
      expect(store.getter(counter1)).toBe(10)

      store.setter(counter1, (prev: number) => prev + 5)
      expect(store.getter(counter1)).toBe(15)
    })

    test('WritableAtom 应该正确缓存', () => {
      const store = createStore()
      let createCount = 0

      const getCounterAtom = createCacheStom({
        createAtom: (id: string) => {
          createCount++
          const primitiveAtom = atom(0)
          return atom(
            (get) => get(primitiveAtom),
            (get, set, value: number) => {
              set(primitiveAtom, value)
            },
          )
        },
        debuggerKey: 'counter',
      })

      const counter1a = getCounterAtom('c1')
      const counter1b = getCounterAtom('c1')

      store.setter(counter1a, 10)
      expect(store.getter(counter1b)).toBe(10)
      expect(createCount).toBe(1)
    })
  })

  describe('多参数支持', () => {
    test('应该支持多个参数', () => {
      const store = createStore()
      let createCount = 0

      const getDataAtom = createCacheStom({
        createAtom: (id: string, type: string, version: number) => {
          createCount++
          return atom({ id, type, version })
        },
        debuggerKey: 'data',
      })

      const atom1 = getDataAtom('data1', 'user', 1)
      const atom2 = getDataAtom('data1', 'user', 1)
      const atom3 = getDataAtom('data1', 'user', 2)

      store.getter(atom1)
      store.getter(atom2)
      store.getter(atom3)

      expect(createCount).toBe(2)
      expect(store.getter(atom1)).toEqual({ id: 'data1', type: 'user', version: 1 })
      expect(store.getter(atom3)).toEqual({ id: 'data1', type: 'user', version: 2 })
    })
  })
})

describe('createCacheStomById', () => {
  describe('使用 createAtom', () => {
    test('应该创建带缓存的 atom', () => {
      const store = createStore()
      let createCount = 0

      const getUserAtom = createCacheStomById({
        createAtom: (id: string) => {
          createCount++
          return atom({ id, name: `User ${id}` })
        },
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('1')
      const atom2 = getUserAtom('1')

      store.getter(atom1)
      store.getter(atom2)

      expect(createCount).toBe(1)
      expect(store.getter(atom1)).toEqual({ id: '1', name: 'User 1' })
    })

    test('应该支持 maxSize', () => {
      const store = createStore()
      const createdIds: string[] = []

      const getUserAtom = createCacheStomById({
        createAtom: (id: string) => {
          createdIds.push(id)
          return atom({ id })
        },
        debuggerKey: 'user',
        maxSize: 2,
      })

      store.getter(getUserAtom('1'))
      store.getter(getUserAtom('2'))
      store.getter(getUserAtom('3'))

      // 再次访问 '1'，应该重新创建
      store.getter(getUserAtom('1'))

      expect(createdIds).toEqual(['1', '2', '3', '1'])
    })
  })

  describe('使用 defaultState', () => {
    test('应该使用默认值创建 atom', () => {
      const store = createStore()

      const getCountAtom = createCacheStomById({
        createAtom: (id) => atom(0),
        debuggerKey: 'count',
      })

      const atom1 = getCountAtom('counter1')
      const atom2 = getCountAtom('counter2')

      expect(store.getter(atom1)).toBe(0)
      expect(store.getter(atom2)).toBe(0)

      store.setter(atom1, 10)
      expect(store.getter(atom1)).toBe(10)
      expect(store.getter(atom2)).toBe(0) // 独立状态
    })

    test('应该支持复杂对象作为 defaultState', () => {
      const store = createStore()

      const getUserAtom = createCacheStomById({
        createAtom: (id) => atom({ name: 'Anonymous', age: 0 }),
        debuggerKey: 'user',
      })

      const atom1 = getUserAtom('1')

      expect(store.getter(atom1)).toEqual({ name: 'Anonymous', age: 0 })

      store.setter(atom1, { name: 'John', age: 30 })
      expect(store.getter(atom1)).toEqual({ name: 'John', age: 30 })
    })

    test('应该正确缓存使用 defaultState 的 atom', () => {
      const store = createStore()

      const getCountAtom = createCacheStomById({
        createAtom: (id) => atom(0),
        debuggerKey: 'count',
      })

      const atom1 = getCountAtom('c1')
      const atom2 = getCountAtom('c1')

      store.setter(atom1, 10)
      expect(store.getter(atom2)).toBe(10)
    })

    test('应该支持 maxSize', () => {
      const store = createStore()

      const getCountAtom = createCacheStomById({
        createAtom: (id) => atom(0),
        debuggerKey: 'count',
        maxSize: 2,
      })

      const atom1 = getCountAtom('1')
      const atom2 = getCountAtom('2')
      const atom3 = getCountAtom('3')

      store.setter(atom1, 10)
      store.setter(atom2, 20)
      store.setter(atom3, 30)

      // 再次访问 '1'，由于缓存已满，应该是新创建的，值为默认值 0
      const atom1Again = getCountAtom('1')
      expect(store.getter(atom1Again)).toBe(0)
    })
  })

  describe('Store 隔离', () => {
    test('不同 Store 应该有独立缓存', () => {
      const store1 = createStore()
      const store2 = createStore()

      const getCountAtom = createCacheStomById({
        createAtom: (id) => atom(0),
        debuggerKey: 'count',
      })

      const countAtom = getCountAtom('counter1')

      store1.setter(countAtom, 10)
      store2.setter(countAtom, 20)

      expect(store1.getter(countAtom)).toBe(10)
      expect(store2.getter(countAtom)).toBe(20)
    })
  })

  describe('使用 defaultState 只读', () => {
    test('defaultState 应该创建只读 atom', () => {
      const store = createStore()

      const getCountAtom = createCacheStomById({
        defaultState: 100,
        debuggerKey: 'count',
      })

      const atom1 = getCountAtom('c1')
      const atom2 = getCountAtom('c2')

      expect(store.getter(atom1)).toBe(100)
      expect(store.getter(atom2)).toBe(100)
    })

    test('defaultState 创建的 atom 应该正确缓存', () => {
      const store = createStore()
      let createCount = 0

      const getDataAtom = createCacheStomById({
        createAtom: (id) => {
          createCount++
          return atom({ value: 'test', id })
        },
        debuggerKey: 'data',
      })

      const atom1 = getDataAtom('d1')
      const atom2 = getDataAtom('d1')

      store.getter(atom1)
      store.getter(atom2)

      // 虽然调用了两次，但底层只创建了一个 atom
      expect(createCount).toBe(1)
      expect(store.getter(atom1)).toEqual({ value: 'test', id: 'd1' })
      expect(store.getter(atom2)).toEqual({ value: 'test', id: 'd1' })
    })
  })
})
