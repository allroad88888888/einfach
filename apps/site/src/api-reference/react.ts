import type { ApiPackage } from './types'

export const reactApiPackage: ApiPackage = {
  id: 'react',
  label: 'React',
  packageName: '@einfach/react',
  summary: 'React Provider、读写 hooks 与异步 UI 适配；同时完整再导出 @einfach/core。',
  reexportsCore: true,
  sections: [
    {
      title: 'React Store 边界',
      navLabel: 'Store 边界',
      description:
        '用 Provider 划定 store 边界；任意子组件都可直接读取同一个 atom，不需要向下传状态 props。',
      entries: [
        {
          name: 'Provider',
          role: 'Store Provider',
          description: '把指定 Store 提供给 React 子树。',
          code: 'const store = createStore()\n<Provider store={store}><App /></Provider>',
        },
        {
          name: 'StoreContext',
          role: 'Store Context',
          description: 'React Store Context，通常由 Provider 和 useStore 间接使用。',
          code: 'const store = useContext(StoreContext)',
        },
        {
          name: 'HookOption',
          role: 'Hook 选项',
          description: '为 React hooks 指定可选的 store。',
          code: 'const options: HookOption = { store }',
          kind: 'type',
        },
        {
          name: 'useStore',
          role: '读取 Store',
          description: '取得显式 store、Provider store 或默认 store。',
          code: 'const store = useStore()',
        },
      ],
    },
    {
      title: '读取与写入 atom',
      navLabel: '读写 atom',
      description: '读、写、读写 hooks 分开使用；命令 atom 的 getter 可以读取任何关联状态。',
      entries: [
        {
          name: 'useAtomValue',
          role: '订阅读取',
          description: '订阅 atom 当前值；Promise atom 会通过 React 的 Suspense 路径读取。',
          code: 'const title = useAtomValue(titleAtom)',
        },
        {
          name: 'useAtomValueWith18',
          role: 'React 18 读取',
          description: '基于 useSyncExternalStore 的 React 18 读取实现。',
          code: 'const title = useAtomValueWith18(titleAtom)',
        },
        {
          name: 'useAtomValue17',
          role: 'React 17 读取',
          description: '供较早 React 版本使用的读取实现。',
          code: 'const title = useAtomValue17(titleAtom)',
        },
        {
          name: 'useSetAtom',
          role: '仅写入',
          description: '取得 WritableAtom 的 setter，避免订阅不需要展示的状态。',
          code: "const save = useSetAtom(saveAtom)\nsave({ name: 'Ada' })",
        },
        {
          name: 'SetAtomMethod',
          role: 'setter 类型',
          description: 'useSetAtom 的重载函数类型。',
          code: 'const setAtom: SetAtomMethod = useSetAtom',
          kind: 'type',
        },
        {
          name: 'useAtom',
          role: '读写绑定',
          description: '同时订阅值和取得 setter；返回 [value, setValue]。',
          code: 'const [count, setCount] = useAtom(countAtom)\nsetCount((prev) => prev + 1)',
        },
        {
          name: 'useAtomCallback',
          role: 'atom 回调',
          description: '创建稳定回调，在调用时获得 getter、setter 与传入参数。',
          code: 'const rename = useAtomCallback((get, set, name: string) => {\n  set(profileAtom, { ...get(profileAtom), name })\n}, [])',
        },
        {
          name: 'useAtomMethods',
          role: '命令集合',
          description: '把多个 (getter, setter, ...args) 方法绑定为组件可调用的方法。',
          code: 'const actions = useAtomMethods({\n  reset: (_get, set) => set(countAtom, 0),\n})\nactions.reset()',
        },
        {
          name: 'useAtomSync',
          role: 'Store 同步',
          description: '把一个 store 中 atom 的值同步到另一个 store。',
          code: 'useAtomSync({ atom: sourceAtom, store: sourceStore }, { atom: targetAtom, store: targetStore })',
        },
      ],
    },
    {
      title: '异步 UI 适配',
      navLabel: '异步 UI',
      description:
        '先用 atom(async (get) => ...) 或 createAsyncParamsAtom 建模异步衍生；这里仅把 Promise 映射为 UI 分支。',
      entries: [
        {
          name: 'loadable',
          role: '异步 UI 适配',
          description:
            '把 atom 值映射为 state: loading、hasData 或 hasError，供 UI 呈现，不负责业务异步衍生。',
          code: "const userViewAtom = loadable(userAtom)\nconst view = useAtomValue(userViewAtom)\nif (view.state === 'loading') return <Spinner />",
        },
        {
          name: 'isWriteAtom',
          role: '可写判断',
          description: '判断一个 atom 是否带有 write 能力。',
          code: "if (isWriteAtom(userAtom)) {\n  store.setter(userAtom, '42')\n}",
        },
        {
          name: 'useIncrementAtom',
          role: '增量写入 hook',
          description: '为 incrementAtom 返回可调用的增量写入器和清理函数。',
          code: 'const [increment, clear] = useIncrementAtom(countAtom)\nincrement((get, prev) => prev + 1)\nclear()',
        },
      ],
    },
    {
      title: '动态 atom 的组件级缓存',
      navLabel: 'Atom 缓存',
      description:
        '在 CacheProvider 内按函数引用和参数缓存结果，适合在渲染中稳定取得 family atom。',
      entries: [
        {
          name: 'CacheProvider',
          role: '缓存边界',
          description: '为 useCache 提供组件树范围内的缓存。',
          code: '<CacheProvider><TodoList /></CacheProvider>',
        },
        {
          name: 'ProviderCacheContext',
          role: '缓存 Context',
          description: 'CacheProvider 使用的公开 Context。',
          code: 'const cache = useContext(ProviderCacheContext)',
        },
        {
          name: 'CacheProviderType',
          role: '缓存类型',
          description: '缓存 Provider 的 context 值类型。',
          code: 'const cache: CacheProviderType = useCreateCache()',
          kind: 'type',
        },
        {
          name: 'useCache',
          role: '参数缓存',
          description: '按参数缓存函数返回值，常用于稳定地获取动态 atom。',
          code: "const getTodoAtom = useCache(createTodoAtom)\nconst todoAtom = getTodoAtom('t-1')",
        },
        {
          name: 'useCreateCache',
          role: '缓存创建',
          description: '创建包含 WeakMap 缓存的 Provider 值。',
          code: 'const cache = useCreateCache()',
        },
      ],
    },
  ],
}
