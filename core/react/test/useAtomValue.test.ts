import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom, getDefaultStore } from '@einfach/core'
import { useAtom } from '../src/useAtom'
import { useAtomValue } from '../src/useAtomValue'
import { useSetAtom } from '../src/useSetAtom'
import { useCallback } from 'react'

describe('useAtomValue', () => {
  it('easy', async () => {
    const baseAtom = atom(0)

    const infoAtom = atom<{ a?: string }>({})

    const bigInfoAtom = atom((getter) => {
      return getter(baseAtom) + 10
    })

    let renderANum = 0
    const { result } = renderHook(() => {
      const [, setInfo] = useAtom(infoAtom)

      useAtomValue(bigInfoAtom)

      renderANum += 1

      const setBaseAtom = useSetAtom(baseAtom)
      return useCallback(() => {
        const store = getDefaultStore()
        store.setter(baseAtom, 12)
        store.setter(infoAtom, { a: 'ee' })
        setBaseAtom(12)
        setInfo({
          a: 'ds123f',
        })
      }, [])
    })

    act(() => {
      result.current()
    })

    expect(renderANum).toBe(2)
  })
})
