import { describe, test, expect, beforeEach } from '@jest/globals'
import { createAtomFamilyStore, createStore } from '../../src'

describe('createAtomFamilyStore', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('应该创建一个atom family', () => {
    const { createAtomFamily } = createAtomFamilyStore()

    const countFamily = createAtomFamily({
      debuggerKey: 'count-family'
    })

    // 获取不同key的atom
    const countAtom1 = countFamily('key1', { count: 0 })
    const countAtom2 = countFamily('key2', { count: 10 })

    expect(store.getter(countAtom1)).toEqual({ count: 0 })
    expect(store.getter(countAtom2)).toEqual({ count: 10 })

    // 更新atom
    store.setter(countAtom1, { count: 5 })
    expect(store.getter(countAtom1)).toEqual({ count: 5 })
    expect(store.getter(countAtom2)).toEqual({ count: 10 }) // 其他atom不受影响
  })

  test('应该缓存相同key的atom', () => {
    const { createAtomFamily } = createAtomFamilyStore()

    const countFamily = createAtomFamily({
      debuggerKey: 'count-family'
    })

    // 获取相同key的atom多次
    const countAtom1 = countFamily('key1', { count: 0 })
    const countAtom1Again = countFamily('key1')

    // 应该是同一个atom实例
    expect(countAtom1).toBe(countAtom1Again)

    // 更新一个应该影响另一个
    store.setter(countAtom1, { count: 5 })
    expect(store.getter(countAtom1Again)).toEqual({ count: 5 })
  })



  test('应该支持删除特定key的atom', () => {
    const { createAtomFamily } = createAtomFamilyStore()

    const countFamily = createAtomFamily({
      debuggerKey: 'count-family'
    })

    // 创建两个atom
    const countAtom1 = countFamily('key1', { count: 0 })
    const countAtom2 = countFamily('key2', { count: 10 })

    // 删除一个atom
    countFamily.remove('key1')

    // 再次获取被删除的atom应该创建一个新的
    const countAtom1New = countFamily('key1', { count: 20 })

    // 不应该是同一个atom实例
    expect(countAtom1).not.toBe(countAtom1New)
    expect(store.getter(countAtom1New)).toEqual({ count: 20 })
    expect(store.getter(countAtom2)).toEqual({ count: 10 }) // 其他atom不受影响
  })

  test('应该支持检查是否存在特定key的atom', () => {
    const { createAtomFamily } = createAtomFamilyStore()

    const countFamily = createAtomFamily({
      debuggerKey: 'count-family'
    })

    // 初始时不存在任何atom
    expect(countFamily.has('key1')).toBe(false)

    // 创建atom后应该存在
    countFamily('key1', { count: 0 })
    expect(countFamily.has('key1')).toBe(true)
    expect(countFamily.has('key2')).toBe(false)

    // 删除后应该不存在
    countFamily.remove('key1')
    expect(countFamily.has('key1')).toBe(false)
  })

  test('应该支持清空所有atom', () => {
    const { createAtomFamily } = createAtomFamilyStore()

    const countFamily = createAtomFamily({
      debuggerKey: 'count-family'
    })

    // 创建多个atom
    const countAtom1 = countFamily('key1', { count: 0 })
    const countAtom2 = countFamily('key2', { count: 10 })

    // 清空所有atom
    countFamily.clear()

    // 再次获取应该创建新的atom
    const countAtom1New = countFamily('key1', { count: 20 })
    const countAtom2New = countFamily('key2', { count: 30 })

    expect(countAtom1).not.toBe(countAtom1New)
    expect(countAtom2).not.toBe(countAtom2New)
    expect(store.getter(countAtom1New)).toEqual({ count: 20 })
    expect(store.getter(countAtom2New)).toEqual({ count: 30 })
  })
})
