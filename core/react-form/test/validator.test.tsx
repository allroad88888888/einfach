import { describe, expect, it } from '@jest/globals'
import { queryByTestId, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Form, FormItem, useForm } from '../src'
import { Input } from './components/Input'

describe('form-validator', () => {
  it('validator', async () => {
    const ValidatorFrom = () => {
      const form = useForm({
        initialValues: {
          inputText: 'demo',
          inputDate: new Date('2024-05-28 00:00:00'),
          inputDateMin: new Date('2022-05-28 00:00:00'),
          inputCustom: '12312A',
        },
      })

      return (
        <Form formInstance={form}>
          <FormItem name="inputText" rules={[{ len: 8 }]} dataTestid="inputTextLabel">
            <Input type="text" dataTestid="inputText" />
          </FormItem>
          <FormItem name="inputNumber">
            <Input type="number" dataTestid="inputNumber" />
          </FormItem>
          <FormItem
            name="inputDate"
            dataTestid="inputDateLabel"
            rules={[
              {
                max: 1716777643914,
                transform(value: Date) {
                  return value.getTime()
                },
              },
            ]}
          >
            <Input type="date" dataTestid="inputDate" />
          </FormItem>
          <FormItem
            name="inputDateMin"
            dataTestid="inputDateMinLabel"
            rules={[
              {
                min: 1716777643914,
                transform(value: Date) {
                  return value.getTime()
                },
              },
            ]}
          >
            <Input type="date" dataTestid="inputDateMin" />
          </FormItem>
          <FormItem
            name="inputRequire"
            dataTestid="inputRequireLabel"
            rules={[
              {
                required: true,
                pattern: /[a-z]*/,
              },
            ]}
          >
            <Input type="time" dataTestid="inputRequire" />
          </FormItem>

          <FormItem
            name="inputExpr"
            dataTestid="inputExprLabel"
            label="正则"
            rules={[
              {
                pattern: /[a-z]*/,
                message: '字段${label}不匹配正则${pattern}',
              },
            ]}
          >
            <Input type="time" dataTestid="inputExpr" />
          </FormItem>
          <FormItem
            name="inputCustom"
            dataTestid="inputCustomLabel"
            rules={[
              {
                validator: (rule, val) => {
                  if (val === '12312A') {
                    return Promise.reject('错误')
                  }
                  return Promise.reject('异常')
                },
              },
            ]}
          >
            <Input type="time" dataTestid="inputCustom" />
          </FormItem>

          <button onClick={form.validateFields} data-testid="submit">
            submit
          </button>
        </Form>
      )
    }
    const { baseElement } = render(<ValidatorFrom />)
    await screen.findByTestId('inputText')
    await userEvent.type(screen.getByTestId('inputText'), '123')
    expect(screen.getByTestId('inputTextLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputTextLabel-error')).toHaveTextContent('须为8个字符')
    expect(queryByTestId(baseElement, 'inputDateLabel-error')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('submit'))
    await screen.findByTestId('inputDateLabel-error')
    // 校验大于
    expect(screen.getByTestId('inputDateLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputDateLabel-error')).toHaveTextContent('大于1716777643914')
    // 校验小于
    expect(screen.getByTestId('inputDateMinLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputDateMinLabel-error')).toHaveTextContent('小于1716777643914')
    // 必填
    expect(screen.getByTestId('inputRequireLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputRequireLabel-error')).toHaveTextContent('请输入')
    // expr
    expect(screen.getByTestId('inputExprLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputExprLabel-error')).toHaveTextContent(
      '字段正则不匹配正则/[a-z]*/',
    )
    // custom
    expect(screen.getByTestId('inputCustomLabel-error')).toBeVisible()
    expect(screen.getByTestId('inputCustomLabel-error')).toHaveTextContent('错误')
  }, 300000)
})
