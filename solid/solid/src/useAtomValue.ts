import { Atom, AtomState, StatesWithPromise } from '@einfach/core'
import { createSignal, onCleanup } from 'solid-js'
import { HookOption } from './type'
import { useStore } from './useStore'
import { useAsyncAtomValue } from './useAsyncAtomValue'

/**
 * 使用 atom 值的 hook，只读
 * @param atom Atom 实例
 * @param options 可选配置
 * @returns atom 的当前值
 */
export function useAtomValue<State>(
  atom: Atom<State>,
  options?: HookOption
): () => State extends Promise<infer T> ? (T | undefined) : State
export function useAtomValue<AtomType extends Atom<unknown>>(
  atom: AtomType,
  options?: HookOption
): () => AtomState<AtomType>
export function useAtomValue<State>(
  atom: Atom<State>,
  options: HookOption = {}
) {
  const store = useStore(options)

  // 先检查atom的值是否是异步的，如果是使用异步处理函数
  const initialValue = store.getter(atom)
  /**
   * 这里有个缺陷 初始是同步值，后续改为异步，会导致无法触发Suspense
   */
  if (isPromiseLike(initialValue)) {
    // 使用异步专用函数处理异步atom
    const [resource] = useAsyncAtomValue(atom, options)
    return resource
  } else {
    // 对于同步atom，使用标准的实现
    const [value, setValue] = createSignal(initialValue)

    // 订阅 atom 变化
    const unsubscribe = store.sub(atom, () => {
      setValue(() => store.getter(atom))
    })

    // 组件卸载时取消订阅
    onCleanup(() => {
      unsubscribe()
    })

    // 对于同步值，直接返回信号的值
    return value
  }
}

function isPromiseLike<T>(promise: any): promise is StatesWithPromise<T> {
  return typeof (promise == null ? void 0 : promise.then) === 'function'
}
