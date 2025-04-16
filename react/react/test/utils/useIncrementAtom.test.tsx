import { describe, test, expect } from '@jest/globals'
import { useAtomValue } from '../../src'
import { queryByTestId, render, screen } from '@testing-library/react'
import type { CSSProperties } from 'react'
import { incrementAtom } from '@einfach/core'
import userEvent from '@testing-library/user-event'
import { useIncrementAtom } from '../../src/utils/useIncrementAtom'

describe('incrementAtom', () => {
  test('useIncrementAtom', async () => {
    const styleIncrementAtom = incrementAtom<CSSProperties>({ color: 'gray' })

    function A() {
      const [incrementStateFn, cleanStateFn] = useIncrementAtom(styleIncrementAtom)

      return (
        <div>
          <button
            data-testid="btn-red"
            onClick={() => {
              incrementStateFn((_getter, prevReturn) => {
                return {
                  ...prevReturn,
                  color: 'red',
                }
              })
            }}
          >
            color red
          </button>
          <button
            data-testid="btn-cancel-red"
            onClick={() => {
              cleanStateFn()
            }}
          >
            cancel color red
          </button>
        </div>
      )
    }

    function B() {
      const [incrementStateFn, cleanStateFn] = useIncrementAtom(styleIncrementAtom)

      const { color } = useAtomValue(styleIncrementAtom)

      return (
        <div>
          <button
            data-testid="btn-blue"
            onClick={() => {
              incrementStateFn((_getter, prevReturn) => {
                return {
                  ...prevReturn,
                  color: 'blue',
                }
              })
            }}
          >
            color red
          </button>
          <button
            data-testid="btn-cancel-blue"
            onClick={() => {
              cleanStateFn()
            }}
          >
            cancel color red
          </button>
          <div data-testid="result">{color}</div>
        </div>
      )
    }

    function App() {
      return (
        <div data-testid="app">
          <A />
          <B />
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    expect(queryByTestId(baseElement, 'result')).toBeInTheDocument()
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('gray')

    await userEvent.click(screen.getByTestId('btn-red'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('red')
    await userEvent.click(screen.getByTestId('btn-blue'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('blue')

    await userEvent.click(screen.getByTestId('btn-cancel-blue'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('red')
    await userEvent.click(screen.getByTestId('btn-cancel-red'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('gray')

    await userEvent.click(screen.getByTestId('btn-blue'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('blue')
  })
})
