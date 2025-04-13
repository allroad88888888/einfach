import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, atomWithRefresh, createStore } from '../../src'

describe('atomWithRefresh', () => {
  let store: ReturnType<typeof createStore>
  
  beforeEach(() => {
    store = createStore()
  })
  
  test('应该创建一个可刷新的atom', () => {
    let computeCount = 0
    
    const refreshableAtom = atomWithRefresh(get => {
      computeCount++
      return 'computed value'
    })
    
    // 初始计算
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(1)
    
    // 再次获取，不应该重新计算
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(1)
    
    // 刷新atom，应该重新计算
    store.setter(refreshableAtom)
    expect(store.getter(refreshableAtom)).toBe('computed value')
    expect(computeCount).toBe(2)
  })
  
  test('应该在刷新后通知订阅者', () => {
    const refreshableAtom = atomWithRefresh(() => 'computed value')
    
    const listener = jest.fn()
    store.sub(refreshableAtom, listener)
    
    // 初始获取
    expect(store.getter(refreshableAtom)).toBe('computed value')
    
    // 刷新atom
    store.setter(refreshableAtom)
    
    // 应该通知订阅者，即使值没有变化
    expect(listener).toHaveBeenCalledTimes(1)
  })
  
  test('应该支持依赖其他atom的可刷新atom', () => {
    const countAtom = atom(0)
    let computeCount = 0
    
    const refreshableAtom = atomWithRefresh(get => {
      computeCount++
      return get(countAtom) * 2
    })
    
    // 初始计算
    expect(store.getter(refreshableAtom)).toBe(0)
    expect(computeCount).toBe(1)
    
    // 更新依赖，应该重新计算
    store.setter(countAtom, 5)
    expect(store.getter(refreshableAtom)).toBe(10)
    expect(computeCount).toBe(2)
    
    // 刷新atom，应该重新计算
    store.setter(refreshableAtom)
    expect(store.getter(refreshableAtom)).toBe(10)
    expect(computeCount).toBe(3)
  })
  
  test('应该支持可写的可刷新atom', () => {
    const countAtom = atom(0)
    
    const refreshableAtom = atomWithRefresh(
      get => get(countAtom) * 2,
      (get, set, newValue: number) => {
        set(countAtom, newValue / 2)
      }
    )
    
    // 初始计算
    expect(store.getter(refreshableAtom)).toBe(0)
    
    // 设置新值
    store.setter(refreshableAtom, 10)
    expect(store.getter(countAtom)).toBe(5)
    expect(store.getter(refreshableAtom)).toBe(10)
    
    // 刷新atom
    store.setter(refreshableAtom)
    expect(store.getter(refreshableAtom)).toBe(10)
  })
})
