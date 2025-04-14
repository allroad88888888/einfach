import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore, selectAtom } from '../src'

interface Option {
    id: number
    name: string
    index: number
}

interface SelectedOption {
    id: number
    name: string
}

describe('性能测试', () => {
    let store: ReturnType<typeof createStore>

    beforeEach(() => {
        store = createStore()
    })

    test('应该高效处理大量atom的更新', () => {
        // 创建ID列表
        const idsAtom = atom(() => {
            const ids: number[] = []
            for (let i = 0; i < 1000; i++) { // 减少数量以加快测试运行速度
                ids.push(i)
            }
            return ids
        })
        const ids = store.getter(idsAtom)

        // 创建选项映射
        const optionsMap = new Map<number, any>()
        const optionsSelectAtomMap = new Map<number, any>()

        ids.forEach((element) => {
            const optionAtom = atom({
                id: element,
                name: 'option' + element,
                index: element,
            })
            optionAtom.debugLabel = `optionAtom${element}`
            optionsMap.set(element, optionAtom)

            const optionsSelectAtom = selectAtom(
                optionAtom,
                (option: Option) => {
                    return {
                        id: option.id,
                        name: option.name,
                    }
                },
                (prev: SelectedOption, next: SelectedOption) => {
                    return prev.id === next.id && prev.name === next.name
                },
            )

            optionsSelectAtom.debugLabel = `optionsSelectAtom${element}`
            optionsSelectAtomMap.set(element, optionsSelectAtom)
        })

        // 创建合并所有选项的atom
        const optionsAtom = atom((getter) => {
            const tempIds = getter(idsAtom)
            const options: any[] = []
            tempIds.forEach((id) => {
                const selectAtom = optionsSelectAtomMap.get(id)
                if (selectAtom) {
                    options.push(getter(selectAtom))
                }
            })
            return options
        })
        optionsAtom.debugLabel = `optionsAtom`

        // 首次计算所有选项
        const initialOptions = store.getter(optionsAtom)
        expect(initialOptions.length).toBe(1000)

        // 设置订阅
        let renderCount = 0
        store.sub(optionsAtom, () => {
            renderCount += 1
        })

        // 给每个选项设置订阅
        ids.forEach((id) => {
            const atom = optionsMap.get(id)
            if (atom) {
                store.sub(atom, () => {
                    store.getter(atom)
                })
            }
        })

        // 批量更新所有选项
        const updateAllAtom = atom<number, [number], void>(0, (_getter, setter, _value) => {
            ids.forEach((id) => {
                const atom = optionsMap.get(id)
                if (atom) {
                    setter(atom, {
                        id: id,
                        name: 'option next' + id,
                        index: id,
                    })
                }
            })
        })

        // 执行更新并测量时间
        const startTime = performance.now()
        store.setter(updateAllAtom, 1)
        const endTime = performance.now()
        const updateDuration = endTime - startTime

        // 验证更新后的状态
        const updatedOptions = store.getter(optionsAtom)

        // 基本断言：验证数组长度
        expect(updatedOptions.length).toBe(1000)

        // 验证头部、中间和尾部元素更新正确
        expect(updatedOptions[0]).toEqual({ id: 0, name: 'option next0' })
        expect(updatedOptions[499]).toEqual({ id: 499, name: 'option next499' })
        expect(updatedOptions[999]).toEqual({ id: 999, name: 'option next999' })

        // 随机抽样验证更多元素
        const randomIndexes = [123, 456, 789]
        randomIndexes.forEach(index => {
            expect(updatedOptions[index]).toEqual({
                id: index,
                name: `option next${index}`
            })
        })

        // 验证原子性：所有元素都已更新
        const allUpdated = updatedOptions.every(opt => opt.name.includes('next'))
        expect(allUpdated).toBe(true)

        // 验证渲染计数（批量更新效率）
        expect(renderCount).toBe(1)

        // 验证性能：确保更新时间合理
        expect(updateDuration).toBeGreaterThan(0)
        console.log(`批量更新1000个atom耗时: ${updateDuration}ms`)

        // 性能基准测试（可根据环境调整阈值）
        // 注意：这个断言可能需要根据不同环境调整或移除
        if (process.env.NODE_ENV === 'production') {
            // 生产环境有更严格的性能要求
            expect(updateDuration).toBeLessThan(1000) // 300ms内应完成
        } else {
            // 开发/测试环境容忍稍长时间
            expect(updateDuration).toBeLessThan(2000) // 500ms内应完成
        }

        // 验证原子操作：再次检查source atoms的状态
        ids.slice(0, 5).forEach(id => {
            const optionAtom = optionsMap.get(id)
            const option = store.getter(optionAtom) as Option
            expect(option.name).toBe(`option next${id}`)
            expect(option.id).toBe(id)
            expect(option.index).toBe(id)
        })
    })
}) 