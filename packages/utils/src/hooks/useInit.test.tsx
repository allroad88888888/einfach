import { describe, expect, it } from '@jest/globals'
import { queryByTestId, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useInit } from './useInit'
import { atom } from '@einfach/core'
import { useAtom } from '@einfach/react'

describe('useInit', () => {
  it('init', async () => {
    function A({ num }: { num: number }) {
      const x = useInit(() => {
        return num
      }, [num])

      return <div data-testid="result">{x}</div>
    }

    const numAtom = atom(100)
    function App() {
      const [num, setNum] = useAtom(numAtom)
      return (
        <div data-testid="app">
          <A num={num} />
          <button
            onClick={() => {
              setNum(10000)
            }}
            data-testid="btn"
          >
            change num
          </button>
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    expect(queryByTestId(baseElement, 'result')).toHaveTextContent('100')
    await userEvent.click(screen.getByTestId('btn'))
    expect(queryByTestId(baseElement, 'result')).toHaveTextContent('10000')
  })
})
