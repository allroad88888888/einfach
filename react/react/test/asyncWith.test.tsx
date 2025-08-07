import { describe, test, expect, jest } from '@jest/globals'
import { atom } from '@einfach/core'
import { act, queryByTestId, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { useAtom, useAtomValue } from '../src'

describe('async', () => {
  test('异步获取服务器信息并显示', async () => {
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

  test('异步获取第一个项目数据', async () => {
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

  test('组合两个异步 atom 的数据', async () => {
    // 定义类型
    type UserInfo = {
      id: number
      name: string
      email: string
    }

    type UserPermissions = {
      canEdit: boolean
      canDelete: boolean
      role: string
    }

    // 创建 mock 函数来追踪调用次数
    const fetchUserInfo = jest.fn()
    const fetchUserPermissions = jest.fn()
    const fetchUserProfile = jest.fn()
    const fetchUserProfile2 = jest.fn()

    // 第一个异步 atom - 获取用户信息
    const userInfoAtom = atom(async () => {
      fetchUserInfo()
      return new Promise<UserInfo>((resolve) => {
        setTimeout(() => {
          resolve({ id: 1, name: '张三', email: 'zhangsan@example.com' })
        }, 800)
      })
    })

    // 第二个异步 atom - 获取用户权限
    const userPermissionsAtom = atom(async () => {
      fetchUserPermissions()
      return new Promise<UserPermissions>((resolve) => {
        setTimeout(() => {
          resolve({ canEdit: true, canDelete: false, role: 'editor' })
        }, 1200)
      })
    })

    // 组合两个异步 atom 的数据
    const userProfileAtom = atom(async (getter) => {
      fetchUserProfile()
      const [userInfo, permissions] = await Promise.all([
        getter(userInfoAtom),
        getter(userPermissionsAtom),
      ])
      fetchUserProfile2()

      return {
        ...userInfo,
        ...permissions,
        displayName: `${userInfo.name} (${permissions.role})`,
      }
    })

    function UserProfile() {
      const profile = useAtomValue(userProfileAtom)

      return (
        <div>
          <div data-testid="user-name">{profile.displayName}</div>
          <div data-testid="user-email">{profile.email}</div>
          <div data-testid="user-permissions">
            编辑权限: {profile.canEdit ? '有' : '无'} | 删除权限: {profile.canDelete ? '有' : '无'}
          </div>
        </div>
      )
    }

    function App() {
      return (
        <Suspense fallback={<div data-testid="loading">加载用户信息中...</div>}>
          <UserProfile />
        </Suspense>
      )
    }

    render(<App />)

    // 验证加载状态
    expect(screen.getByTestId('loading')).toBeInTheDocument()
    expect(screen.getByTestId('loading')).toHaveTextContent('加载用户信息中...')

    // 等待异步操作完成
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })

    // 验证组合后的数据正确显示
    expect(screen.getByTestId('user-name')).toHaveTextContent('张三 (editor)')
    expect(screen.getByTestId('user-email')).toHaveTextContent('zhangsan@example.com')
    expect(screen.getByTestId('user-permissions')).toHaveTextContent('编辑权限: 有 | 删除权限: 无')

    // 验证每个异步方法只执行了一次
    expect(fetchUserInfo).toHaveBeenCalledTimes(1)
    expect(fetchUserPermissions).toHaveBeenCalledTimes(1)
    expect(fetchUserProfile).toHaveBeenCalledTimes(1)
    expect(fetchUserProfile2).toHaveBeenCalledTimes(1)
  })
})
