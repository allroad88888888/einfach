import { describe, test, expect } from '@jest/globals'
import { useAtomValue, useSetAtom, useStore } from '../react'
import { queryByTestId, render, screen } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { incrementAtom } from './incrementAtom'
import { atom } from '../core'
import userEvent from '@testing-library/user-event'

describe('incrementAtom', () => {
  test('serverInfo', async () => {
    const countIncrementAtom = incrementAtom<{
      count: number
    }>({ count: 1 })

    const aCountAtom = atom(0)
    function A() {
      const { setter } = useStore()
      const setACount = useSetAtom(aCountAtom)

      const [cancel] = useState(() => {
        return setter(countIncrementAtom, (_getter, prevReturn) => {
          const aCount = _getter(aCountAtom)
          return {
            ...prevReturn,
            count: prevReturn.count + aCount,
          }
        })
      })

      return (
        <div>
          <button
            data-testid="btn-a-add"
            onClick={() => {
              setACount((prevACount) => {
                return prevACount + 1
              })
            }}
          >
            + 1
          </button>
          <button data-testid="btn-a-cancel" onClick={cancel}>
            cancel A count
          </button>
        </div>
      )
    }

    function B() {
      const { setter } = useStore()

      useLayoutEffect(() => {
        return setter(countIncrementAtom, (_getter, prevReturn) => {
          return {
            count: prevReturn.count + 99,
          }
        })
      }, [])

      const { count } = useAtomValue(countIncrementAtom)

      return <div data-testid="result">{count}</div>
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
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('100')

    await userEvent.click(screen.getByTestId('btn-a-add'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('101')
    await userEvent.click(screen.getByTestId('btn-a-add'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('102')
    await userEvent.click(screen.getByTestId('btn-a-cancel'))
    expect(queryByTestId(baseElement, 'result')?.textContent).toBe('100')
  })
})
