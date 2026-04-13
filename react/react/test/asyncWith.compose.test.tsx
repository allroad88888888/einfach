import { describe, test, expect, jest } from '@jest/globals'
import { atom } from '@einfach/core'
import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { useAtomValue } from '../src'

describe('async - 组合场景', () => {
  test('组合两个异步 atom 的数据', async () => {
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

    const fetchUserInfo = jest.fn()
    const fetchUserPermissions = jest.fn()
    const fetchUserProfile = jest.fn()
    const fetchUserProfile2 = jest.fn()

    const userInfoAtom = atom(async () => {
      fetchUserInfo()
      return new Promise<UserInfo>((resolve) => {
        setTimeout(() => {
          resolve({ id: 1, name: '张三', email: 'zhangsan@example.com' })
        }, 800)
      })
    })

    const userPermissionsAtom = atom(async () => {
      fetchUserPermissions()
      return new Promise<UserPermissions>((resolve) => {
        setTimeout(() => {
          resolve({ canEdit: true, canDelete: false, role: 'editor' })
        }, 1200)
      })
    })

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

    expect(screen.getByTestId('loading')).toBeInTheDocument()
    expect(screen.getByTestId('loading')).toHaveTextContent('加载用户信息中...')

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    })

    expect(screen.getByTestId('user-name')).toHaveTextContent('张三 (editor)')
    expect(screen.getByTestId('user-email')).toHaveTextContent('zhangsan@example.com')
    expect(screen.getByTestId('user-permissions')).toHaveTextContent('编辑权限: 有 | 删除权限: 无')

    expect(fetchUserInfo).toHaveBeenCalledTimes(1)
    expect(fetchUserPermissions).toHaveBeenCalledTimes(1)
    expect(fetchUserProfile).toHaveBeenCalledTimes(1)
    expect(fetchUserProfile2).toHaveBeenCalledTimes(1)
  })
})
