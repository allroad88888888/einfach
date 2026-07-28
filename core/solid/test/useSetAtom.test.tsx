/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { atom, getDefaultStore } from '@einfach/core'
import { useSetAtom } from '../src/useSetAtom'
import { useAtomValue } from '../src/useAtomValue'
import { createSignal } from 'solid-js'

// 在每个测试后清理
afterEach(cleanup)

describe('useSetAtom', () => {
  it('应该正确更新atom的值', () => {
    // 创建测试用的atom
    const countAtom = atom(0)

    // 创建一个组件来测试useSetAtom
    function TestComponent() {
      const value = useAtomValue(countAtom)
      const setValue = useSetAtom(countAtom)

      return (
        <div>
          <div data-testid="value">{value()}</div>
          <button data-testid="increment" onClick={() => setValue((prev) => prev + 1)}>
            增加
          </button>
        </div>
      )
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查初始值
    expect(getByTestId('value').textContent).toBe('0')

    // 点击按钮增加值
    fireEvent.click(getByTestId('increment'))

    // 检查更新后的值
    expect(getByTestId('value').textContent).toBe('1')

    // 再次点击
    fireEvent.click(getByTestId('increment'))
    expect(getByTestId('value').textContent).toBe('2')
  })

  it('应该能直接设置新值', () => {
    // 创建测试用的atom
    const textAtom = atom('初始文本')

    // 创建一个组件来测试直接设置值
    function TestComponent() {
      const value = useAtomValue(textAtom)
      const setValue = useSetAtom(textAtom)

      return (
        <div>
          <div data-testid="text">{value()}</div>
          <button data-testid="change-text" onClick={() => setValue('新文本')}>
            更改文本
          </button>
        </div>
      )
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查初始值
    expect(getByTestId('text').textContent).toBe('初始文本')

    // 点击按钮更改文本
    fireEvent.click(getByTestId('change-text'))

    // 检查更新后的值
    expect(getByTestId('text').textContent).toBe('新文本')
  })

  it('应该在多个组件之间共享状态', () => {
    // 创建共享的atom
    const sharedAtom = atom(0)

    // 第一个组件显示值
    function DisplayComponent() {
      const value = useAtomValue(sharedAtom)
      return <div data-testid="display-value">{value()}</div>
    }

    // 第二个组件更新值
    function ControlComponent() {
      const setValue = useSetAtom(sharedAtom)

      return (
        <div>
          <button data-testid="set-to-10" onClick={() => setValue(10)}>
            设置为10
          </button>
          <button data-testid="set-to-20" onClick={() => setValue(20)}>
            设置为20
          </button>
        </div>
      )
    }

    // 包含两个组件的父组件
    function ParentComponent() {
      return (
        <div>
          <DisplayComponent />
          <ControlComponent />
        </div>
      )
    }

    // 渲染父组件
    const { getByTestId } = render(() => <ParentComponent />)

    // 检查初始值
    expect(getByTestId('display-value').textContent).toBe('0')

    // 点击按钮设置为10
    fireEvent.click(getByTestId('set-to-10'))
    expect(getByTestId('display-value').textContent).toBe('10')

    // 点击按钮设置为20
    fireEvent.click(getByTestId('set-to-20'))
    expect(getByTestId('display-value').textContent).toBe('20')
  })

  it('应该支持自定义store', () => {
    // 创建一个自定义store
    const customStore = getDefaultStore()

    // 创建atom
    const countAtom = atom(5)

    // 创建一个使用自定义store的组件
    function TestComponent() {
      const value = useAtomValue(countAtom, { store: customStore })
      const setValue = useSetAtom(countAtom, { store: customStore })

      return (
        <div>
          <div data-testid="value">{value()}</div>
          <button data-testid="increment" onClick={() => setValue((prev) => prev + 5)}>
            增加5
          </button>
        </div>
      )
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查初始值
    expect(getByTestId('value').textContent).toBe('5')

    // 点击按钮增加值
    fireEvent.click(getByTestId('increment'))

    // 检查更新后的值
    expect(getByTestId('value').textContent).toBe('10')
  })

  it('应该正确处理writableAtom', () => {
    // 创建一个可写的atom，接受多个参数
    const multiParamAtom = atom(
      { count: 0, text: '' },
      (get, setter, newCount: number, newText: string) => {
        // @ts-ignore
        setter(multiParamAtom, { count: newCount, text: newText })
      },
    )

    // 创建使用可写atom的组件
    function TestComponent() {
      const state = useAtomValue(multiParamAtom)
      const setState = useSetAtom(multiParamAtom)

      return (
        <div>
          <div data-testid="count">{state().count}</div>
          <div data-testid="text">{state().text}</div>
          <button data-testid="update-both" onClick={() => setState(42, '已更新')}>
            更新数值和文本
          </button>
        </div>
      )
    }

    // 渲染组件
    const { getByTestId } = render(() => <TestComponent />)

    // 检查初始值
    expect(getByTestId('count').textContent).toBe('0')
    expect(getByTestId('text').textContent).toBe('')

    // 点击按钮更新值
    fireEvent.click(getByTestId('update-both'))

    // 检查更新后的值
    expect(getByTestId('count').textContent).toBe('42')
    expect(getByTestId('text').textContent).toBe('已更新')
  })

  it('应该可以在条件渲染中正确工作', () => {
    // 创建atom
    const countAtom = atom(0)

    // 创建一个条件渲染的组件
    function ConditionalComponent() {
      const [show, setShow] = createSignal(true)

      return (
        <div>
          <button data-testid="toggle" onClick={() => setShow(!show())}>
            切换显示
          </button>
          {show() && <CounterComponent />}
        </div>
      )
    }

    // 使用atom的计数器组件
    function CounterComponent() {
      const count = useAtomValue(countAtom)
      const setCount = useSetAtom(countAtom)

      return (
        <div>
          <div data-testid="count">{count()}</div>
          <button data-testid="increment" onClick={() => setCount((c) => c + 1)}>
            增加
          </button>
        </div>
      )
    }

    // 渲染组件
    const { getByTestId, queryByTestId } = render(() => <ConditionalComponent />)

    // 测试初始渲染
    expect(getByTestId('count').textContent).toBe('0')

    // 增加计数
    fireEvent.click(getByTestId('increment'))
    expect(getByTestId('count').textContent).toBe('1')

    // 隐藏组件
    fireEvent.click(getByTestId('toggle'))
    expect(queryByTestId('count')).toBeNull()

    // 再次显示组件，应该保持之前的状态
    fireEvent.click(getByTestId('toggle'))
    expect(getByTestId('count').textContent).toBe('1')
  })
})
