/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach, jest } from '@jest/globals'
import { cleanup } from '@solidjs/testing-library'
import { useForm } from '../src'

// 每个测试后清理
afterEach(cleanup)

describe('useForm 基础功能', () => {
  it('支持 initialValues', () => {
    const form = useForm<{ name: string; age: number }>({
      initialValues: { name: '张三', age: 18 },
    })

    expect(form.getFieldValue('name')).toBe('张三')
    expect(form.getFieldValue('age')).toBe(18)
  })

  it('支持设置和获取字段值', () => {
    const form = useForm<{ name: string }>({
      initialValues: { name: '张三' },
    })

    form.setFieldValue('name', '李四')
    expect(form.getFieldValue('name')).toBe('李四')
  })

  it('支持 setFieldsValue 设置多个字段值', () => {
    const form = useForm<{ name: string; age: number }>({
      initialValues: { name: '张三', age: 18 },
    })

    form.resetValues({ name: '李四', age: 20 })
    expect(form.getFieldValue('name')).toBe('李四')
    expect(form.getFieldValue('age')).toBe(20)
  })

  it('支持 onValuesChange 回调', () => {
    const onValuesChange = jest.fn()
    const form = useForm<{ name: string }>({
      initialValues: { name: '张三' },
      onValuesChange,
    })

    form.setFieldValue('name', '李四')
    expect(onValuesChange).toHaveBeenCalledWith({ name: 'name', value: '李四' }, { name: '李四' })
  })
})
