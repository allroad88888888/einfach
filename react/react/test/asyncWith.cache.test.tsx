import { describe, test, expect } from '@jest/globals'
import { atom } from '@einfach/core'
import { act, render, renderHook, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { useAtom } from '../src'

describe('async - 缓存与更新场景', () => {
  test('异步 atom 缓存与手动更新', async () => {
    const empty = Symbol('empty')

    const state = {
      id: 1,
    }

    const middleInfoAtom = atom(async () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(state)
        }, 1000)
      })
    })

    const staticAtom = atom<any>(empty)
    const serverInfoAtom = atom(
      async function (getter) {
        const middle = getter(staticAtom)
        if (middle !== empty) {
          return middle
        }
        return getter(middleInfoAtom)
      },
      (getter, setter, valNew: any) => {
        setter(staticAtom, valNew)
      },
    )

    const xx = renderHook(() => {
      const [state, setState] = useAtom(serverInfoAtom)
      return [state, setState]
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    })

    expect(xx.result.current[0]).toBe(state)

    await act(async () => {
      xx.result.current[1]({
        id: 2,
      })
    })

    expect(xx.result.current[0]).toStrictEqual({
      id: 2,
    })
  })

  test('异步 atom 组件初始加载与按钮更新', async () => {
    const empty = Symbol('empty')

    const state = {
      id: 1,
    }

    const staticAtom = atom<any>(empty)
    const serverInfoAtom = atom(
      async function (getter) {
        const middle = getter(staticAtom)
        if (middle !== empty) {
          return middle
        }

        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(state)
          }, 1000)
        })
      },
      (getter, setter, valNew: any) => {
        setter(staticAtom, valNew)
      },
    )

    function TestComponent() {
      const [serverInfo, setServerInfo] = useAtom(serverInfoAtom)

      return (
        <div>
          <div data-testid="server-info">
            {serverInfo === empty ? 'loading' : `ID: ${serverInfo.id}`}
          </div>
          <button data-testid="update-button" onClick={() => setServerInfo({ id: 2 })}>
            Update to ID 2
          </button>
        </div>
      )
    }

    function App() {
      return (
        <Suspense fallback={<div data-testid="loading">Loading...</div>}>
          <TestComponent />
        </Suspense>
      )
    }

    render(<App />)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    })

    expect(screen.getByTestId('server-info')).toHaveTextContent('ID: 1')

    await act(async () => {
      screen.getByTestId('update-button').click()
    })

    expect(screen.getByTestId('server-info')).toHaveTextContent('ID: 2')
  })
})
