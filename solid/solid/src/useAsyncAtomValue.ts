import { Atom } from '@einfach/core'
import { createResource } from 'solid-js'
import { HookOption } from './type'
import { useStore } from './useStore'

/**
 * 使用异步atom值的hook，适配SolidJS的Suspense机制
 * 通过createResource处理异步atom值
 * @param atom Atom实例
 * @param options 可选配置
 * @returns 异步atom的值
 */
export function useAsyncAtomValue<State>(
    atom: Atom<State>,
    options: HookOption = {}
) {
    const store = useStore(options)
    // 获取atom的当前值
    const fetchAtomValue = async () => {
        const value = store.getter(atom)
        return await value
    }

    return createResource(fetchAtomValue)
} 