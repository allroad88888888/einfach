/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { Form, FormItem, useForm } from '../src'
import { Input } from './components/Input'
import { Switch } from './components/Switch'

// 每个测试后清理
afterEach(cleanup)

describe('FormItem', () => {
  it('渲染 label、dataTestid、无样式模式', () => {
    const form = useForm({ initialValues: { foo: 'bar', sw: false } })
    const { getByTestId, queryByText } = render(() => (
      <Form formInstance={form}>
        <FormItem<string> name="foo" label="标签" dataTestid="foo-item">
          {({ value, onChange }) => (
            <Input dataTestid="foo-input" value={value} onChange={onChange} />
          )}
        </FormItem>
        <FormItem<boolean> name="sw" noStyle>
          {({ value, onChange }) => (
            <Switch dataTestid="sw-input" value={value} onChange={onChange} />
          )}
        </FormItem>
      </Form>
    ))
    expect(getByTestId('foo-item')).toBeInTheDocument()
    expect(queryByText('标签')).toBeInTheDocument()
    expect(getByTestId('foo-input')).toBeInTheDocument()
    expect(getByTestId('sw-input')).toBeInTheDocument()
  })

  it('支持受控输入和 onChange', async () => {
    const form = useForm({ initialValues: { foo: 'bar' } })
    const { getByTestId } = render(() => (
      <Form formInstance={form}>
        <FormItem<string> name="foo">
          {({ value, onChange }) => (
            <Input dataTestid="foo-input" value={value} onChange={onChange} />
          )}
        </FormItem>
      </Form>
    ))
    const input = getByTestId('foo-input') as HTMLInputElement
    expect(input.value as string).toBe('bar')
    fireEvent.input(input, { target: { value: 'baz' as string } })
    expect(input.value as string).toBe('baz')
    // 检查 form 实例同步
    expect(form.getFieldValue('foo')).toBe('baz')
  })

  it('支持校验规则，展示错误和警告', async () => {
    const form = useForm({ initialValues: { foo: '' } })
    const rules = [
      { required: true, message: '必填项' },
      { min: 3, message: '最少3个字', warningOnly: true },
    ]
    const { getByTestId, queryByTestId, findByTestId } = render(() => (
      <Form formInstance={form}>
        <FormItem<string> name="foo" rules={rules} dataTestid="foo-item">
          {({ value, onChange }) => (
            <Input dataTestid="foo-input" value={value} onChange={onChange} />
          )}
        </FormItem>
      </Form>
    ))
    // 触发校验
    fireEvent.input(getByTestId('foo-input'), { target: { value: '' as string } })

    await findByTestId('foo-item-error')
    // 必填错误
    expect(getByTestId('foo-item-error')).toHaveTextContent('必填项')
    // 输入2个字，触发警告
    fireEvent.input(getByTestId('foo-input'), { target: { value: 'ab' as string } })
    await findByTestId('foo-item-warn')
    expect(getByTestId('foo-item-warn')).toHaveTextContent('最少3个字')
    // 输入3个字，警告消失
    fireEvent.input(getByTestId('foo-input'), { target: { value: 'abc' as string } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(queryByTestId('foo-item-warn')).toBeNull()
  })

  it('支持嵌套 FormItem', () => {
    const form = useForm({ initialValues: { foo: 'bar', bar: 'baz' } })
    const { getByTestId } = render(() => (
      <Form formInstance={form}>
        <FormItem<string> name="foo" dataTestid="foo-item">
          {({ value, onChange }) => (
            <div>
              <Input dataTestid="foo-input" value={value} onChange={onChange} />
              <FormItem<string> name="bar" dataTestid="bar-item">
                {({ value, onChange }) => (
                  <Input dataTestid="bar-input" value={value} onChange={onChange} />
                )}
              </FormItem>
            </div>
          )}
        </FormItem>
      </Form>
    ))
    expect(getByTestId('foo-input')).toBeInTheDocument()
    expect(getByTestId('bar-input')).toBeInTheDocument()
  })
})
