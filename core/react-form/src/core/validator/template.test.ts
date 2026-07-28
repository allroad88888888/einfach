import { describe, expect, it } from '@jest/globals'
import { templateConvert } from './item'

describe('模板字符串转换', () => {
  it('demo', () => {
    const template = '请输入${label}'
    const fnStr = `return (\`${template}\`)`
    const fn = new Function('label', fnStr)
    const str = fn('字段1')
    expect(str).toBe('请输入字段1')
  })

  it('convert', () => {
    const template = '请输入${label}'
    const str = templateConvert(template, { label: '字段1' })
    expect(str).toBe('请输入字段1')
  })
})
