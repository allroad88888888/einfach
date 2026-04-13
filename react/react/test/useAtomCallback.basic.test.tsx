import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom } from '@einfach/core'
import { useAtomCallback } from '../src/useAtomCallback'
import { useAtomValue } from '../src/useAtomValue'

describe('useAtomCallback - 基础场景', () => {
  it('基本功能测试', async () => {
    const countAtom = atom(0)

    const { result } = renderHook(() => {
      const callback = useAtomCallback((get, set, increment: number) => {
        const current = get(countAtom)
        set(countAtom, current + increment)
        return current + increment
      }, [])

      const count = useAtomValue(countAtom)
      return { callback, count }
    })

    expect(result.current.count).toBe(0)

    act(() => {
      const newValue = result.current.callback(5)
      expect(newValue).toBe(5)
    })

    expect(result.current.count).toBe(5)
  })
})
