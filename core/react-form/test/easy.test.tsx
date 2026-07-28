import { describe, expect, it } from '@jest/globals'
import { queryByTestId, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Form, FormItem, useFieldValue, useForm } from '../src'
import { Input } from './components/Input'
import { Switch } from './components/Switch'

describe('form-easy', () => {
  it('initValuesAndUseFieldValue', async () => {
    const SimpleFrom = () => {
      const form = useForm({
        initialValues: {
          inputText: 'demo1',
          switchDemo1: false,
        },
      })

      const switchValue = useFieldValue('switchDemo1', { formInstance: form })

      return (
        <Form formInstance={form}>
          <FormItem name="switchDemo1">
            <Switch dataTestid="switchDemo1" />
          </FormItem>
          {switchValue === true ? (
            <FormItem name="inputText">
              <Input dataTestid="inputText" />
            </FormItem>
          ) : null}
        </Form>
      )
    }
    const { baseElement } = render(<SimpleFrom />)
    await screen.findByTestId('switchDemo1')
    expect(queryByTestId(baseElement, 'inputText')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('switchDemo1'))
    expect(screen.getByTestId('inputText')).toBeVisible()
    // expect(screen.getByTestId('inputText')).toHaveValue('demo1')
  }, 9000000)
})
