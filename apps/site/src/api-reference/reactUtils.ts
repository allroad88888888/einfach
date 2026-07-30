import type { ApiPackage } from './types'

export const reactUtilsApiPackage: ApiPackage = {
  id: 'react-utils',
  label: 'React Utils',
  packageName: '@einfach/react-utils',
  summary: 'React 辅助 hooks、路径化 atom 读写和跨 Store 同步工具。',
  sections: [
    {
      title: '通用 React hooks',
      navLabel: 'React hooks',
      description: '面向组件初始化、方法稳定性、请求和渲染控制的辅助能力。',
      entries: [
        {
          name: 'useInit',
          role: '依赖初始化',
          description: '在依赖改变时执行工厂，并缓存本轮结果。',
          code: 'const service = useInit(() => createService(id), [id])',
        },
        {
          name: 'useMethods',
          role: '方法稳定化',
          description: '返回可调用的 methods 对象，并在调用时使用最新方法定义。',
          code: 'const actions = useMethods({ save: () => submit() })\nactions.save()',
        },
        {
          name: 'useDoRender',
          role: '强制渲染',
          description: '返回触发当前组件重新渲染的函数。',
          code: 'const rerender = useDoRender()\nrerender()',
        },
        {
          name: 'useFetch',
          role: '请求状态',
          description: '包装 Promise fetcher，返回 run、data 和 loading。',
          code: "const { run, data, loading } = useFetch({ fetcher: fetchUser, auto: false })\nrun('42')",
        },
        {
          name: 'useBatchState',
          role: '同步批处理',
          description: '返回 React DOM 的 flushSync。',
          code: 'const flush = useBatchState()\nflush(() => update())',
        },
        {
          name: 'useBatchEffectState',
          role: '效果批处理',
          description: '返回在下一次布局效果中执行回调的函数。',
          code: 'const batch = useBatchEffectState()\nbatch(() => update())',
        },
        {
          name: 'useBatchClickState',
          role: '点击批处理',
          description: '返回 cb 与隐藏 portal；把回调放入 click 事件边界执行。',
          code: 'const { cb, vDom } = useBatchClickState()\ncb(() => update())\nreturn <>{vDom}</>',
        },
        {
          name: 'useReRef',
          role: '可变 Ref',
          description: '创建保存对象引用的 ref，并以传入属性更新 current。',
          code: 'const ref = useReRef({ latest: value })',
        },
        {
          name: 'useOnce',
          role: '一次初始化',
          description: '在组件生命周期内只执行一次工厂并返回结果。',
          code: 'const service = useOnce(() => createService())',
        },
        {
          name: 'useDepAndFormateFn',
          role: '函数包装缓存',
          description: '当原函数引用改变时重新调用 formatFn 包装它。',
          code: 'const debounced = useDepAndFormateFn(save, (fn) => debounce(fn, 200))',
        },
      ],
    },
    {
      title: '路径化 atom 读写',
      navLabel: 'Atom 读写',
      description: '在保留源 atom 的前提下按路径选择或更新局部字段。',
      entries: [
        {
          name: 'selectEasyAtom',
          role: '路径派生',
          description: '从 AtomEntity 按 NamePath 创建选择 atom，可提供比较函数。',
          code: "const nameAtom = selectEasyAtom(profileAtom, 'account.name')",
        },
        {
          name: 'useEasySelectAtomValue',
          role: '路径订阅',
          description: '订阅 AtomEntity 的一个路径切片。',
          code: "const name = useEasySelectAtomValue(profileAtom, 'account.name')",
        },
        {
          name: 'useEasySetAtom',
          role: '路径写入',
          description: '取得支持完整值、更新函数或 (path, value) 的 setter。',
          code: "const setProfile = useEasySetAtom(profileAtom)\nsetProfile('account.name', 'Ada')",
        },
        {
          name: 'SetAtomMethod',
          role: '路径 setter 类型',
          description: 'useEasySetAtom 返回函数的重载类型。',
          code: 'const setProfile: SetAtomMethod<Profile, string> = useEasySetAtom(profileAtom)',
          kind: 'type',
        },
      ],
    },
    {
      title: '跨 Store 同步',
      navLabel: 'Store 同步',
      description: '把一个 store 的 atom 变化同步到另一 store，并管理订阅生命周期。',
      entries: [
        {
          name: 'syncAtom',
          role: '同步函数',
          description: '立即同步一次并订阅源 store；返回 atom 与取消函数。',
          code: 'const [syncedAtom, cancel] = syncAtom(profileAtom, sourceStore, targetStore)\ncancel()',
        },
        {
          name: 'useSyncAtom',
          role: '同步 hook',
          description: '在组件内创建同步并在卸载时取消订阅。',
          code: 'const syncedAtom = useSyncAtom(profileAtom, sourceStore, targetStore)',
        },
      ],
    },
    {
      title: 'React 标记转换',
      navLabel: '标记转换',
      description: '独立的字符串辅助函数。',
      entries: [
        {
          name: 'htmlToHump',
          role: '属性名转换',
          description: '把 HTML 属性名转换为 React 风格的 hump 名称。',
          code: "const propName = htmlToHump('class-name')",
        },
      ],
    },
  ],
}
