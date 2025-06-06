import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom } from '@einfach/core'
import { useAtomCallback } from '../src/useAtomCallback'
import { useAtomValue } from '../src/useAtomValue'

describe('useAtomCallback', () => {
  it('基本功能测试', async () => {
    const countAtom = atom(0)

    const { result } = renderHook(() => {
      const callback = useAtomCallback((get, set, increment: number) => {
        const current = get(countAtom)
        set(countAtom, current + increment)
        return current + increment
      })

      const count = useAtomValue(countAtom)
      return { callback, count }
    })

    expect(result.current.count).toBe(0)

    act(() => {
      const newValue = result.current.callback(5)
      expect(newValue).toBe(5)
    })

    expect(result.current.count).toBe(5)
  })

  it('测试 this 指向问题 - 使用 bind 可以保持 this 绑定', async () => {
    const messageAtom = atom('')

    class MessageHandler {
      prefix = 'Handler: '

      formatMessage(get: any, set: any, message: string) {
        // 当使用 bind 时，this 会被正确绑定到 MessageHandler 实例
        const formatted = this?.prefix ? this.prefix + message : message
        set(messageAtom, formatted)
        return formatted
      }
    }

    const handler = new MessageHandler()

    const { result } = renderHook(() => {
      // 使用 bind 明确绑定 this 上下文
      const callback = useAtomCallback(handler.formatMessage.bind(handler))
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
      // 使用 bind 可以保持 this 指向
      const formatted = result.current.callback('Hello')
      expect(formatted).toBe('Handler: Hello')
    })

    expect(result.current.message).toBe('Handler: Hello')
  })

  it('测试 this 指向问题 - 直接传递方法仍会丢失 this', async () => {
    const messageAtom = atom('')

    class MessageHandler {
      prefix = 'Handler: '

      formatMessage(get: any, set: any, message: string) {
        // 当方法被作为参数传递时，this 上下文会丢失
        // 即使我们修复了 apply(void 0, ...) 问题
        try {
          const formatted = this.prefix + message
          set(messageAtom, formatted)
          return formatted
        } catch (error) {
          // this 为 undefined 时会进入此分支
          set(messageAtom, 'Error: ' + message)
          return 'Error: ' + message
        }
      }
    }

    const handler = new MessageHandler()

    const { result } = renderHook(() => {
      // 直接传递方法，this 上下文丢失
      const callback = useAtomCallback(handler.formatMessage)
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
      const formatted = result.current.callback('Hello')
      // 由于 this 丢失，会执行 catch 分支
      expect(formatted).toBe('Error: Hello')
    })

    expect(result.current.message).toBe('Error: Hello')
  })

  it('测试箭头函数不受 this 影响', async () => {
    const resultAtom = atom(0)

    class Calculator {
      multiplier = 10

      // 箭头函数会保持词法作用域的 this
      multiply = (get: any, set: any, value: number) => {
        const result = value * this.multiplier
        set(resultAtom, result)
        return result
      }
    }

    const calc = new Calculator()

    const { result } = renderHook(() => {
      const callback = useAtomCallback(calc.multiply)
      const result = useAtomValue(resultAtom)
      return { callback, result }
    })

    act(() => {
      const calculated = result.current.callback(5)
      expect(calculated).toBe(50)
    })

    expect(result.current.result).toBe(50)
  })

  it('理解 this 丢失的原因 - apply(void 0) 强制设置 this 为 undefined', async () => {
    const messageAtom = atom('')

    class MessageHandler {
      prefix = 'Handler: '

      formatMessage(get: any, set: any, message: string) {
        try {
          const formatted = this.prefix + message
          set(messageAtom, formatted)
          return formatted
        } catch (error) {
          // 当 this 为 undefined 时会进入这里
          set(messageAtom, 'Error: ' + message)
          return 'Error: ' + message
        }
      }
    }

    const handler = new MessageHandler()

    // 演示 apply(void 0, ...) 的行为
    const callbackWithApplyVoid = (get: any, set: any, message: string) => {
      // 即使传入正确的方法，apply(void 0, ...) 也会强制将 this 设为 undefined
      return handler.formatMessage.apply(void 0, [get, set, message])
    }

    const { result } = renderHook(() => {
      const callback = useAtomCallback(callbackWithApplyVoid)
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
      const formatted = result.current.callback('Hello')
      // 由于 apply(void 0, ...) 强制设置 this 为 undefined，会进入 catch 分支
      expect(formatted).toBe('Error: Hello')
    })

    expect(result.current.message).toBe('Error: Hello')
  })

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
      })

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
})
