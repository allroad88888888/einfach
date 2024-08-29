import { describe, test, expect } from '@jest/globals'
import { atom } from './atom'
import { useAtomValue } from '../react'
import { queryByTestId, render, screen } from '@testing-library/react'
import { Suspense } from 'react'

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
    await screen.findByTestId('serverInfo')
  })

  test('first-item', async () => {
    const serverInfoAtom = atom(function () {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ id: 1 }, { id: 2 }])
        }, 1000)
      }) as Promise<{ id: number }[]>
    })

    const firstItemAtom = atom(async (getter) => {
      const serverInfo = await getter(serverInfoAtom)
      return serverInfo[0]
    })

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
    expect(queryByTestId(baseElement, 'firstItem')).not.toBeInTheDocument()
    expect(queryByTestId(baseElement, 'loading')).toBeInTheDocument()
    await screen.findByTestId('firstItem')
    expect(queryByTestId(baseElement, 'firstItem')).toBeInTheDocument()
  })
})
