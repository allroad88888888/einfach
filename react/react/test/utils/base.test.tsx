import { describe, expect, it } from '@jest/globals'
import { queryByTestId, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { atom } from '@einfach/core'
import { useAtom, useAtomValue } from '../../src'
import { memo } from 'react'

describe('useAtomValue', () => {
  it('base', async () => {
    const atom1 = atom(1)
    const atom2 = atom((getter) => {
      return getter(atom1) + 1
    })
    const atom3 = atom((getter) => {
      return getter(atom2) + 1
    })
    let renderNum = 0
    const ItemThree = memo(() => {
      renderNum += 1
      const val = useAtomValue(atom3)
      return <div data-testid="itemThree">{val}</div>
    })

    function DemoAtomVAlue() {
      const [val, setAtom1] = useAtom(atom1)
      return (
        <div>
          <button
            data-testid="setAtom1"
            onClick={() => {
              setAtom1(2)
            }}
          >
            set atom1
          </button>
          <span>{val}</span>
          {val === 1 ? <ItemThree /> : null}
        </div>
      )
    }

    const { baseElement } = render(<DemoAtomVAlue />)
    await screen.findByTestId('itemThree')
    expect(queryByTestId(baseElement, 'itemThree')).toBeInTheDocument()
    expect(renderNum).toBe(1)
    await userEvent.click(screen.getByTestId('setAtom1'))
    expect(queryByTestId(baseElement, 'itemThree')).not.toBeInTheDocument()
    expect(renderNum).toBe(1)
  })
})
