import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom } from '@einfach/core'
import { useAtomCallback } from '../src/useAtomCallback'
import { useAtomValue } from '../src/useAtomValue'

describe('useAtomCallback - this 绑定场景', () => {
  it('测试 this 指向问题 - 使用 bind 可以保持 this 绑定', async () => {
    const messageAtom = atom('')

    class MessageHandler {
      prefix = 'Handler: '

      formatMessage(get: any, set: any, message: string) {
        const formatted = this?.prefix ? this.prefix + message : message
        set(messageAtom, formatted)
        return formatted
      }
    }

    const handler = new MessageHandler()

    const { result } = renderHook(() => {
      const callback = useAtomCallback(handler.formatMessage.bind(handler), [])
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
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
        try {
          const formatted = this.prefix + message
          set(messageAtom, formatted)
          return formatted
        } catch (error) {
          set(messageAtom, 'Error: ' + message)
          return 'Error: ' + message
        }
      }
    }

    const handler = new MessageHandler()

    const { result } = renderHook(() => {
      const callback = useAtomCallback(handler.formatMessage, [])
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
      const formatted = result.current.callback('Hello')
      expect(formatted).toBe('Error: Hello')
    })

    expect(result.current.message).toBe('Error: Hello')
  })

  it('测试箭头函数不受 this 影响', async () => {
    const resultAtom = atom(0)

    class Calculator {
      multiplier = 10

      multiply = (get: any, set: any, value: number) => {
        const result = value * this.multiplier
        set(resultAtom, result)
        return result
      }
    }

    const calc = new Calculator()

    const { result } = renderHook(() => {
      const callback = useAtomCallback(calc.multiply, [])
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
          set(messageAtom, 'Error: ' + message)
          return 'Error: ' + message
        }
      }
    }

    const handler = new MessageHandler()

    const callbackWithApplyVoid = (get: any, set: any, message: string) => {
      return handler.formatMessage.apply(void 0, [get, set, message])
    }

    const { result } = renderHook(() => {
      const callback = useAtomCallback(callbackWithApplyVoid, [])
      const message = useAtomValue(messageAtom)
      return { callback, message }
    })

    act(() => {
      const formatted = result.current.callback('Hello')
      expect(formatted).toBe('Error: Hello')
    })

    expect(result.current.message).toBe('Error: Hello')
  })
})
