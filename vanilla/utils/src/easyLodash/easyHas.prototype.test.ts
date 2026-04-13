import { describe, expect, it } from '@jest/globals'
import { easyHas } from './easyHas'

describe('easyHas - 原型链场景', () => {
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
      expect(easyHas(instance, 'toString')).toBe(true)
    })
  })
})
