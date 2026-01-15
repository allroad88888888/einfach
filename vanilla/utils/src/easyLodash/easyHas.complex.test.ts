import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas - 复杂场景测试', () => {
  describe('深层嵌套对象', () => {
    const deepObj = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  level7: {
                    value: 'deep value',
                    array: [1, 2, { nested: true }],
                  },
                },
              },
            },
          },
        },
      },
    }

    it('应该处理超深层嵌套路径', () => {
      expect(easyHas(deepObj, 'level1.level2.level3.level4.level5.level6.level7.value')).toBe(true)
      expect(
        easyHas(deepObj, 'level1.level2.level3.level4.level5.level6.level7.array.2.nested'),
      ).toBe(true)
      expect(easyHas(deepObj, 'level1.level2.level3.level4.level5.level6.level7.nonexistent')).toBe(
        false,
      )
      expect(easyHas(deepObj, 'level1.level2.level3.level4.level5.level6.level8')).toBe(false)
    })

    it('应该支持超深层数组路径', () => {
      const path = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'value']
      expect(easyHas(deepObj, path)).toBe(true)

      const wrongPath = [
        'level1',
        'level2',
        'level3',
        'level4',
        'level5',
        'level6',
        'level7',
        'wrong',
      ]
      expect(easyHas(wrongPath, wrongPath)).toBe(false)
    })
  })

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
      // 注意：由于 phones 是 Map，直接用字符串键访问
      expect(easyHas(complexObj.users[0].profile.contacts.phones, 'home')).toBe(true)
      expect(easyHas(complexObj.users[0].profile.contacts.phones, 'mobile')).toBe(false)
    })

    it('应该处理 Set 在复杂结构中的嵌套', () => {
      expect(easyHas(complexObj, 'users.0.profile.settings')).toBe(true)
      // 注意：Set 通过索引访问
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
      // 包含点的键名需要使用数组路径，因为点号会被当作路径分隔符
      expect(easyHas(specialKeysObj, ['key.with.dots'])).toBe(true)
      expect(easyHas(specialKeysObj, ['key[with]brackets'])).toBe(true)
      expect(easyHas(specialKeysObj, 'key-with-dashes')).toBe(true)
      expect(easyHas(specialKeysObj, 'key_with_underscores')).toBe(true)

      // 验证点号确实被当作路径分隔符
      expect(easyHas(specialKeysObj, 'key.with.dots')).toBe(false) // 这会查找 key -> with -> dots
    })

    it('应该正确处理路径分隔符', () => {
      const nestedObj = {
        key: {
          with: {
            dots: 'nested value',
          },
        },
      }

      // 这种情况下点号路径应该工作
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

  describe('原型链和继承', () => {
    class BaseClass {
      baseProperty = 'base value'
      baseMethod() {
        return 'base method'
      }
    }

    class ExtendedClass extends BaseClass {
      extendedProperty = 'extended value'
      extendedMethod() {
        return 'extended method'
      }
    }

    const instance = new ExtendedClass()

    it('应该检测实例自有属性', () => {
      expect(easyHas(instance, 'extendedProperty')).toBe(true)
      expect(easyHas(instance, 'baseProperty')).toBe(true)
    })

    it('应该检测原型链上的方法', () => {
      expect(easyHas(instance, 'extendedMethod')).toBe(true)
      expect(easyHas(instance, 'baseMethod')).toBe(true)
      expect(easyHas(instance, 'toString')).toBe(true) // Object.prototype.toString
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
      // Symbol 键需要直接使用 Symbol
      expect(symbolKey in symbolObj).toBe(true)
      // Symbol 不是 NamePath 类型，所以跳过这个测试
      // expect(easyHas(symbolObj, symbolKey)).toBe(true)
    })
  })

  describe('循环引用', () => {
    it('应该处理循环引用而不死循环', () => {
      const circular: any = { a: 1 }
      circular.self = circular
      circular.nested = { parent: circular }

      expect(easyHas(circular, 'a')).toBe(true)
      expect(easyHas(circular, 'self')).toBe(true)
      expect(easyHas(circular, 'self.a')).toBe(true)
      expect(easyHas(circular, 'nested')).toBe(true)
      expect(easyHas(circular, 'nested.parent')).toBe(true)
      expect(easyHas(circular, 'nested.parent.a')).toBe(true)
    })
  })

  describe('性能和边界情况', () => {
    it('应该处理大型对象', () => {
      const largeObj: any = {}

      // 创建一个有1000个属性的对象
      for (let i = 0; i < 1000; i++) {
        largeObj[`prop_${i}`] = {
          id: i,
          data: `value_${i}`,
          nested: {
            level1: {
              level2: `deep_${i}`,
            },
          },
        }
      }

      expect(easyHas(largeObj, 'prop_0')).toBe(true)
      expect(easyHas(largeObj, 'prop_999')).toBe(true)
      expect(easyHas(largeObj, 'prop_1000')).toBe(false)
      expect(easyHas(largeObj, 'prop_500.nested.level1.level2')).toBe(true)
    })

    it('应该处理超长路径', () => {
      const obj = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'deep' } } } } } } } } } }
      expect(easyHas(obj, 'a.b.c.d.e.f.g.h.i.j')).toBe(true)
      expect(easyHas(obj, 'a.b.c.d.e.f.g.h.i.k')).toBe(false)
    })

    it('应该处理数组索引边界', () => {
      const arr = new Array(10000).fill(null).map((_, i) => ({ id: i }))

      expect(easyHas(arr, '0')).toBe(true)
      expect(easyHas(arr, '9999')).toBe(true)
      expect(easyHas(arr, '10000')).toBe(false)
      expect(easyHas(arr, '0.id')).toBe(true)
      expect(easyHas(arr, '9999.id')).toBe(true)
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
      // 即使 getter 抛出错误，属性本身是存在的
      expect(easyHas(objWithErrorGetter, 'errorProp')).toBe(true)
    })

    it('应该处理 Proxy 对象', () => {
      const target = { a: 1, b: 2 }
      const proxy = new Proxy(target, {
        has(target, prop) {
          return prop === 'a' || prop === 'c' // 'c' 实际不存在，但 Proxy 说存在
        },
      })

      expect(easyHas(proxy, 'a')).toBe(true)
      expect(easyHas(proxy, 'b')).toBe(false) // Proxy 拦截了
      expect(easyHas(proxy, 'c')).toBe(true) // Proxy 说存在
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

      // WeakMap 不支持 in 操作符，应该返回 false 或抛出错误
      expect(() => easyHas(weakMap, 'someKey')).not.toThrow()
    })

    it('应该处理 WeakSet', () => {
      const obj1 = {}
      const weakSet = new WeakSet([obj1])

      // WeakSet 不支持 in 操作符，应该返回 false 或抛出错误
      expect(() => easyHas(weakSet, 'someKey')).not.toThrow()
    })
  })
})
