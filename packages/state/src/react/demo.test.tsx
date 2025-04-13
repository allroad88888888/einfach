import { describe, it, expect } from '@jest/globals'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { useCallback } from 'react'
import { atom, createStore } from '../core'
import { useAtomValue } from './useAtomValue'
import { useSetAtom } from './useSetAtom'

describe('useAtomValue', () => {
  it('base', async () => {
    const atom1 = atom('atom1')
    const atom2 = atom('atom2')
    const store = createStore()

    const atom3 = atom(0, (getter, setter) => {
      setter(atom1, 'atom11')
      setter(atom2, 'atom22')
    })

    let x = 0

    function DemoAtomVAlue() {
      const val = useAtomValue(atom1, { store })
      const val2 = useAtomValue(atom2, { store })
      const setInfo = useSetAtom(atom3, { store })

      const onClick = useCallback(() => {
        setTimeout(() => {
          setInfo()
        })
      }, [])
      x += 1
      return (
        <div>
          <button data-testid="setAtom1" onClick={onClick}>
            set atom1
          </button>
          {val2 === 'atom22' && (
            <span data-testid="val">
              {val} {val2}
            </span>
          )}
        </div>
      )
    }

    render(<DemoAtomVAlue />)
    await screen.findByTestId('setAtom1')
    expect(x).toBe(1)

    await userEvent.click(screen.getByTestId('setAtom1'))

    // await screen.findByTestId('val')
    expect(x).toBe(2)
  })
  it('跨一个atom 获取最新状态', () => {
    const atomA = atom(1)
    const atomB = atom((getter) => {
      const B = getter(atomA) + 100

      return B
    })

    const atomC = atom((getter) => {
      const B = getter(atomB)
      const C = B + 200

      return C
    })
    const store = createStore()

    store.sub(atomC, () => {})

    store.getter(atomC)

    store.setter(atomA, 200)

    expect(store.getter(atomC)).toBe(500)
  })
})
