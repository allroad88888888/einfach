/** @jsxImportSource solid-js */
import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals'
import { render, cleanup } from '@solidjs/testing-library'
import { atom, getDefaultStore, Getter } from '@einfach/core'
import { useAtomValue } from '../src/useAtomValue'
import { Suspense } from 'solid-js'

// 接口定义
interface MockData {
  id: number
  name: string
}

// 在每个测试后清理
afterEach(cleanup)

describe('useAtomValue与异步atom和Suspense', () => {
  // 模拟数据和延迟
  const mockData: MockData = { id: 1, name: '测试数据' }

  // 模拟API函数
  let mockFetch: jest.Mock<() => Promise<MockData>>

  beforeEach(() => {
    // 重置mock函数
    mockFetch = jest.fn().mockImplementation(() => {
      return new Promise<MockData>((resolve) => {
        // 模拟网络延迟
        setTimeout(() => {
          resolve(mockData)
        }, 500)
      })
    }) as jest.Mock<() => Promise<MockData>>
  })

  it('应该在加载时显示fallback，加载完成后显示数据', async () => {
    // 创建一个异步atom
    const asyncAtom = atom(async () => {
      const data = await mockFetch()
      return data
    })

    // 创建一个使用异步atom的组件
    function AsyncComponent() {
      const data = useAtomValue(asyncAtom)
      return <div data-testid="loaded-data">{data()?.name}</div>
    }

    // 使用Suspense包装组件
    function TestComponent() {
      return (
        <Suspense fallback={<div data-testid="loading">加载中...</div>}>
          <AsyncComponent />
        </Suspense>
      )
    }

    // 渲染组件
    const { findByTestId, getByTestId } = render(() => <TestComponent />)

    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')

    // 等待异步加载完成并检查结果
    const loadedElement = await findByTestId('loaded-data')
    expect(loadedElement.textContent).toBe('测试数据')

    // 验证mockFetch被调用
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('应该能处理多个嵌套的异步atom', async () => {
    // 创建第一个异步atom
    const firstAsyncAtom = atom(async () => {
      const data = await mockFetch()
      return data.id
    })

    // 创建依赖于第一个atom的第二个异步atom
    const secondAsyncAtom = atom(async (get: Getter) => {
      const id = await get(firstAsyncAtom)
      const secondData = (await mockFetch()) as MockData
      return `ID: ${id}, 名称: ${secondData.name}`
    })

    // 创建使用第二个异步atom的组件
    function NestedAsyncComponent() {
      const result = useAtomValue(secondAsyncAtom)
      return <div data-testid="nested-result">{result()}</div>
    }

    // 渲染组件
    const { findByTestId, getByTestId } = render(() => (
      <Suspense fallback={<div data-testid="loading">加载中...</div>}>
        <NestedAsyncComponent />
      </Suspense>
    ))
    // 初始应该显示loading状态
    expect(getByTestId('loading').textContent).toBe('加载中...')
    // 等待异步加载完成并检查结果
    const resultElement = await findByTestId('nested-result', undefined, { timeout: 1200 })
    expect(resultElement.textContent).toBe(`ID: 1, 名称: 测试数据`)

    // 验证mockFetch被调用了两次（每个atom各一次）
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('应该能正确处理状态更新', async () => {
    // 创建一个可写的异步atom
    const countAtom = atom(0)
    const asyncDataAtom = atom(async (get: Getter) => {
      const count = get(countAtom)
      const data = (await mockFetch()) as MockData
      return `${data.name} (${count})`
    })

    const store = getDefaultStore()

    // 创建一个使用异步atom的组件
    function UpdateableAsyncComponent() {
      const data = useAtomValue(asyncDataAtom)
      return <div data-testid="async-data">{data()}</div>
    }

    // 渲染组件
    const { findByTestId } = render(() => (
      <Suspense fallback={<div data-testid="loading">加载中...</div>}>
        <UpdateableAsyncComponent />
      </Suspense>
    ))

    // 等待初始数据加载
    const dataElement = await findByTestId('async-data', undefined, { timeout: 600 })
    expect(dataElement.textContent).toBe('测试数据 (0)')

    // 更新依赖的atom
    store.setter(countAtom, 42)

    // 清理并重新渲染（因为Solid的测试工具与React不同，需要清理和重新渲染）
    cleanup()
    const { findByTestId: newFindByTestId } = render(() => (
      <Suspense fallback={<div data-testid="loading">加载中...</div>}>
        <UpdateableAsyncComponent />
      </Suspense>
    ))

    // 等待新数据加载
    const updatedElement = await newFindByTestId('async-data', undefined, { timeout: 600 })
    expect(updatedElement.textContent).toBe('测试数据 (42)')
  })

  it('应该能处理嵌套的Suspense组件', async () => {
    // 创建两个具有不同延迟的异步atom
    const fastAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return '快速数据'
    })

    const slowAtom = atom(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return '慢速数据'
    })

    // 创建两个使用不同atom的组件
    function FastComponent() {
      const data = useAtomValue(fastAtom)
      return <div data-testid="fast-data">{data()}</div>
    }

    function SlowComponent() {
      const data = useAtomValue(slowAtom)
      return <div data-testid="slow-data">{data()}</div>
    }

    // 创建嵌套的Suspense组件
    function NestedSuspenseComponent() {
      return (
        <Suspense fallback={<div data-testid="outer-loading">外部加载中...</div>}>
          <div>
            <FastComponent />
            <Suspense fallback={<div data-testid="inner-loading">内部加载中...</div>}>
              <SlowComponent />
            </Suspense>
          </div>
        </Suspense>
      )
    }

    // 渲染组件
    const { findByTestId, queryByTestId } = render(() => <NestedSuspenseComponent />)

    // 初始应该显示外部loading
    expect(await findByTestId('outer-loading', undefined, { timeout: 1200 })).toBeDefined()

    // 等待快速数据加载完成
    const fastElement = await findByTestId('fast-data', undefined, { timeout: 1200 })
    expect(fastElement.textContent).toBe('快速数据')

    // 此时应该显示内部loading
    expect(await findByTestId('inner-loading', undefined, { timeout: 1200 })).toBeDefined()

    // 等待慢速数据加载完成
    const slowElement = await findByTestId('slow-data', undefined, { timeout: 1200 })
    expect(slowElement.textContent).toBe('慢速数据')

    // 此时应该不再显示任何loading
    expect(queryByTestId('outer-loading')).toBeNull()
    expect(queryByTestId('inner-loading')).toBeNull()
  })

  // it('应该能处理从同步atom转变为异步atom的情况', async () => {
  //   const store = getDefaultStore()
  //   // 创建一个标志来控制是同步还是异步
  //   const isAsyncAtom = atom(false)

  //   // 创建一个可以在同步和异步之间切换的atom
  //   const switchableAtom = atom((get: Getter) => {
  //     if (get(isAsyncAtom)) {
  //       // 异步模式
  //       return Promise.resolve().then(async () => {
  //         const data = await mockFetch()
  //         return data.name
  //       })
  //     } else {
  //       // 同步模式
  //       return '初始同步数据'
  //     }
  //   })

  //   // 创建一个组件，包含一个按钮来切换atom模式
  //   function SwitchableComponent() {
  //     const data = useAtomValue(switchableAtom)

  //     const handleClick = () => {
  //       // 切换到异步模式
  //       store.setter(isAsyncAtom, true)
  //     }

  //     return (
  //       <div>
  //         <div data-testid="data-display">{data()}</div>
  //         <button data-testid="switch-button" onClick={handleClick}>
  //           切换到异步模式
  //         </button>
  //       </div>
  //     )
  //   }

  //   // 使用Suspense包装组件
  //   function TestComponent() {
  //     return (
  //       <Suspense fallback={<div data-testid="suspense-loading">Suspense加载中...</div>}>
  //         <SwitchableComponent />
  //       </Suspense>
  //     )
  //   }

  //   // 渲染组件
  //   const { getByTestId, findByTestId, queryByTestId } = render(() => <TestComponent />)

  //   // 初始应该显示同步数据
  //   expect(getByTestId('data-display').textContent).toBe('初始同步数据')

  //   // 确认不应该有任何加载指示器
  //   expect(queryByTestId('suspense-loading')).toBeNull()
  //   expect(queryByTestId('manual-loading')).toBeNull()

  //   // 点击按钮切换到异步模式
  //   getByTestId('switch-button').click()

  //   // 应该显示Suspense的加载指示器
  //   expect(await findByTestId('suspense-loading', undefined, { timeout: 300 })).toBeDefined()

  //   // 等待异步数据加载完成
  //   const updatedDisplay = await findByTestId('data-display', undefined, { timeout: 600 })
  //   expect(updatedDisplay.textContent).toBe('测试数据')

  //   // 确认mockFetch被调用
  //   expect(mockFetch).toHaveBeenCalledTimes(1)
  // })
})
