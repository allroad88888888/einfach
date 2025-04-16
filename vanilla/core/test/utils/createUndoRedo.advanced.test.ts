import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../../src'
import { createUndoRedo } from '../../src/utils/createUndoRedo'

describe('createUndoRedo高级测试', () => {
    let store: ReturnType<typeof createStore>
    let undoRedo: ReturnType<typeof createUndoRedo>

    beforeEach(() => {
        store = createStore()
        undoRedo = createUndoRedo(store)
    })

    test('应该处理复杂嵌套对象的状态变化', () => {
        // 创建一个包含嵌套数据的atom
        const complexAtom = atom({
            count: 0,
            nested: {
                value: 'initial',
                array: [1, 2, 3],
                deepNested: {
                    flag: true
                }
            }
        })

        undoRedo.watchAtom(complexAtom)

        // 修改嵌套属性
        store.setter(complexAtom, prev => ({
            ...prev,
            nested: {
                ...prev.nested,
                value: 'changed'
            }
        }))

        expect(store.getter(complexAtom).nested.value).toBe('changed')

        // 再次修改深层嵌套属性
        store.setter(complexAtom, prev => ({
            ...prev,
            nested: {
                ...prev.nested,
                deepNested: {
                    flag: false
                }
            }
        }))

        expect(store.getter(complexAtom).nested.deepNested.flag).toBe(false)

        // 撤销深层修改
        undoRedo.undo()
        expect(store.getter(complexAtom).nested.deepNested.flag).toBe(true)
        expect(store.getter(complexAtom).nested.value).toBe('changed')

        // 撤销第一次修改
        undoRedo.undo()
        expect(store.getter(complexAtom).nested.value).toBe('initial')
    })

    test('应该支持多次连续的undo/redo操作', () => {
        const countAtom = atom(0)
        undoRedo.watchAtom(countAtom)

        // 连续修改5次
        for (let i = 1; i <= 5; i++) {
            store.setter(countAtom, i)
        }

        expect(store.getter(countAtom)).toBe(5)

        // 连续撤销3次
        undoRedo.undo() // 5 -> 4
        undoRedo.undo() // 4 -> 3
        undoRedo.undo() // 3 -> 2

        expect(store.getter(countAtom)).toBe(2)

        // 连续重做2次
        undoRedo.redo() // 2 -> 3
        undoRedo.redo() // 3 -> 4

        expect(store.getter(countAtom)).toBe(4)

        // 再次修改值，应该清除重做历史
        store.setter(countAtom, 10)

        expect(store.getter(countAtom)).toBe(10)
        expect(store.getter(undoRedo.redoAtom)).toBe(false)

        // 应该可以撤销到2
        undoRedo.undo() // 10 -> 4
        undoRedo.undo() // 4 -> 3
        undoRedo.undo() // 3 -> 2

        expect(store.getter(countAtom)).toBe(2)
    })

    test('mergeState应该在错误处理中正确回滚', () => {
        const countAtom = atom(0)
        undoRedo.watchAtom(countAtom)

        // 模拟一个可能会抛出错误的mergeState操作
        try {
            undoRedo.mergeState(() => {
                store.setter(countAtom, 5)
                throw new Error('模拟错误')
            })
        } catch (e: unknown) {
            // 预期会捕获到错误
            if (e instanceof Error) {
                expect(e.message).toBe('模拟错误')
            }
        }

        // 检查状态是否被正确回滚
        expect(store.getter(countAtom)).toBe(0)
    })

    test('应该正确处理大量连续操作', () => {
        const countAtom = atom(0)
        undoRedo.watchAtom(countAtom)

        // 执行50次修改
        for (let i = 1; i <= 50; i++) {
            store.setter(countAtom, i)
        }

        expect(store.getter(countAtom)).toBe(50)

        // 执行25次撤销
        for (let i = 0; i < 25; i++) {
            undoRedo.undo()
        }

        expect(store.getter(countAtom)).toBe(25)

        // 执行10次重做
        for (let i = 0; i < 10; i++) {
            undoRedo.redo()
        }

        expect(store.getter(countAtom)).toBe(35)
    })

    test('测试同时监控多个复杂的atom', () => {
        const countAtom = atom(0)
        const objectAtom = atom({ name: '初始', list: [1, 2, 3] })
        const flagAtom = atom(true)

        undoRedo.watchAtom(countAtom)
        undoRedo.watchAtom(objectAtom)
        undoRedo.watchAtom(flagAtom)

        // 按特定顺序修改多个atom
        store.setter(countAtom, 1) // 第1步
        store.setter(objectAtom, prev => ({ ...prev, name: '修改1' })) // 第2步
        store.setter(flagAtom, false) // 第3步
        store.setter(objectAtom, prev => ({ ...prev, list: [...prev.list, 4] })) // 第4步
        store.setter(countAtom, 2) // 第5步

        expect(store.getter(countAtom)).toBe(2)
        expect(store.getter(objectAtom).name).toBe('修改1')
        expect(store.getter(objectAtom).list).toEqual([1, 2, 3, 4])
        expect(store.getter(flagAtom)).toBe(false)

        // 按照相反顺序撤销
        undoRedo.undo() // 撤销第5步
        expect(store.getter(countAtom)).toBe(1)

        undoRedo.undo() // 撤销第4步
        expect(store.getter(objectAtom).list).toEqual([1, 2, 3])

        undoRedo.undo() // 撤销第3步
        expect(store.getter(flagAtom)).toBe(true)

        undoRedo.undo() // 撤销第2步
        expect(store.getter(objectAtom).name).toBe('初始')

        undoRedo.undo() // 撤销第1步
        expect(store.getter(countAtom)).toBe(0)
    })

    test('resetByNow应该正确处理复杂的历史记录', () => {
        const countAtom = atom(0)
        const textAtom = atom('初始文本')

        undoRedo.watchAtom(countAtom)
        undoRedo.watchAtom(textAtom)

        // 创建复杂的修改历史
        store.setter(countAtom, 10)
        store.setter(textAtom, '文本1')
        store.setter(countAtom, 20)
        store.setter(textAtom, '文本2')
        store.setter(countAtom, 30)

        // 撤销几次
        undoRedo.undo() // 撤销 countAtom 30 -> 20
        undoRedo.undo() // 撤销 textAtom '文本2' -> '文本1'

        expect(store.getter(countAtom)).toBe(20)
        expect(store.getter(textAtom)).toBe('文本1')

        // 重置
        undoRedo.resetByNow()

        // 验证当前状态被保留为初始状态
        expect(store.getter(countAtom)).toBe(20)
        expect(store.getter(textAtom)).toBe('文本1')

        // 不能再撤销或重做
        expect(store.getter(undoRedo.undoAtom)).toBe(false)
        expect(store.getter(undoRedo.redoAtom)).toBe(false)

        // 再次修改值
        store.setter(countAtom, 50)

        // 现在应该可以撤销
        expect(store.getter(undoRedo.undoAtom)).toBe(true)
        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(20)
    })

    test('模拟性能测试 - 频繁的状态更新', () => {
        // 创建一个计数atom
        const countAtom = atom(0)
        undoRedo.watchAtom(countAtom)

        // 执行100次快速修改
        const start = Date.now()
        for (let i = 1; i <= 100; i++) {
            store.setter(countAtom, i)
        }
        const duration = Date.now() - start

        // 验证最终状态正确
        expect(store.getter(countAtom)).toBe(100)

        // 确认可以撤销
        expect(store.getter(undoRedo.undoAtom)).toBe(true)

        // 执行50次撤销
        for (let i = 0; i < 50; i++) {
            undoRedo.undo()
        }

        // 验证状态正确
        expect(store.getter(countAtom)).toBe(50)

        // 记录测试性能信息
        console.log(`100次更新耗时: ${duration}ms`)
    })
}) 