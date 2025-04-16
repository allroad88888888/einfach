/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup } from '@solidjs/testing-library'
import { atom } from '@einfach/core'
import { loadable, useLoadable } from '../../src/utils/loadable'

// 在每个测试后清理
afterEach(cleanup)

describe('loadable', () => {
  // 模拟数据
  interface MockData {
    id: number
    name: string
  }

  const mockData: MockData = { id: 1, name: '测试数据' }
  // 模拟错误消息
  const mockErrorMessage = '加载失败'

  it('应该处理异步函数并显示加载状态和成功状态', async () => {
    // 创建异步函数
    const successFnAtom = atom(() => {
      return new Promise<MockData>((resolve) => {
        setTimeout(() => {
          resolve(mockData)
        }, 100)
      })
    })

    // 创建一个使用loadable的组件
    function TestComponent() {
      const loadableAtom = loadable(successFnAtom)
      const value = useLoadable(loadableAtom)

      return (
        <div>
          {value().loading ? (
            <div data-testid="loading">加载中...</div>
          ) : value().status === 'hasData' && value().data ? (
            <div data-testid="data">{value().data?.name}</div>
          ) : (
            <div data-testid="error">{value().error?.message}</div>
          )}
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, findByTestId } = render(() => <TestComponent />)

    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')

    // 等待数据加载完成
    const dataElement = await findByTestId('data', {}, { timeout: 400 })
    expect(dataElement.textContent).toBe('测试数据')
  })

  it('应该处理异步函数的错误状态', async () => {
    // 创建会失败的异步函数
    const failureFnAtom = atom(() => {
      return new Promise<MockData>((_, reject) => {
        setTimeout(() => {
          reject(new Error(mockErrorMessage))
        }, 100)
      })
    })

    // 创建一个使用loadable的组件，但使用会失败的异步函数
    function TestComponent() {
      const loadableAtom = loadable(failureFnAtom)
      const value = useLoadable(loadableAtom)

      return (
        <div>
          {value().loading ? (
            <div data-testid="loading">加载中...</div>
          ) : value().status === 'hasData' && value().data ? (
            <div data-testid="data">{value().data?.name}</div>
          ) : (
            <div data-testid="error">{value().error?.message}</div>
          )}
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, findByTestId } = render(() => <TestComponent />)

    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')

    // 等待错误状态出现
    const errorElement = await findByTestId('error', {}, { timeout: 200 })
    expect(errorElement.textContent).toBe(mockErrorMessage)
  })

  it('应该处理异步atom', async () => {
    // 创建异步函数
    const successFn = () => {
      return new Promise<MockData>((resolve) => {
        setTimeout(() => {
          resolve(mockData)
        }, 100)
      })
    }

    // 创建一个异步atom
    const asyncAtom = atom(async () => {
      const data = await successFn()
      return data
    })

    // 创建一个使用loadable的组件，使用异步atom
    function TestComponent() {
      const loadableAtom = loadable(asyncAtom)
      const value = useLoadable(loadableAtom)

      return (
        <div>
          {value().loading ? (
            <div data-testid="loading">加载中...</div>
          ) : value().status === 'hasData' && value().data ? (
            <div data-testid="data">{value().data?.name}</div>
          ) : (
            <div data-testid="error">{value().error?.message}</div>
          )}
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, findByTestId } = render(() => <TestComponent />)

    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')

    // 等待数据加载完成
    const dataElement = await findByTestId('data', {}, { timeout: 200 })
    expect(dataElement.textContent).toBe('测试数据')
  })

  it('应该处理加载状态的变化', async () => {
    // 创建异步函数
    const successFn = () => {
      return new Promise<MockData>((resolve) => {
        setTimeout(() => {
          resolve(mockData)
        }, 100)
      })
    }

    // 创建一个异步atom
    const asyncAtom = atom(async () => {
      const data = await successFn()
      return data
    })

    // 创建一个使用loadable的组件，展示所有状态信息
    function TestComponent() {
      const loadableAtom = loadable(asyncAtom)
      const value = useLoadable(loadableAtom)

      return (
        <div>
          <div data-testid="status">状态: {value().status}</div>
          <div data-testid="loading">加载中: {value().loading.toString()}</div>
          {value().data && <div data-testid="data">{value().data?.name}</div>}
          {value().error && <div data-testid="error">{value()?.error?.message}</div>}
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, findByTestId } = render(() => <TestComponent />)

    // 初始状态检查
    expect(getByTestId('status').textContent).toBe('状态: loading')
    expect(getByTestId('loading').textContent).toBe('加载中: true')

    // 等待数据加载完成
    await findByTestId('data', {}, { timeout: 200 })

    // 检查最终状态
    expect(getByTestId('status').textContent).toBe('状态: hasData')
    expect(getByTestId('loading').textContent).toBe('加载中: false')
    expect(getByTestId('data').textContent).toBe('测试数据')
  })

  it('应该能处理非Error类型的错误', async () => {
    // 创建一个会抛出字符串错误的异步函数
    const stringErrorFnAtom = atom(() => {
      return new Promise<string>((_, reject) => {
        setTimeout(() => {
          reject('字符串错误消息')
        }, 100)
      })
    })

    // 创建一个使用loadable的组件
    function TestComponent() {
      const loadableAtom = loadable(stringErrorFnAtom)
      const value = useLoadable(loadableAtom)

      return (
        <div>
          {value().loading ? (
            <div data-testid="loading">加载中...</div>
          ) : value().status === 'hasData' ? (
            <div data-testid="data">成功</div>
          ) : (
            <div data-testid="error">{value().error as unknown as string}</div>
          )}
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, findByTestId } = render(() => <TestComponent />)

    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')

    // 等待错误状态出现
    const errorElement = await findByTestId('error', {}, { timeout: 500 })

    // 非Error类型的错误应该被转换为Error对象
    expect(errorElement.textContent).toBe('字符串错误消息')
  })
})
