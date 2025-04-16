import { describe, test, expect, beforeEach, jest } from '@jest/globals'
import { atom, createStore } from '../src'

/**
 * 复杂atom测试 - 测试atom在复杂场景下的行为
 */
describe('atom复杂场景测试', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
        store = createStore()
    })

    describe('依赖网络测试', () => {
        test('应该正确处理复杂的依赖网络', () => {
            // 创建多个基础atom
            const aAtom = atom(1)
            const bAtom = atom(2)
            const cAtom = atom(3)

            // 创建一级依赖
            const abSumAtom = atom((get) => get(aAtom) + get(bAtom))
            const bcProductAtom = atom((get) => get(bAtom) * get(cAtom))

            // 创建二级依赖
            const complexAtom = atom((get) => {
                const abSum = get(abSumAtom)
                const bcProduct = get(bcProductAtom)
                return abSum * bcProduct - get(aAtom)
            })

            // 验证初始状态
            expect(store.getter(abSumAtom)).toBe(3)  // 1 + 2
            expect(store.getter(bcProductAtom)).toBe(6)  // 2 * 3
            expect(store.getter(complexAtom)).toBe(17)  // 3 * 6 - 1

            // 更新基础atom，验证所有依赖都被正确更新
            store.setter(aAtom, 4)
            expect(store.getter(abSumAtom)).toBe(6)  // 4 + 2
            expect(store.getter(bcProductAtom)).toBe(6)  // 2 * 3 (未变)
            expect(store.getter(complexAtom)).toBe(32)  // 6 * 6 - 4

            store.setter(bAtom, 5)
            expect(store.getter(abSumAtom)).toBe(9)  // 4 + 5
            expect(store.getter(bcProductAtom)).toBe(15)  // 5 * 3
            expect(store.getter(complexAtom)).toBe(131)  // 9 * 15 - 4

            store.setter(cAtom, 6)
            expect(store.getter(abSumAtom)).toBe(9)  // 4 + 5 (未变)
            expect(store.getter(bcProductAtom)).toBe(30)  // 5 * 6
            expect(store.getter(complexAtom)).toBe(266)  // 9 * 30 - 4
        })

        test('应该处理循环依赖而不导致无限循环', () => {
            // 注意：这个测试假设实现有循环依赖检测，实际情况可能需要调整

            // 创建一个基础atom
            const countAtom = atom(1)

            // 创建一个循环引用的数据结构
            interface CircularNode {
                value: number;
                next?: CircularNode;
            }

            // 创建一个可能引起循环依赖的派生atom
            const nodeAtom = atom<CircularNode>({
                value: 1,
                next: undefined
            })

            // 创建一个引用自身的派生atom
            const circularAtom = atom(
                (get) => {
                    const node = get(nodeAtom)
                    const count = get(countAtom)

                    // 尝试创建一个循环结构
                    if (!node.next && count > 1) {
                        const updatedNode = { ...node, next: node }  // 引用自身形成循环
                        return updatedNode
                    }

                    return node
                }
            )

            // 使值变化以触发循环逻辑
            store.setter(countAtom, 2)

            // 应该不会无限循环或崩溃
            expect(() => store.getter(circularAtom)).not.toThrow()
        })
    })

    describe('动态依赖测试', () => {
        test('应该处理基于条件的动态依赖', () => {
            const conditionAtom = atom(true)
            const aAtom = atom(5)
            const bAtom = atom(10)

            // 根据条件atom选择不同的数据来源
            const dynamicAtom = atom((get) => {
                const condition = get(conditionAtom)
                return condition ? get(aAtom) : get(bAtom)
            })

            // 初始是true，应该使用aAtom的值
            expect(store.getter(dynamicAtom)).toBe(5)

            // 更改条件
            store.setter(conditionAtom, false)
            expect(store.getter(dynamicAtom)).toBe(10)

            // 当条件为false时更新bAtom
            store.setter(bAtom, 20)
            expect(store.getter(dynamicAtom)).toBe(20)

            // 切换回true，现在应该用aAtom
            store.setter(conditionAtom, true)
            expect(store.getter(dynamicAtom)).toBe(5)

            // 当条件为true时更新aAtom
            store.setter(aAtom, 15)
            expect(store.getter(dynamicAtom)).toBe(15)
        })
    })

    describe('高级写入场景', () => {
        test('具有多层写入的可写派生atom', () => {
            // 创建底层atom
            const firstNameAtom = atom('张')
            const lastNameAtom = atom('三')

            // 创建中间派生atom
            const fullNameAtom = atom(
                (get) => `${get(firstNameAtom)}${get(lastNameAtom)}`,
                (get, set, newValue: string) => {
                    if (typeof newValue !== 'string') return

                    // 简单拆分，假设最后一个字符是姓，其余是名
                    const lastName = newValue.slice(-1)
                    const firstName = newValue.slice(0, -1)

                    set(firstNameAtom, firstName)
                    set(lastNameAtom, lastName)
                }
            )

            // 创建顶层派生atom
            const greetingAtom = atom(
                (get) => `你好，${get(fullNameAtom)}！`,
                (get, set, newValue: string) => {
                    if (typeof newValue !== 'string') return

                    // 简单解析，移除"你好，"和"！"
                    const name = newValue.replace(/^你好，|！$/g, '')
                    set(fullNameAtom, name)
                }
            )

            // 检查初始值
            expect(store.getter(fullNameAtom)).toBe('张三')
            expect(store.getter(greetingAtom)).toBe('你好，张三！')

            // 通过中间层atom更新
            store.setter(fullNameAtom, '李四')
            expect(store.getter(firstNameAtom)).toBe('李')
            expect(store.getter(lastNameAtom)).toBe('四')
            expect(store.getter(fullNameAtom)).toBe('李四')
            expect(store.getter(greetingAtom)).toBe('你好，李四！')

            // 通过顶层atom更新
            store.setter(greetingAtom, '你好，王五！')
            expect(store.getter(firstNameAtom)).toBe('王')
            expect(store.getter(lastNameAtom)).toBe('五')
            expect(store.getter(fullNameAtom)).toBe('王五')
            expect(store.getter(greetingAtom)).toBe('你好，王五！')
        })

        test('带有副作用的写入操作', () => {
            const loggedActions: string[] = []

            const counterAtom = atom(0)

            // 创建带有日志记录副作用的包装atom
            const loggingCounterAtom = atom(
                (get) => get(counterAtom),
                (get, set, newValue: number | ((prev: number) => number)) => {
                    const prevValue = get(counterAtom)
                    const valueToSet = typeof newValue === 'function'
                        ? (newValue as Function)(prevValue)
                        : newValue

                    loggedActions.push(`Counter changed: ${prevValue} -> ${valueToSet}`)
                    set(counterAtom, valueToSet)
                }
            )

            // 初始状态
            expect(store.getter(loggingCounterAtom)).toBe(0)
            expect(loggedActions.length).toBe(0)

            // 进行更新
            store.setter(loggingCounterAtom, 5)
            expect(store.getter(loggingCounterAtom)).toBe(5)
            expect(loggedActions).toEqual(['Counter changed: 0 -> 5'])

            // 用函数更新
            store.setter(loggingCounterAtom, (prev) => prev + 3)
            expect(store.getter(loggingCounterAtom)).toBe(8)
            expect(loggedActions).toEqual([
                'Counter changed: 0 -> 5',
                'Counter changed: 5 -> 8'
            ])
        })
    })

    describe('复杂订阅场景', () => {
        test('应该只在值真正改变时通知订阅者', () => {
            const dataAtom = atom({ count: 0, text: 'hello' })
            const listener = jest.fn()

            store.sub(dataAtom, listener)

            // 更新为不同的对象，但内容相同，应该触发通知
            // 注：根据实现不同，可能不会通知，如果有深度比较的话
            store.setter(dataAtom, { count: 0, text: 'hello' })
            expect(listener).toHaveBeenCalledTimes(1)

            // 更新为同一个对象，应该不触发通知
            const sameObj = { count: 0, text: 'hello' }
            store.setter(dataAtom, sameObj)
            store.setter(dataAtom, sameObj)
            expect(listener).toHaveBeenCalledTimes(2)

            // 内容真正变化时应该触发通知
            store.setter(dataAtom, { count: 1, text: 'hello' })
            expect(listener).toHaveBeenCalledTimes(3)
        })

        test('间接依赖更新时的选择性通知', () => {
            const aAtom = atom({ value: 1 })
            const bAtom = atom({ value: 2 })

            // 派生atom1只依赖于aAtom
            const derivedAAtom = atom((get) => {
                const a = get(aAtom)
                return { result: a.value * 2 }
            })

            // 派生atom2依赖于aAtom和bAtom
            const derivedABAtom = atom((get) => {
                const a = get(aAtom)
                const b = get(bAtom)
                return { result: a.value + b.value }
            })

            const listenerA = jest.fn()
            const listenerAB = jest.fn()

            store.sub(derivedAAtom, listenerA)
            store.sub(derivedABAtom, listenerAB)

            // 更新aAtom，两个监听器都应该被通知
            store.setter(aAtom, { value: 3 })
            expect(listenerA).toHaveBeenCalledTimes(1)
            expect(listenerAB).toHaveBeenCalledTimes(1)

            // 更新bAtom，只有derivedABAtom的监听器应该被通知
            store.setter(bAtom, { value: 4 })
            expect(listenerA).toHaveBeenCalledTimes(1) // 仍是1，未增加
            expect(listenerAB).toHaveBeenCalledTimes(2)
        })
    })

    describe('高级缓存测试', () => {
        test('应该缓存计算结果直到依赖变化', () => {
            let computeCount = 0
            const countAtom = atom(1)

            // 创建一个计算成本较高的派生atom
            const expensiveAtom = atom((get) => {
                computeCount++
                return get(countAtom) * 10
            })

            // 第一次获取，应该计算
            expect(store.getter(expensiveAtom)).toBe(10)
            expect(computeCount).toBe(1)

            // 再次获取，应该使用缓存
            expect(store.getter(expensiveAtom)).toBe(10)
            expect(computeCount).toBe(1) // 未增加

            // 修改依赖，应该重新计算
            store.setter(countAtom, 2)
            expect(store.getter(expensiveAtom)).toBe(20)
            expect(computeCount).toBe(2)

            // 连续获取应该使用缓存
            for (let i = 0; i < 5; i++) {
                expect(store.getter(expensiveAtom)).toBe(20)
            }
            expect(computeCount).toBe(2) // 仍然是2，没有额外计算
        })
    })


    describe('大型状态树测试', () => {
        test('应该高效处理大型嵌套对象状态', () => {
            // 创建一个大型嵌套对象
            const createNestedObj = (depth: number, breadth: number, value: any): any => {
                if (depth <= 0) return value

                const result: any = {}
                for (let i = 0; i < breadth; i++) {
                    result[`key${i}`] = createNestedObj(depth - 1, breadth, value)
                }
                return result
            }

            // 创建深度和广度均为3的对象，大约27个终端节点
            const largeNestedObj = createNestedObj(3, 3, 42)
            const largeAtom = atom(largeNestedObj)

            // 验证能够读取
            expect(store.getter(largeAtom)).toBe(largeNestedObj)

            // 验证能够更新深层属性
            const updatedObj = { ...largeNestedObj }
            updatedObj.key1 = { ...updatedObj.key1 }
            updatedObj.key1.key2 = { ...updatedObj.key1.key2 }
            updatedObj.key1.key2.key0 = 99

            store.setter(largeAtom, updatedObj)
            const result = store.getter(largeAtom)
            expect(result.key1.key2.key0).toBe(99)
        })
    })
}) 