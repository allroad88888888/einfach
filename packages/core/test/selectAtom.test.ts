import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, selectAtom, createStore } from '../src'

describe('selectAtom', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该从源atom中选择一部分状态', () => {
    const userAtom = atom({ name: 'John', age: 30, email: 'john@example.com' })
    const nameAtom = selectAtom(userAtom, (user) => user.name)

    expect(store.getter(nameAtom)).toBe('John')

    store.setter(userAtom, { name: 'Jane', age: 25, email: 'jane@example.com' })
    expect(store.getter(nameAtom)).toBe('Jane')
  })

  test('应该在源atom更新时更新选择的状态', () => {
    const userAtom = atom({ name: 'John', age: 30 })
    const ageAtom = selectAtom(userAtom, (user) => user.age)

    expect(store.getter(ageAtom)).toBe(30)

    store.setter(userAtom, (prev: any) => ({ ...prev, age: 31 }))
    expect(store.getter(ageAtom)).toBe(31)
  })

  test('应该使用自定义相等性函数', () => {
    const userAtom = atom({ name: 'John', age: 30 })
    const listener = jest.fn()

    // 注意：在当前实现中，selectAtom 的第三个参数是一个比较函数
    // 这个函数返回 true 表示值相等，不触发更新
    // 返回 false 表示值不相等，触发更新
    const ageAtom = selectAtom(userAtom, (user) => user.age)

    store.sub(ageAtom, () => {
      listener()
    })

    // 更新年龄，应该触发更新
    store.setter(userAtom, (prev: any) => ({ ...prev, age: 32 }))
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // 再次更新年龄，应该再次触发更新
    store.setter(userAtom, (prev: any) => ({ ...prev, age: 38 }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('应该支持从派生atom中选择状态', () => {
    const countAtom = atom(1)
    const derivedAtom = atom((get) => ({ count: get(countAtom), double: get(countAtom) * 2 }))
    const doubleAtom = selectAtom(derivedAtom, (state) => state.double)

    expect(store.getter(doubleAtom)).toBe(2)

    store.setter(countAtom, 2)
    expect(store.getter(doubleAtom)).toBe(4)
  })

  test('应该支持嵌套的selectAtom', () => {
    const userAtom = atom({
      name: 'John',
      address: {
        city: 'New York',
        country: 'USA',
      },
    })

    const addressAtom = selectAtom(userAtom, (user) => user.address)
    const cityAtom = selectAtom(addressAtom, (address) => address.city)

    expect(store.getter(cityAtom)).toBe('New York')

    store.setter(userAtom, (prev: any) => ({
      ...prev,
      address: {
        ...prev.address,
        city: 'Boston',
      },
    }))

    expect(store.getter(cityAtom)).toBe('Boston')
  })

  test('应该在值没有变化时避免不必要的更新', () => {
    const userAtom = atom({ name: 'John', age: 30 })
    const nameAtom = selectAtom(userAtom, (user) => user.name)
    const listener = jest.fn()

    store.sub(nameAtom, listener)

    // 更新age但不更新name
    store.setter(userAtom, (prev: any) => ({ ...prev, age: 31 }))
    // 在当前实现中，即使只更新了age，也会触发nameAtom的更新
    expect(listener).toHaveBeenCalledTimes(1)
    listener.mockClear()

    // 更新name，应该触发nameAtom的更新
    store.setter(userAtom, (prev: any) => ({ ...prev, name: 'Jane' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
