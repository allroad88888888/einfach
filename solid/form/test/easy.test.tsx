/** @jsxImportSource solid-js */

import { describe, expect, it, afterEach } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { Form, FormItem, useFieldValue, useForm } from '../src'
import { Input } from './components/Input'
import { Switch } from './components/Switch'
import { Show } from 'solid-js'

// 在每个测试后清理
afterEach(cleanup)

describe('form-easy', () => {
  it('初始值和字段值获取', async () => {
    // 创建一个简单的表单组件
    function SimpleForm() {
      const form = useForm({
        initialValues: {
          inputText: 'demo1',
          switchDemo1: false,
        },
      })

      const switchValue = useFieldValue('switchDemo1', { formInstance: form })

      return (
        <Form formInstance={form}>
          <FormItem<boolean> name="switchDemo1" class="switchDemo1">
            {({ value, onChange }) => {
              return <Switch dataTestid="switchDemo1" value={value} onChange={onChange} />
            }}
          </FormItem>
          <Show when={switchValue()}>
            <FormItem<string> name="inputText">
              {({ value, onChange }) => {
                return <Input dataTestid="inputText" value={value} onChange={onChange} />
              }}
            </FormItem>
          </Show>
        </Form>
      )
    }

    // 渲染组件
    const { getByTestId, queryByTestId, findByTestId } = render(() => <SimpleForm />)

    // 检查初始状态
    expect(getByTestId('switchDemo1')).toBeInTheDocument()
    expect(queryByTestId('inputText')).not.toBeInTheDocument()

    // 点击开关
    fireEvent.click(getByTestId('switchDemo1'))
    await findByTestId('inputText')
    // 检查点击后的状态
    expect(queryByTestId('inputText')).toBeInTheDocument()

    // 检查输入框的值
    const inputElement = queryByTestId('inputText') as HTMLInputElement
    expect(inputElement.value).toBe('demo1')
  })
})
