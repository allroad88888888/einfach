import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas - 键名与异常场景', () => {
  describe('特殊键名和字符', () => {
    const specialKeysObj = {
      'key with spaces': 'value1',
      'key.with.dots': 'value2',
      'key[with]brackets': 'value3',
      'key-with-dashes': 'value4',
      key_with_underscores: 'value5',
      '123numeric': 'value6',
      '@special!chars#': 'value7',
      中文键: 'chinese value',
      Ключ: 'russian value',
      '🚀emoji': 'emoji value',
      '': 'empty key value',
    }

    it('应该处理包含特殊字符的键名', () => {
      expect(easyHas(specialKeysObj, 'key with spaces')).toBe(true)
      expect(easyHas(specialKeysObj, ['key.with.dots'])).toBe(true)
      expect(easyHas(specialKeysObj, ['key[with]brackets'])).toBe(true)
      expect(easyHas(specialKeysObj, 'key-with-dashes')).toBe(true)
      expect(easyHas(specialKeysObj, 'key_with_underscores')).toBe(true)
      expect(easyHas(specialKeysObj, 'key.with.dots')).toBe(false)
    })

    it('应该正确处理路径分隔符', () => {
      const nestedObj = {
        key: {
          with: {
            dots: 'nested value',
          },
        },
      }

      expect(easyHas(nestedObj, 'key.with.dots')).toBe(true)
      expect(easyHas(nestedObj, ['key', 'with', 'dots'])).toBe(true)
    })

    it('应该处理数字开头和特殊字符的键名', () => {
      expect(easyHas(specialKeysObj, '123numeric')).toBe(true)
      expect(easyHas(specialKeysObj, '@special!chars#')).toBe(true)
    })

    it('应该处理国际化字符', () => {
      expect(easyHas(specialKeysObj, '中文键')).toBe(true)
      expect(easyHas(specialKeysObj, 'Ключ')).toBe(true)
      expect(easyHas(specialKeysObj, '🚀emoji')).toBe(true)
    })

    it('应该处理空字符串键', () => {
      expect(easyHas(specialKeysObj, '')).toBe(true)
    })
  })

  describe('异常和错误处理', () => {
    it('应该处理 getter 抛出错误的属性', () => {
      const objWithErrorGetter = {
        normalProp: 'normal',
        get errorProp() {
          throw new Error('Getter error')
        },
      }

      expect(easyHas(objWithErrorGetter, 'normalProp')).toBe(true)
      expect(easyHas(objWithErrorGetter, 'errorProp')).toBe(true)
    })

    it('应该处理 Proxy 对象', () => {
      const target = { a: 1, b: 2 }
      const proxy = new Proxy(target, {
        has(target, prop) {
          return prop === 'a' || prop === 'c'
        },
      })

      expect(easyHas(proxy, 'a')).toBe(true)
      expect(easyHas(proxy, 'b')).toBe(false)
      expect(easyHas(proxy, 'c')).toBe(true)
    })

    it('应该处理冻结和密封的对象', () => {
      const frozenObj = Object.freeze({ a: 1, b: 2 })
      const sealedObj = Object.seal({ x: 1, y: 2 })

      expect(easyHas(frozenObj, 'a')).toBe(true)
      expect(easyHas(frozenObj, 'c')).toBe(false)
      expect(easyHas(sealedObj, 'x')).toBe(true)
      expect(easyHas(sealedObj, 'z')).toBe(false)
    })
  })
})
