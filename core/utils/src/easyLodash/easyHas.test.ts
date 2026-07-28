import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas', () => {
  describe('基础对象测试', () => {
    const obj = {
      user: {
        profile: {
          name: 'John',
          age: 30,
        },
        settings: {
          theme: 'dark',
        },
      },
      items: [
        { id: 1, name: 'item1' },
        { id: 2, name: 'item2' },
      ],
    }

    it('应该检测到存在的嵌套属性', () => {
      expect(easyHas(obj, 'user.profile.name')).toBe(true)
      expect(easyHas(obj, 'user.profile.age')).toBe(true)
      expect(easyHas(obj, 'user.settings.theme')).toBe(true)
    })

    it('应该检测到不存在的属性', () => {
      expect(easyHas(obj, 'user.profile.email')).toBe(false)
      expect(easyHas(obj, 'user.nonexistent')).toBe(false)
      expect(easyHas(obj, 'nonexistent.prop')).toBe(false)
    })

    it('应该支持数组路径语法', () => {
      expect(easyHas(obj, ['user', 'profile', 'name'])).toBe(true)
      expect(easyHas(obj, ['user', 'profile', 'email'])).toBe(false)
    })

    it('应该支持数组索引访问', () => {
      expect(easyHas(obj, 'items.0.id')).toBe(true)
      expect(easyHas(obj, 'items.1.name')).toBe(true)
      expect(easyHas(obj, 'items.2.id')).toBe(false) // 索引越界
    })

    it('应该支持方括号语法', () => {
      expect(easyHas(obj, 'items[0].id')).toBe(true)
      expect(easyHas(obj, 'items[1].name')).toBe(true)
      expect(easyHas(obj, 'items[2].id')).toBe(false) // 索引越界
    })
  })

  describe('特殊情况测试', () => {
    it('应该处理空对象', () => {
      expect(easyHas({}, 'prop')).toBe(false)
    })

    it('应该处理 null 和 undefined', () => {
      expect(easyHas(null, 'prop')).toBe(false)
      expect(easyHas(undefined, 'prop')).toBe(false)
    })

    it('应该处理原始类型', () => {
      expect(easyHas('string', 'length')).toBe(true) // 字符串有 length 属性
      expect(easyHas(123, 'toString')).toBe(true) // 数字有 toString 方法
      expect(easyHas(123, 'nonexistent')).toBe(false)
    })

    it('应该处理数组', () => {
      const arr = ['a', 'b', 'c']
      expect(easyHas(arr, '0')).toBe(true)
      expect(easyHas(arr, '2')).toBe(true)
      expect(easyHas(arr, '3')).toBe(false)
      expect(easyHas(arr, 'length')).toBe(true)
    })
  })

  describe('Map 和 Set 测试', () => {
    it('应该支持 Map', () => {
      const map = new Map<string, any>([
        ['key1', 'value1'],
        ['key2', { nested: 'value' }],
      ])

      expect(easyHas(map, 'key1')).toBe(true)
      expect(easyHas(map, 'key2')).toBe(true)
      expect(easyHas(map, 'key3')).toBe(false)
    })

    it('应该支持 Set', () => {
      const set = new Set(['item1', 'item2', 'item3'])

      expect(easyHas(set, '0')).toBe(true) // 第一个元素
      expect(easyHas(set, '2')).toBe(true) // 第三个元素
      expect(easyHas(set, '3')).toBe(false) // 超出范围
    })
  })

  describe('边界情况', () => {
    it('应该处理包含 undefined 值的属性', () => {
      const obj = { prop: undefined }
      expect(easyHas(obj, 'prop')).toBe(true) // 属性存在，即使值是 undefined
    })

    it('应该处理数字路径', () => {
      const arr = ['a', 'b', 'c']
      expect(easyHas(arr, 0)).toBe(true)
      expect(easyHas(arr, 3)).toBe(false)
    })

    it('应该处理空路径数组', () => {
      const obj = { prop: 'value' }
      expect(easyHas(obj, [])).toBe(true) // 空路径应该返回 true（根对象存在）
    })
  })
})
