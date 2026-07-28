import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../../src'
import { incrementAtom } from '../../src/utils/incrementAtom'

describe('incrementAtom', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
        store = createStore()
    })

    test('应该能使用初始值创建atom', () => {
        const incAtom = incrementAtom(10)
        expect(store.getter(incAtom)).toBe(10)
    })

    test('应该能接受读取函数作为初始值', () => {
        const baseAtom = atom(5)
        const incAtom = incrementAtom((get) => {
            return get(baseAtom) * 2
        })

        expect(store.getter(incAtom)).toBe(10)

        // 修改baseAtom应该影响incAtom
        store.setter(baseAtom, 10)
        expect(store.getter(incAtom)).toBe(20)
    })

    test('应该能设置直接值', () => {
        const incAtom = incrementAtom(10)

        store.setter(incAtom, 20)
        expect(store.getter(incAtom)).toBe(20)
    })

    test('应该能注册转换函数并自动应用', () => {
        const incAtom = incrementAtom(10)

        // 注册一个加倍函数
        store.setter(incAtom, (get, prev) => {
            return prev * 2
        })

        // 值应该已经被转换
        expect(store.getter(incAtom)).toBe(20)

        // 再注册一个加5的函数
        store.setter(incAtom, (get, prev) => {
            return prev + 5
        })

        // 两个函数应该都被应用
        expect(store.getter(incAtom)).toBe(25)

        // 再设置基础值
        store.setter(incAtom, 5)

        // 转换应该仍然生效
        expect(store.getter(incAtom)).toBe(15) // (5 * 2) + 5
    })

    test('应该能移除转换函数', () => {
        const incAtom = incrementAtom(10)

        // 注册一个加倍函数
        const removeDouble = store.setter(incAtom, (get, prev) => {
            return prev * 2
        })

        // 再注册一个加5的函数
        const removeAddFive = store.setter(incAtom, (get, prev) => {
            return prev + 5
        })

        expect(store.getter(incAtom)).toBe(25)

        // 移除加倍函数
        if (removeDouble) {
            removeDouble()
        }
        expect(store.getter(incAtom)).toBe(15) // 10 + 5

        // 移除加5函数
        if (removeAddFive) {
            removeAddFive()
        }
        expect(store.getter(incAtom)).toBe(10) // 原始值
    })

    test('转换函数应该能访问其他atom', () => {
        const factorAtom = atom(2)
        const baseAtom = atom(5)
        const incAtom = incrementAtom(10)

        // 注册一个使用其他atom的函数
        store.setter(incAtom, (get, prev) => {
            return prev * get(factorAtom)
        })

        expect(store.getter(incAtom)).toBe(20) // 10 * 2

        // 修改factorAtom
        store.setter(factorAtom, 3)
        expect(store.getter(incAtom)).toBe(30) // 10 * 3

        // 再注册一个使用其他atom的函数
        store.setter(incAtom, (get, prev) => {
            return prev + get(baseAtom)
        })

        expect(store.getter(incAtom)).toBe(35) // (10 * 3) + 5

        // 修改baseAtom
        store.setter(baseAtom, 10)
        expect(store.getter(incAtom)).toBe(40) // (10 * 3) + 10
    })

    test('转换函数应该按注册顺序应用', () => {
        const incAtom = incrementAtom(5)

        // 先注册加倍
        store.setter(incAtom, (get, prev) => prev * 2)

        // 再注册加10
        store.setter(incAtom, (get, prev) => prev + 10)

        // 值应该是 (5 * 2) + 10 = 20
        expect(store.getter(incAtom)).toBe(20)

        // 重置incAtom
        const newIncAtom = incrementAtom(5)

        // 以相反顺序注册
        store.setter(newIncAtom, (get, prev) => prev + 10)
        store.setter(newIncAtom, (get, prev) => prev * 2)

        // 值应该是 (5 + 10) * 2 = 30
        expect(store.getter(newIncAtom)).toBe(30)
    })

    test('应该支持多个订阅者', () => {
        const incAtom = incrementAtom(5)

        const listener1 = jest.fn()
        const listener2 = jest.fn()

        store.sub(incAtom, listener1)
        store.sub(incAtom, listener2)

        // 注册转换函数
        store.setter(incAtom, (get, prev) => prev * 2)

        // 两个监听器都应该被调用
        expect(listener1).toHaveBeenCalledTimes(1)
        expect(listener2).toHaveBeenCalledTimes(1)

        // 再次修改值
        store.setter(incAtom, 10)

        // 监听器应该再次被调用
        expect(listener1).toHaveBeenCalledTimes(2)
        expect(listener2).toHaveBeenCalledTimes(2)

        // 最终值应该是 10 * 2 = 20
        expect(store.getter(incAtom)).toBe(20)
    })
}) 