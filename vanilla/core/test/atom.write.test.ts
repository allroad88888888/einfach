import { describe, test, expect, beforeEach } from '@jest/globals'
import { atom, createStore } from '../src'

describe('atom复杂场景测试 - 写入链路', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('高级写入场景', () => {
    test('具有多层写入的可写派生atom', () => {
      const firstNameAtom = atom('张')
      const lastNameAtom = atom('三')

      const fullNameAtom = atom(
        (get) => `${get(firstNameAtom)}${get(lastNameAtom)}`,
        (get, set, newValue: string) => {
          if (typeof newValue !== 'string') return

          const lastName = newValue.slice(-1)
          const firstName = newValue.slice(0, -1)

          set(firstNameAtom, firstName)
          set(lastNameAtom, lastName)
        },
      )

      const greetingAtom = atom(
        (get) => `你好，${get(fullNameAtom)}！`,
        (get, set, newValue: string) => {
          if (typeof newValue !== 'string') return

          const name = newValue.replace(/^你好，|！$/g, '')
          set(fullNameAtom, name)
        },
      )

      expect(store.getter(fullNameAtom)).toBe('张三')
      expect(store.getter(greetingAtom)).toBe('你好，张三！')

      store.setter(fullNameAtom, '李四')
      expect(store.getter(firstNameAtom)).toBe('李')
      expect(store.getter(lastNameAtom)).toBe('四')
      expect(store.getter(fullNameAtom)).toBe('李四')
      expect(store.getter(greetingAtom)).toBe('你好，李四！')

      store.setter(greetingAtom, '你好，王五！')
      expect(store.getter(firstNameAtom)).toBe('王')
      expect(store.getter(lastNameAtom)).toBe('五')
      expect(store.getter(fullNameAtom)).toBe('王五')
      expect(store.getter(greetingAtom)).toBe('你好，王五！')
    })

    test('带有副作用的写入操作', () => {
      const loggedActions: string[] = []
      const counterAtom = atom(0)

      const loggingCounterAtom = atom(
        (get) => get(counterAtom),
        (get, set, newValue: number | ((prev: number) => number)) => {
          const prevValue = get(counterAtom)
          const valueToSet = typeof newValue === 'function' ? (newValue as Function)(prevValue) : newValue

          loggedActions.push(`Counter changed: ${prevValue} -> ${valueToSet}`)
          set(counterAtom, valueToSet)
        },
      )

      expect(store.getter(loggingCounterAtom)).toBe(0)
      expect(loggedActions.length).toBe(0)

      store.setter(loggingCounterAtom, 5)
      expect(store.getter(loggingCounterAtom)).toBe(5)
      expect(loggedActions).toEqual(['Counter changed: 0 -> 5'])

      store.setter(loggingCounterAtom, (prev) => prev + 3)
      expect(store.getter(loggingCounterAtom)).toBe(8)
      expect(loggedActions).toEqual(['Counter changed: 0 -> 5', 'Counter changed: 5 -> 8'])
    })
  })
})
