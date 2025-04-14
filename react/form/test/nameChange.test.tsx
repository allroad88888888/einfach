import { describe, expect, it } from '@jest/globals'
import { queryByTestId, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Form, FormItem, useForm } from '../src'
import { Input } from './components/Input'
import { useState } from 'react'

describe('form-name-change', () => {
  it('name-change', async () => {
    const SimpleFrom = () => {
      const form = useForm({
        initialValues: {
          inputText: 'text1',
          inputText2: 'text2',
        },
      })

      const [name, setName] = useState('inputText')

      return (
        <Form formInstance={form}>
          <button
            onClick={() => {
              setName('inputText2')
            }}
            data-testid="check"
          >
            check
          </button>
          <FormItem name={name}>
            <Input dataTestid="input" />
          </FormItem>
        </Form>
      )
    }
    const { baseElement } = render(<SimpleFrom />)
    await screen.findByTestId('input')
    expect(queryByTestId(baseElement, 'input')).toHaveValue('text1')
    await userEvent.click(screen.getByTestId('check'))

    expect(queryByTestId(baseElement, 'input')).toHaveValue('text2')
  })
})
