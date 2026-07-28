/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach } from '@jest/globals'
import { cleanup } from '@solidjs/testing-library'
import { useForm } from '../src'

// 每个测试后清理
afterEach(cleanup)

describe('useForm 字段值操作', () => {
  // 数组字段操作
  it('支持数组字段的增删改', () => {
    const form = useForm<{
      users: { name: string; age: number }[]
      tags: string[]
    }>({
      initialValues: {
        users: [
          { name: '张三', age: 18 },
          { name: '李四', age: 20 },
        ],
        tags: ['前端', '开发'],
      },
    })

    // 获取数组字段
    const users = form.getFieldValue('users') as { name: string; age: number }[]
    expect(users).toHaveLength(2)
    expect(users[0].name).toBe('张三')
    expect(users[1].name).toBe('李四')

    // 直接修改数组元素
    form.setFieldValue('users[0].name', '王五')
    expect(form.getFieldValue('users[0].name')).toBe('王五')

    // 添加数组元素
    const newUsers = [
      ...(form.getFieldValue('users') as { name: string; age: number }[]),
      { name: '赵六', age: 22 },
    ]
    form.setFieldValue('users', newUsers)
    expect(form.getFieldValue('users')).toHaveLength(3)
    expect(form.getFieldValue('users[2].name')).toBe('赵六')

    // 删除数组元素
    form.setFieldValue(
      'users',
      (form.getFieldValue('users') as { name: string; age: number }[]).slice(0, 2),
    )
    expect(form.getFieldValue('users')).toHaveLength(2)

    // 简单数组操作
    form.setFieldValue('tags[1]', '全栈')
    expect(form.getFieldValue('tags[1]')).toBe('全栈')

    // 批量更新数组
    form.resetValues({
      tags: ['React', 'Vue', 'Angular'],
    })
    expect(form.getFieldValue('tags')).toHaveLength(3)
    expect(form.getFieldValue('tags')).toContain('Vue')
  })

  // 获取部分字段
  it('支持获取特定字段值', () => {
    const form = useForm<{
      basic: { username: string; password: string }
      profile: { nickname: string; avatar: string }
      settings: { theme: string; notification: boolean }
    }>({
      initialValues: {
        basic: { username: 'user123', password: '123456' },
        profile: { nickname: '小明', avatar: 'default.png' },
        settings: { theme: 'dark', notification: true },
      },
    })

    // 获取单个字段
    expect(form.getFieldValue('basic.username')).toBe('user123')

    // 获取部分字段（数组方式）
    const values = form.getFieldsValue(['basic.username', 'profile.nickname', 'settings.theme'])
    expect(values).toEqual(['user123', '小明', 'dark'])

    // 获取部分命名空间
    expect(form.getFieldsValue(true)).toEqual({
      basic: { username: 'user123', password: '123456' },
      profile: { nickname: '小明', avatar: 'default.png' },
      settings: { theme: 'dark', notification: true },
    })
  })

  // 表单重置功能
  it('支持表单重置', () => {
    const initialValues = {
      name: '张三',
      age: 25,
      address: '北京市',
    }

    const form = useForm<typeof initialValues>({
      initialValues,
    })

    // 修改表单值
    form.setFieldValue('name', '李四')
    form.setFieldValue('age', 30)
    form.setFieldValue('address', '上海市')

    expect(form.getFieldValue('name')).toBe('李四')

    // 重置表单
    form.resetValues(initialValues)

    // 验证重置结果
    expect(form.getFieldValue('name')).toBe('张三')
    expect(form.getFieldValue('age')).toBe(25)
    expect(form.getFieldValue('address')).toBe('北京市')
  })

  // 特殊值处理
  it('处理特殊值(undefined, null, 空字符串)', () => {
    const form = useForm<{
      field1?: string
      field2: string | null
      field3: string
    }>({
      initialValues: {
        field1: 'value1',
        field2: null,
        field3: '',
      },
    })

    // 检查初始值
    expect(form.getFieldValue('field1')).toBe('value1')
    expect(form.getFieldValue('field2')).toBeNull()
    expect(form.getFieldValue('field3')).toBe('')

    // 设置 undefined
    form.setFieldValue('field1', undefined)
    expect(form.getFieldValue('field1')).toBeUndefined()

    // 设置 null
    form.setFieldValue('field2', 'value2')
    expect(form.getFieldValue('field2')).toBe('value2')
    form.setFieldValue('field2', null)
    expect(form.getFieldValue('field2')).toBeNull()

    // 设置空字符串
    form.setFieldValue('field3', 'value3')
    expect(form.getFieldValue('field3')).toBe('value3')
    form.setFieldValue('field3', '')
    expect(form.getFieldValue('field3')).toBe('')
  })

  // 多层嵌套数组
  it('处理多层嵌套数组', () => {
    const form = useForm<{
      matrix: number[][]
      complex: { items: { subitems: string[] }[] }
    }>({
      initialValues: {
        matrix: [
          [1, 2, 3],
          [4, 5, 6],
        ],
        complex: {
          items: [{ subitems: ['a', 'b'] }, { subitems: ['c', 'd'] }],
        },
      },
    })

    // 获取嵌套值
    expect(form.getFieldValue('matrix[0][1]')).toBe(2)
    expect(form.getFieldValue('complex.items[1].subitems[0]')).toBe('c')

    // 修改嵌套值
    form.setFieldValue('matrix[0][1]', 9)
    form.setFieldValue('complex.items[1].subitems[0]', 'x')

    // 验证修改结果
    expect(form.getFieldValue('matrix[0][1]')).toBe(9)
    expect(form.getFieldValue('complex.items[1].subitems[0]')).toBe('x')

    // 整体修改
    form.setFieldValue('matrix[0]', [7, 8, 9])
    expect(form.getFieldValue('matrix[0]')).toEqual([7, 8, 9])
  })

  // 动态添加字段
  it('支持动态添加字段', () => {
    interface DynamicForm {
      [key: string]: any
      basic: { username: string }
    }

    const form = useForm<DynamicForm>({
      initialValues: {
        basic: { username: 'user123' },
      },
    })

    // 初始表单没有额外字段
    expect(form.getFieldsValue(true)).toEqual({
      basic: { username: 'user123' },
    })

    // 动态添加字段
    form.setFieldValue('extra', { field1: 'value1' })
    expect(form.getFieldValue('extra.field1')).toBe('value1')

    // 再添加一个动态字段
    form.setFieldValue('dynamic.nested.field', 'nestedValue')
    expect(form.getFieldValue('dynamic.nested.field')).toBe('nestedValue')

    // 获取完整表单
    const allValues = form.getFieldsValue(true)
    expect(allValues.basic.username).toBe('user123')
    expect(allValues.extra.field1).toBe('value1')
    expect(allValues.dynamic.nested.field).toBe('nestedValue')
  })
})
