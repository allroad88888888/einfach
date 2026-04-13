import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom } from '@einfach/core'
import { useAtomCallback } from '../src/useAtomCallback'
import { useAtomValue } from '../src/useAtomValue'

describe('useAtomCallback - 参数与依赖场景', () => {
  it('测试多参数传递', async () => {
    const dataAtom = atom<{ x: number; y: number }>({ x: 0, y: 0 })

    const { result } = renderHook(() => {
      const updateData = useAtomCallback((get, set, x: number, y: number, operation: string) => {
        const current = get(dataAtom)
        let newData: { x: number; y: number }

        switch (operation) {
          case 'add':
            newData = { x: current.x + x, y: current.y + y }
            break
          case 'multiply':
            newData = { x: current.x * x, y: current.y * y }
            break
          default:
            newData = { x, y }
        }

        set(dataAtom, newData)
        return newData
      }, [])

      const data = useAtomValue(dataAtom)
      return { updateData, data }
    })

    act(() => {
      const newData = result.current.updateData(5, 10, 'add')
      expect(newData).toEqual({ x: 5, y: 10 })
    })

    expect(result.current.data).toEqual({ x: 5, y: 10 })

    act(() => {
      const newData = result.current.updateData(2, 3, 'multiply')
      expect(newData).toEqual({ x: 10, y: 30 })
    })

    expect(result.current.data).toEqual({ x: 10, y: 30 })
  })

  it('测试 watchParams - 依赖不变时复用 atom', async () => {
    const countAtom = atom(0)
    let callbackCreateCount = 0

    const { result, rerender } = renderHook(
      ({ multiplier }) => {
        const callback = useAtomCallback(
          (get, set, value: number) => {
            callbackCreateCount++
            const result = value * multiplier
            set(countAtom, result)
            return result
          },
          [multiplier],
        )

        const count = useAtomValue(countAtom)
        return { callback, count }
      },
      { initialProps: { multiplier: 2 } },
    )

    act(() => {
      result.current.callback(5)
    })
    expect(result.current.count).toBe(10)
    expect(callbackCreateCount).toBe(1)

    rerender({ multiplier: 2 })
    act(() => {
      result.current.callback(3)
    })
    expect(result.current.count).toBe(6)
    expect(callbackCreateCount).toBe(2)
  })

  it('测试 watchParams - 依赖变化时重新创建回调逻辑', async () => {
    const countAtom = atom(0)

    const { result, rerender } = renderHook(
      ({ multiplier }) => {
        const callback = useAtomCallback(
          (get, set, value: number) => {
            const result = value * multiplier
            set(countAtom, result)
            return result
          },
          [multiplier],
        )

        const count = useAtomValue(countAtom)
        return { callback, count, multiplier }
      },
      { initialProps: { multiplier: 2 } },
    )

    act(() => {
      result.current.callback(5)
    })
    expect(result.current.count).toBe(10)

    rerender({ multiplier: 3 })
    act(() => {
      result.current.callback(5)
    })
    expect(result.current.count).toBe(15)
  })

  it('测试 watchParams - 外部变量变化的影响', async () => {
    const resultAtom = atom<string>('')

    const { result, rerender } = renderHook(
      ({ prefix, suffix }) => {
        const formatMessage = useAtomCallback(
          (get, set, message: string) => {
            const formatted = `${prefix}${message}${suffix}`
            set(resultAtom, formatted)
            return formatted
          },
          [prefix, suffix],
        )

        const result = useAtomValue(resultAtom)
        return { formatMessage, result }
      },
      { initialProps: { prefix: '[', suffix: ']' } },
    )

    act(() => {
      const formatted = result.current.formatMessage('Hello')
      expect(formatted).toBe('[Hello]')
    })
    expect(result.current.result).toBe('[Hello]')

    rerender({ prefix: '(', suffix: ')' })
    act(() => {
      const formatted = result.current.formatMessage('World')
      expect(formatted).toBe('(World)')
    })
    expect(result.current.result).toBe('(World)')
  })
})
