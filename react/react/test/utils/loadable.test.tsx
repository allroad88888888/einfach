import { describe, test, expect } from '@jest/globals'

import { useAtom } from '../../src'
import { queryByTestId, render, screen } from '@testing-library/react'

import { atom } from '@einfach/core'
import { loadable } from '../../src/utils/loadable'
import userEvent from '@testing-library/user-event'

describe('async', () => {
  test('serverInfo', async () => {
    const serverInfoAtom = atom(function () {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ id: 1 }, { id: 2 }])
        }, 1000)
      }) as Promise<{ id: number }[]>
    })

    serverInfoAtom.debugLabel = ' server async'

    function ServerInfoComponent() {
      const xxAtom = loadable(serverInfoAtom, { autoRun: false })
      xxAtom.debugLabel = 'loadable atom'
      const [{ data: serverInfo, state }, run] = useAtom(xxAtom)

      if (state === 'loading') {
        return <div data-testid="loading">loading</div>
      }

      return (
        <div
          data-testid="serverInfo"
          onClick={() => {
            run()
          }}
        >
          {serverInfo?.[0].id}
        </div>
      )
    }
    function App() {
      return (
        <div data-testid="app">
          <ServerInfoComponent />
          <div data-testid="otherComponents">other components</div>
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    await screen.findByTestId('serverInfo')
    await userEvent.click(screen.getByTestId('serverInfo'))
    expect(queryByTestId(baseElement, 'loading')).toBeInTheDocument()
    await screen.findByTestId('serverInfo')
    expect(screen.getByTestId('serverInfo')).toHaveTextContent('1')
  })
})
