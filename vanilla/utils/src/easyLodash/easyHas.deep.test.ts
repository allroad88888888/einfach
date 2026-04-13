import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas - 深度与边界场景', () => {
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
})
