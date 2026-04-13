import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas - 集合与特殊对象场景', () => {
  describe('混合数据类型复杂结构', () => {
    const complexObj = {
      users: [
        {
          id: 1,
          profile: {
            name: 'Alice',
            contacts: {
              emails: ['alice@example.com', 'alice.work@company.com'],
              phones: new Map<string, string>([
                ['home', '123-456-7890'],
                ['work', '098-765-4321'],
              ]),
            },
            settings: new Set(['dark-mode', 'notifications', 'auto-save']),
          },
          permissions: {
            admin: false,
            modules: ['read', 'write'],
          },
        },
        {
          id: 2,
          profile: {
            name: 'Bob',
            contacts: {
              emails: [],
              phones: new Map<string, string>(),
            },
            settings: new Set(),
          },
        },
      ],
      metadata: {
        version: '1.0.0',
        features: {
          experimental: {
            enabled: true,
            list: ['feature-a', 'feature-b'],
          },
        },
      },
    }

    it('应该处理数组中对象的复杂嵌套', () => {
      expect(easyHas(complexObj, 'users.0.profile.name')).toBe(true)
      expect(easyHas(complexObj, 'users.0.profile.contacts.emails.0')).toBe(true)
      expect(easyHas(complexObj, 'users.0.profile.contacts.emails.1')).toBe(true)
      expect(easyHas(complexObj, 'users.0.profile.contacts.emails.2')).toBe(false)
      expect(easyHas(complexObj, 'users.1.profile.contacts.emails.0')).toBe(false)
    })

    it('应该处理 Map 在复杂结构中的嵌套', () => {
      expect(easyHas(complexObj, 'users.0.profile.contacts.phones')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.contacts.phones, 'home')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.contacts.phones, 'mobile')).toBe(false)
    })

    it('应该处理 Set 在复杂结构中的嵌套', () => {
      expect(easyHas(complexObj, 'users.0.profile.settings')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.settings, '0')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.settings, '2')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.settings, '3')).toBe(false)
    })

    it('应该处理空集合', () => {
      expect(easyHas(complexObj, 'users.1.profile.contacts.emails')).toBe(true)
      expect(easyHas(complexObj, 'users.1.profile.contacts.emails.0')).toBe(false)
      expect(easyHas(complexObj.users[1].profile.contacts.phones, 'any')).toBe(false)
      expect(easyHas(complexObj.users[1].profile.settings, '0')).toBe(false)
    })
  })

  describe('Symbol 键', () => {
    const symbolKey = Symbol('test')
    const symbolObj = {
      [symbolKey]: 'symbol value',
      normalKey: 'normal value',
    }

    it('应该处理 Symbol 键', () => {
      expect(easyHas(symbolObj, 'normalKey')).toBe(true)
      expect(symbolKey in symbolObj).toBe(true)
    })
  })

  describe('类型化数组和特殊对象', () => {
    it('应该处理 TypedArray', () => {
      const int32Array = new Int32Array([1, 2, 3, 4, 5])
      const float64Array = new Float64Array([1.1, 2.2, 3.3])

      expect(easyHas(int32Array, '0')).toBe(true)
      expect(easyHas(int32Array, '4')).toBe(true)
      expect(easyHas(int32Array, '5')).toBe(false)
      expect(easyHas(int32Array, 'length')).toBe(true)

      expect(easyHas(float64Array, '0')).toBe(true)
      expect(easyHas(float64Array, '2')).toBe(true)
      expect(easyHas(float64Array, '3')).toBe(false)
    })

    it('应该处理 ArrayBuffer 和 DataView', () => {
      const buffer = new ArrayBuffer(16)
      const view = new DataView(buffer)

      expect(easyHas(buffer, 'byteLength')).toBe(true)
      expect(easyHas(view, 'buffer')).toBe(true)
      expect(easyHas(view, 'byteLength')).toBe(true)
    })

    it('应该处理 Date 对象', () => {
      const date = new Date()

      expect(easyHas(date, 'getTime')).toBe(true)
      expect(easyHas(date, 'getFullYear')).toBe(true)
      expect(easyHas(date, 'nonexistent')).toBe(false)
    })

    it('应该处理 RegExp 对象', () => {
      const regex = /test/gi

      expect(easyHas(regex, 'test')).toBe(true)
      expect(easyHas(regex, 'source')).toBe(true)
      expect(easyHas(regex, 'flags')).toBe(true)
      expect(easyHas(regex, 'global')).toBe(true)
    })
  })

  describe('WeakMap 和 WeakSet 边界情况', () => {
    it('应该处理 WeakMap', () => {
      const key1 = {}
      const weakMap = new WeakMap([[key1, 'value1']])

      expect(() => easyHas(weakMap, 'someKey')).not.toThrow()
    })

    it('应该处理 WeakSet', () => {
      const obj1 = {}
      const weakSet = new WeakSet([obj1])

      expect(() => easyHas(weakSet, 'someKey')).not.toThrow()
    })
  })
})
