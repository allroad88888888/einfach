import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, selectAtom, createStore } from '../src'

describe('selectAtom 异步功能测试', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该从异步atom中选择状态', async () => {
    const asyncUserAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { name: 'John', age: 30, email: 'john@example.com' }
    })
    const nameAtom = selectAtom(asyncUserAtom, (user) => user.name)

    // 获取的应该是一个Promise
    const result = store.getter(nameAtom)
    expect(result).toBeInstanceOf(Promise)

    // 等待Promise解析
    const name = await result
    expect(name).toBe('John')
  })

  
  test('应该处理异步atom的更新', async () => {
    // 使用可写的原子作为数据源
    const userDataAtom = atom({ name: 'John', age: 30 })
    const asyncUserAtom = atom(async (get) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return get(userDataAtom)
    })
    const ageAtom = selectAtom(asyncUserAtom, (user) => user.age)

    // 初始状态
    let age = await store.getter(ageAtom)
    expect(age).toBe(30)

    // 更新数据源
    store.setter(userDataAtom, { name: 'John', age: 31 })

    // 获取更新后的年龄
    age = await store.getter(ageAtom)
    expect(age).toBe(31)
  })

  test('应该支持异步atom的嵌套选择', async () => {
    const asyncUserAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        name: 'John',
        address: {
          city: 'New York',
          country: 'USA',
        },
      }
    })

    const addressAtom = selectAtom(asyncUserAtom, (user) => user.address)
    const cityAtom = selectAtom(addressAtom, (address) => address.city)

    const city = await store.getter(cityAtom)
    expect(city).toBe('New York')
  })

  test('应该处理异步atom的错误情况', async () => {
    const errorAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('Async error')
    })
    const selectedAtom = selectAtom(errorAtom, (data) => data)

    try {
      await store.getter(selectedAtom)
      throw new Error('应该抛出错误')
    } catch (error) {
      expect((error as Error).message).toBe('Async error')
    }
  })

  test('应该支持异步atom返回不同类型的数据', async () => {
    const asyncDataAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return [1, 2, 3, 4, 5]
    })

    const lengthAtom = selectAtom(asyncDataAtom, (data) => data.length)
    const firstAtom = selectAtom(asyncDataAtom, (data) => data[0])

    const length = await store.getter(lengthAtom)
    const first = await store.getter(firstAtom)

    expect(length).toBe(5)
    expect(first).toBe(1)
  })

  test('应该正确处理从同步到异步的转换', async () => {
    // 开始是同步atom
    const baseAtom = atom(42)
    const doubleAtom = selectAtom(baseAtom, (value) => value * 2)

    // 同步获取
    expect(store.getter(doubleAtom)).toBe(84)

    // 更新为异步atom
    store.setter(baseAtom, () => {
      return 21
    })

    // 现在是异步获取
    const result = await store.getter(doubleAtom)
    expect(result).toBe(42)
  })

  test('应该支持复杂的异步数据转换', async () => {
    const asyncApiAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        users: [
          { id: 1, name: 'Alice', active: true },
          { id: 2, name: 'Bob', active: false },
          { id: 3, name: 'Charlie', active: true },
        ],
        pagination: {
          total: 3,
          page: 1,
          pageSize: 10,
        },
      }
    })

    const activeUsersAtom = selectAtom(asyncApiAtom, (data) =>
      data.users.filter((user) => user.active),
    )

    const activeUserNamesAtom = selectAtom(activeUsersAtom, (users) =>
      users.map((user) => user.name),
    )

    const activeNames = await store.getter(activeUserNamesAtom)
    expect(activeNames).toEqual(['Alice', 'Charlie'])
  })
})
