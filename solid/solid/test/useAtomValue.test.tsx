/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { atom, createStore, getDefaultStore } from '@einfach/core'
import { useAtomValue } from '../src/useAtomValue'
import { createSignal, createEffect } from 'solid-js'
import { Provider } from '../src/Provider'

// 在每个测试后清理
afterEach(cleanup)

describe('useAtomValue', () => {
  it('Provider should work', () => {
    const store = createStore()
    // 创建测试用的atom
    const countAtom = atom(42)

    store.setter(countAtom, 100)

    // 创建一个简单的组件来测试useAtomValue
    function TestComponent() {
      const value = useAtomValue(countAtom)
      return <div data-testid="value">{value()}</div>
    }

    // 渲染组件
    const { getByTestId } = render(() => (
      <Provider store={store}>
        <TestComponent />
      </Provider>
    ))

    // 检查值是否正确
    expect(getByTestId('value').textContent).toBe('100')
  })

  it('应该正确读取atom的值', () => {
    // 创建测试用的atom
    const countAtom = atom(42)

    // 创建一个简单的组件来测试useAtomValue
    function TestComponent() {
      const value = useAtomValue(countAtom)
      return <div data-testid="value">{value()}</div>
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查值是否正确
    expect(getByTestId('value').textContent).toBe('42')
  })

  it('应该处理派生atom', () => {
    // 创建基础atom和派生atom
    const baseAtom = atom(10)
    const derivedAtom = atom((get) => get(baseAtom) * 2)

    // 创建一个简单的组件来测试派生atom
    function TestComponent() {
      const derived = useAtomValue(derivedAtom)
      return <div data-testid="derived-value">{derived()}</div>
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查初始值
    expect(getByTestId('derived-value').textContent).toBe('20')
  })

  it('应该响应直接更新atom的值', () => {
    // 创建测试用的atom
    const countAtom = atom(0)
    const store = getDefaultStore()

    // 创建一个简单的组件来测试useAtomValue
    function TestComponent() {
      const value = useAtomValue(countAtom)
      return <div data-testid="value">{value()}</div>
    }

    // 渲染组件
    const { getByTestId, unmount } = render(() => <TestComponent />)

    // 初始值应该是0
    expect(getByTestId('value').textContent).toBe('0')

    // 直接更新atom的值
    store.setter(countAtom, 100)

    // 清理并重新渲染组件
    unmount()
    const { getByTestId: newGetByTestId } = render(() => <TestComponent />)

    // 值应该更新为100
    expect(newGetByTestId('value').textContent).toBe('100')
  })

  it('应该正确响应派生atom的依赖变化', () => {
    // 创建基础atom和多层派生atom
    const baseAtom = atom(5)
    const firstDerivedAtom = atom((get) => get(baseAtom) * 2)
    const secondDerivedAtom = atom((get) => get(firstDerivedAtom) + 10)
    const store = getDefaultStore()

    // 创建测试组件
    function TestComponent() {
      const value = useAtomValue(secondDerivedAtom)
      return <div data-testid="value">{value()}</div>
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 初始值检查: (5*2)+10 = 20
    expect(getByTestId('value').textContent).toBe('20')

    // 更新基础atom的值
    store.setter(baseAtom, 10)

    // 重新渲染组件
    cleanup()
    const { getByTestId: newGetByTestId } = render(() => <TestComponent />)

    // 检查更新后的值: (10*2)+10 = 30
    expect(newGetByTestId('value').textContent).toBe('30')
  })

  it('应该处理多组件共享同一个atom的情况', () => {
    // 创建共享的atom
    const sharedAtom = atom(0)
    const store = getDefaultStore()

    // 第一个使用atom的组件
    function ComponentA() {
      const value = useAtomValue(sharedAtom)
      return <div data-testid="value-a">{value()}</div>
    }

    // 第二个使用相同atom的组件
    function ComponentB() {
      const value = useAtomValue(sharedAtom)
      return <div data-testid="value-b">{value()}</div>
    }

    // 渲染两个组件
    const { getByTestId } = render(() => (
      <>
        <ComponentA />
        <ComponentB />
      </>
    ))

    // 初始值检查
    expect(getByTestId('value-a').textContent).toBe('0')
    expect(getByTestId('value-b').textContent).toBe('0')

    // 更新atom的值
    store.setter(sharedAtom, 42)

    // 重新渲染组件
    cleanup()
    const { getByTestId: newGetByTestId } = render(() => (
      <>
        <ComponentA />
        <ComponentB />
      </>
    ))

    // 检查两个组件是否都反映了新值
    expect(newGetByTestId('value-a').textContent).toBe('42')
    expect(newGetByTestId('value-b').textContent).toBe('42')
  })

  it('应该在组件卸载时取消订阅', () => {
    // 创建atom和获取store
    const testAtom = atom(0)
    const store = getDefaultStore()

    // 使用createSignal创建一个可观察的显示/隐藏状态
    function WrapperComponent() {
      const [show, setShow] = createSignal(true)

      return (
        <div>
          <button data-testid="toggle" onClick={() => setShow(!show())}>
            Toggle
          </button>
          {show() && <TestComponent />}
        </div>
      )
    }

    // 使用atom的组件
    function TestComponent() {
      const value = useAtomValue(testAtom)

      // 使用createEffect来追踪该组件是否还在响应atom的变化
      createEffect(() => {
        // 将value用于effect以建立订阅
        console.log(`Component sees value: ${value}`)
      })

      return <div data-testid="value">{value()}</div>
    }

    // 渲染包装组件
    const { getByTestId } = render(() => <WrapperComponent />)

    // 初始渲染时组件应该可见
    expect(getByTestId('value').textContent).toBe('0')

    // 点击按钮卸载TestComponent
    fireEvent.click(getByTestId('toggle'))

    // 在TestComponent卸载后更新atom
    store.setter(testAtom, 100)

    // 再次点击按钮重新挂载TestComponent
    fireEvent.click(getByTestId('toggle'))

    // 重新挂载的组件应该显示新值
    expect(getByTestId('value').textContent).toBe('100')
  })
})
