import type { ApiPackage } from './types'

export const solidApiPackage: ApiPackage = {
  id: 'solid',
  label: 'Solid',
  packageName: '@einfach/solid',
  summary: 'Solid 的 atom 绑定与异步 UI 适配；同时完整再导出 @einfach/core。',
  reexportsCore: true,
  sections: [
    {
      title: 'Solid Store 边界',
      navLabel: 'Store 边界',
      description:
        'Provider 把 store 放进 Solid Context；子组件按需直取 atom，不经 props 传递共享状态。',
      entries: [
        {
          name: 'Provider',
          role: 'Store Provider',
          description: '为 Solid 子树提供 store，未传时使用 defaultStore。',
          code: 'const store = createStore()\n<Provider store={store}><App /></Provider>',
        },
        {
          name: 'ProviderProps',
          role: 'Provider 属性',
          description: 'Provider 的 store 与 children 属性类型。',
          code: 'const props: ProviderProps = { store, children: <App /> }',
          kind: 'type',
        },
        {
          name: 'defaultStore',
          role: '默认 Store',
          description: 'Solid 绑定使用的默认 Store 实例。',
          code: 'const value = defaultStore.getter(titleAtom)',
        },
        {
          name: 'StoreContext',
          role: 'Store Context',
          description: 'Solid Store Context。',
          code: 'const context = useContext(StoreContext)',
        },
        {
          name: 'StoreContextValue',
          role: 'Context 类型',
          description: 'StoreContext 的值类型。',
          code: 'const context: StoreContextValue = { store }',
          kind: 'type',
        },
        {
          name: 'useStoreContext',
          role: '读取 Context',
          description: '读取当前 Solid Store Context。',
          code: 'const context = useStoreContext()',
        },
        {
          name: 'HookOption',
          role: 'Hook 选项',
          description: '为 Solid hooks 指定可选 store。',
          code: 'const options: HookOption = { store }',
          kind: 'type',
        },
        {
          name: 'useStore',
          role: '读取 Store',
          description: '取得显式 store、Context store 或 defaultStore。',
          code: 'const store = useStore()',
        },
      ],
    },
    {
      title: '读取与写入 atom',
      navLabel: '读写 atom',
      description: 'Solid 读取 API 返回 accessor，写入函数可直接操作任何可写 atom。',
      entries: [
        {
          name: 'useAtomValue',
          role: '订阅读取',
          description: '订阅 atom 并返回 Solid accessor。',
          code: 'const title = useAtomValue(titleAtom)\nconsole.log(title())',
        },
        {
          name: 'useSetAtom',
          role: '仅写入',
          description: '取得 WritableAtom 的 setter。',
          code: "const save = useSetAtom(saveAtom)\nsave({ name: 'Ada' })",
        },
        {
          name: 'useAtom',
          role: '读写绑定',
          description: '返回 { rawValue, setValue }；rawValue 是 accessor。',
          code: 'const count = useAtom(countAtom)\ncount.setValue((prev) => prev + 1)\nconsole.log(count.rawValue())',
        },
      ],
    },
    {
      title: '异步 UI 适配',
      navLabel: '异步 UI',
      description:
        '异步衍生仍用 Core atom 表达；loadable 和 useLoadable 只帮助视图分支 loading、data、error。',
      entries: [
        {
          name: 'loadable',
          role: '异步 UI 适配',
          description: '把 Promise atom 映射为带 status、loading、data、error 的视图 atom。',
          code: 'const userViewAtom = loadable(userAtom)\nconst view = useAtomValue(userViewAtom)\nif (view().loading) return <Spinner />',
        },
        {
          name: 'useLoadable',
          role: '读取 UI 适配',
          description: '读取 loadable atom 并返回其视图状态 accessor。',
          code: 'const view = useLoadable(userViewAtom)\nreturn <Show when={!view().loading}>{view().data?.name}</Show>',
        },
        {
          name: 'LoadableStatus',
          role: '视图状态类型',
          description: 'loading、hasData、hasError 的状态联合。',
          code: "const status: LoadableStatus = 'loading'",
          kind: 'type',
        },
        {
          name: 'LoadableValue',
          role: '视图值类型',
          description: 'loadable 输出的 status、loading、data、error 结构。',
          code: "const view: LoadableValue<User> = { status: 'loading', loading: true }",
          kind: 'type',
        },
      ],
    },
  ],
}
