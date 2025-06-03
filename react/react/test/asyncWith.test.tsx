import { describe, test, expect } from '@jest/globals'
import { atom } from '@einfach/core'
import { act, queryByTestId, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { useAtom, useAtomValue } from '../src'

describe('async', () => {
  test('serverInfo', async () => {
    const serverInfoAtom = atom(function () {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ id: 1 }, { id: 2 }])
        }, 1000)
      }) as Promise<{ id: number }[]>
    })

    function ServerInfoComponent() {
      const serverInfo = useAtomValue(serverInfoAtom)

      return <div data-testid="serverInfo">{serverInfo[0].id}</div>
    }
    function App() {
      return (
        <div data-testid="app">
          <Suspense fallback={<div data-testid="loading">loading</div>}>
            <ServerInfoComponent />
          </Suspense>

          <div data-testid="otherComponents">other components</div>
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    expect(queryByTestId(baseElement, 'loading')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument())
    expect(screen.getByTestId('serverInfo')).toBeInTheDocument()
  })

  test('first-item', async () => {
    const serverInfoAtom = atom(function () {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ id: 1 }, { id: 2 }])
        }, 1000)
      }) as Promise<{ id: number }[]>
    })

    serverInfoAtom.debugLabel = 'serverInfoAtom'

    const firstItemAtom = atom(async (getter) => {
      const serverInfo = await getter(serverInfoAtom)
      return serverInfo[0]
    })
    firstItemAtom.debugLabel = 'firstItemAtom'

    function FirstItem() {
      const firstItemInfo = useAtomValue(firstItemAtom)

      return <div data-testid="firstItem">{firstItemInfo.id}</div>
    }
    function App() {
      return (
        <div data-testid="app">
          <Suspense fallback={<div data-testid="loading">loading</div>}>
            <FirstItem />
          </Suspense>

          <div data-testid="otherComponents">other components</div>
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    await waitFor(() => {
      expect(queryByTestId(baseElement, 'firstItem')).not.toBeInTheDocument()
    })

    expect(queryByTestId(baseElement, 'loading')).toBeInTheDocument()
    await screen.findByTestId('firstItem')
    expect(queryByTestId(baseElement, 'firstItem')).toBeInTheDocument()
  })

  test('sxxx', async () => {
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

      console.log(`state`, state)
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

  test('sxxx with component', async () => {
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

      console.log(`state`, serverInfo)

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

    // 等待异步操作完成
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    })

    // 验证初始状态
    expect(screen.getByTestId('server-info')).toHaveTextContent('ID: 1')

    // 点击按钮更新状态
    await act(async () => {
      screen.getByTestId('update-button').click()
    })

    // 验证状态已更新
    expect(screen.getByTestId('server-info')).toHaveTextContent('ID: 2')
  })
})
