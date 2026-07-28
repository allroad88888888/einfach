/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach, jest } from '@jest/globals'
import { render, cleanup } from '@solidjs/testing-library'
import { useForm, Form, FormItem } from '../src'
import { Input } from './components/Input'

// 每个测试后清理
afterEach(cleanup)

describe('useForm 高级功能', () => {
  // 嵌套字段
  it('支持嵌套字段的设置和获取', () => {
    const form = useForm<{
      user: {
        name: string
        profile: {
          age: number
          address: string
        }
      }
    }>({
      initialValues: {
        user: {
          name: '张三',
          profile: {
            age: 25,
            address: '北京市',
          },
        },
      },
    })

    // 获取嵌套字段值
    expect(form.getFieldValue('user.name')).toBe('张三')
    expect(form.getFieldValue('user.profile.age')).toBe(25)
    expect(form.getFieldValue('user.profile.address')).toBe('北京市')

    // 设置嵌套字段值
    form.setFieldValue('user.name', '李四')
    form.setFieldValue('user.profile.age', 30)
    form.setFieldValue('user.profile.address', '上海市')

    // 验证嵌套字段变更
    expect(form.getFieldValue('user.name')).toBe('李四')
    expect(form.getFieldValue('user.profile.age')).toBe(30)
    expect(form.getFieldValue('user.profile.address')).toBe('上海市')

    // 批量设置嵌套字段
    form.resetValues({
      user: {
        name: '王五',
        profile: {
          age: 35,
          address: '广州市',
        },
      },
    })

    // 验证批量设置
    expect(form.getFieldValue('user.name')).toBe('王五')
    expect(form.getFieldValue('user.profile.age')).toBe(35)
    expect(form.getFieldValue('user.profile.address')).toBe('广州市')
  })

  // 表单校验
  it('支持同步校验规则', async () => {
    interface FormValues {
      username: string
      password: string
      [key: string]: any
    }

    // 创建表单实例
    const form = useForm<FormValues>({
      initialValues: {
        username: '',
        password: '',
      },
    })

    // 创建一个组件来注册表单校验规则
    function TestForm() {
      return (
        <Form formInstance={form}>
          <FormItem<string>
            name="username"
            rules={[
              { required: true, message: '用户名不能为空' },
              { min: 3, message: '用户名至少3个字符' },
            ]}
          >
            {({ value, onChange }) => (
              <Input dataTestid="username" value={value} onChange={onChange} />
            )}
          </FormItem>
          <FormItem<string>
            name="password"
            rules={[
              { required: true, message: '密码不能为空' },
              { min: 6, message: '密码至少6个字符' },
            ]}
          >
            {({ value, onChange }) => (
              <Input dataTestid="password" value={value} onChange={onChange} />
            )}
          </FormItem>
        </Form>
      )
    }

    // 渲染表单组件
    render(() => <TestForm />)

    // 1. 验证空值校验
    let isValid = await form.validateField('username')
    expect(isValid).toBe(false)
    expect(form.getFieldMessage('username')?.error?.[0]).toBe('用户名不能为空')

    // 2. 设置值但不满足长度要求
    form.setFieldValue('username', 'ab')
    isValid = await form.validateField('username')
    expect(isValid).toBe(false)
    expect(form.getFieldMessage('username')?.error?.[0]).toBe('用户名至少3个字符')

    // 3. 设置有效值，校验通过
    form.setFieldValue('username', 'admin')
    isValid = await form.validateField('username')
    expect(isValid).toBe(true)
    expect(form.getFieldMessage('username')?.error).toBeUndefined()

    // 4. 验证整个表单，应该失败因为密码为空
    isValid = await form.validateFields()
    expect(isValid).toBe(false)
    expect(form.getFieldMessage('password')?.error?.[0]).toBe('密码不能为空')

    // 5. 设置所有字段有效值后再验证整个表单
    form.resetValues({
      username: 'admin',
      password: 'password123',
    })
    isValid = await form.validateFields()
    expect(isValid).toBe(true)
  })

  // 异步校验
  it('支持异步校验规则', async () => {
    // 模拟异步校验 - 检查用户名是否被占用
    const checkUsernameExists = jest.fn().mockImplementation(async (value: any) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(value === 'admin')
        }, 100)
      })
    })

    const form = useForm<{ username: string }>({
      initialValues: { username: '' },
    })

    // 创建一个组件来注册表单校验规则
    function TestForm() {
      return (
        <Form formInstance={form}>
          <FormItem<string>
            name="username"
            rules={[
              { required: true, message: '用户名不能为空' },
              {
                validator: async (rule, value) => {
                  if (!value || value.length < 3) {
                    return Promise.reject('用户名至少3个字符')
                  }
                  const exists = await checkUsernameExists(value)
                  if (exists) {
                    return Promise.reject('用户名已被占用')
                  }
                  return Promise.resolve()
                },
              },
            ]}
          >
            {({ value, onChange }) => (
              <Input dataTestid="username" value={value} onChange={onChange} />
            )}
          </FormItem>
        </Form>
      )
    }

    // 渲染表单组件
    render(() => <TestForm />)

    // 1. 测试异步校验 - 用户名已被占用
    form.setFieldValue('username', 'admin')
    let isValid = await form.validateField('username')
    expect(isValid).toBe(false)
    expect(form.getFieldMessage('username')?.error?.[0]).toBe('用户名已被占用')
    expect(checkUsernameExists).toHaveBeenCalledWith('admin')

    // 2. 测试异步校验 - 用户名可用
    form.setFieldValue('username', 'newuser')
    isValid = await form.validateField('username')
    expect(isValid).toBe(true)
    expect(form.getFieldMessage('username')?.error).toBeUndefined()
    expect(checkUsernameExists).toHaveBeenCalledWith('newuser')
  })

  // 警告vs错误校验
  it('支持警告级别校验', async () => {
    const form = useForm<{ password: string }>({
      initialValues: { password: '' },
    })

    // 创建一个组件来注册表单校验规则
    function TestForm() {
      return (
        <Form formInstance={form}>
          <FormItem<string>
            name="password"
            rules={[
              { required: true, message: '密码不能为空' },
              { min: 6, message: '密码至少6个字符' },
              {
                pattern: /[A-Z]/,
                message: '建议包含大写字母',
                warningOnly: true,
              },
            ]}
          >
            {({ value, onChange }) => (
              <Input dataTestid="password" value={value} onChange={onChange} />
            )}
          </FormItem>
        </Form>
      )
    }

    // 渲染表单组件
    render(() => <TestForm />)

    // 1. 设置有效但没有大写字母的密码，应该有警告但校验通过
    form.setFieldValue('password', 'password123')
    const isValid = await form.validateField('password')
    expect(isValid).toBe(true) // 警告不会导致校验失败
    expect(form.getFieldMessage('password')?.warn?.[0]).toBe('建议包含大写字母')
    expect(form.getFieldMessage('password')?.error).toBeUndefined()

    // 2. 设置包含大写字母的密码，警告消失
    form.setFieldValue('password', 'Password123')
    await form.validateField('password')
    expect(form.getFieldMessage('password')?.warn).toBeUndefined()
  })
})
