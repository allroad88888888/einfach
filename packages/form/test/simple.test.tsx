import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Form, useField, useFieldValue, useForm } from '../src'

export function ItemSwitch() {
  const { value = false, onChange } = useField<boolean>('switch')
  return (
    <input
      role="checkbox"
      type="checkbox"
      checked={value}
      onChange={(e) => {
        onChange(e.target.checked)
      }}
    />
  )
}
export function ItemInput() {
  const { value = '', onChange } = useField<string>('input')
  const switchValue = useFieldValue('switch')
  if (!switchValue) {
    return null
  }
  return (
    <input
      data-testid="input"
      type="text"
      value={value}
      onChange={(e) => {
        onChange(e.target.value)
      }}
    />
  )
}

describe('测试整个表单', () => {
  it('', async () => {
    const SimpleFrom = () => {
      const from = useForm({})
      return (
        <Form formInstance={from}>
          <ItemSwitch />
          <ItemInput />
        </Form>
      )
    }
    render(<SimpleFrom />)

    await userEvent.click(screen.getByRole('checkbox'))
    await screen.findAllByTestId('input')

    expect(screen.getByTestId('input')).toBeVisible()
  })
})
