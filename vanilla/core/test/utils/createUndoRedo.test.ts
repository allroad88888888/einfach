import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../../src'
import { createUndoRedo } from '../../src/utils/createUndoRedo'

describe('createUndoRedo', () => {
    let store: ReturnType<typeof createStore>
    let undoRedo: ReturnType<typeof createUndoRedo>

    beforeEach(() => {
        store = createStore()
        undoRedo = createUndoRedo(store)
    })

    test('应该正确创建undo/redo系统', () => {
        expect(undoRedo.undoAtom).toBeDefined()
        expect(undoRedo.redoAtom).toBeDefined()
        expect(typeof undoRedo.watchAtom).toBe('function')
        expect(typeof undoRedo.undo).toBe('function')
        expect(typeof undoRedo.redo).toBe('function')
        expect(typeof undoRedo.mergeState).toBe('function')
        expect(typeof undoRedo.resetByNow).toBe('function')
    })

    test('watchAtom应该记录atom状态变化', () => {
        const countAtom = atom(0)

        // 监听atom变化
        undoRedo.watchAtom(countAtom)

        // 初始状态不能撤销或重做
        expect(store.getter(undoRedo.undoAtom)).toBe(false)
        expect(store.getter(undoRedo.redoAtom)).toBe(false)

        // 更改值
        store.setter(countAtom, 1)

        // 此时应该可以撤销
        expect(store.getter(undoRedo.undoAtom)).toBe(true)
        expect(store.getter(undoRedo.redoAtom)).toBe(false)
    })

    test('undo应该恢复之前的状态', () => {
        const countAtom = atom(0)

        undoRedo.watchAtom(countAtom)

        // 修改值
        store.setter(countAtom, 10)
        expect(store.getter(countAtom)).toBe(10)

        // 撤销
        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(0)

        // 此时应该不能再撤销，但可以重做
        expect(store.getter(undoRedo.undoAtom)).toBe(false)
        expect(store.getter(undoRedo.redoAtom)).toBe(true)
    })

    test('redo应该重新应用已撤销的更改', () => {
        const countAtom = atom(0)

        undoRedo.watchAtom(countAtom)

        // 修改值
        store.setter(countAtom, 10)

        // 撤销
        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(0)

        // 重做
        undoRedo.redo()
        expect(store.getter(countAtom)).toBe(10)
    })

    test('mergeState应该将多个更改合并为一个撤销步骤', () => {
        const countAtom = atom(0)

        undoRedo.watchAtom(countAtom)

        // 使用mergeState合并多个更改
        undoRedo.mergeState(() => {
            store.setter(countAtom, 5)
            store.setter(countAtom, 10)
        })

        expect(store.getter(countAtom)).toBe(10)

        // 撤销一次应该直接回到初始状态
        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(0)
    })

    test('resetByNow应该重置为当前状态', () => {
        const countAtom = atom(0)

        undoRedo.watchAtom(countAtom)

        // 修改几次
        store.setter(countAtom, 5)
        store.setter(countAtom, 10)

        // 撤销一次
        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(5)

        // 重置
        undoRedo.resetByNow()

        // 此时不应该能撤销或重做
        expect(store.getter(undoRedo.undoAtom)).toBe(false)
        expect(store.getter(undoRedo.redoAtom)).toBe(false)
    })

    test('应该能同时监控多个atom的状态变化', () => {
        const countAtom = atom(0)
        const textAtom = atom('初始文本')

        undoRedo.watchAtom(countAtom)
        undoRedo.watchAtom(textAtom)

        // 修改两个atom
        store.setter(countAtom, 5)
        store.setter(textAtom, '修改后文本')

        expect(store.getter(countAtom)).toBe(5)
        expect(store.getter(textAtom)).toBe('修改后文本')

        // 撤销两次应该分别撤销各自的更改
        undoRedo.undo()
        expect(store.getter(textAtom)).toBe('初始文本')
        expect(store.getter(countAtom)).toBe(5)

        undoRedo.undo()
        expect(store.getter(countAtom)).toBe(0)
    })
}) 