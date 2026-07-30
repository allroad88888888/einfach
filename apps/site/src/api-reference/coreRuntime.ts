import type { ApiPackage } from './types'

export const coreRuntimeSections: ApiPackage['sections'] = [
  {
    title: '异步衍生、源状态与命令',
    navLabel: '异步与命令',
    description: '异步 read、同步派生和写入命令都由同一个 atom API 表达；共享事实保持小而独立。',
    entries: [
      {
        name: 'atom',
        role: 'atom 工厂',
        description: '创建源 atom、同步或异步派生 atom，或带命令式 write 的 atom。',
        code: "const requestAtom = atom({ userId: '42' })\nconst userAtom = atom(async (get) => fetchUser(get(requestAtom).userId))\nconst loadUserAtom = atom(null, (get, set, userId: string) => {\n  set(requestAtom, { userId })\n})",
      },
      {
        name: 'isSourceAtom',
        role: 'atom 判断',
        description: '判断一个 atom 是否为由初始值创建的源 atom。',
        code: "if (isSourceAtom(profileAtom)) {\n  store.setter(profileAtom, { name: 'Grace' })\n}",
      },
      {
        name: 'SYNTHESIZED_WRITE',
        role: '高级标记',
        description: '标记由 atom 初始值合成的默认写入函数；通常无需在业务代码中使用。',
        code: 'if (profileAtom.write === SYNTHESIZED_WRITE) {\n  // 这是源 atom 的默认写入能力\n}',
      },
    ],
  },
  {
    title: '异步参数与 Promise 工具',
    navLabel: '异步参数',
    description: '参数化异步任务和 Promise 状态辅助；异步 read 本身由上方的 atom API 直接表达。',
    entries: [
      {
        name: 'createAsyncParamsAtom',
        role: '参数化异步衍生',
        description: '把接收参数的 Promise 函数包装成可写 atom；写入参数即可触发下一次异步计算。',
        code: "const userAtom = createAsyncParamsAtom((id: string) => fetchUser(id))\nstore.setter(userAtom, '42')\nconst user = store.getter(userAtom)",
      },
      {
        name: 'isPromiseLike',
        role: 'Promise 判断',
        description: '判断 atom 读出的值是否为 Promise-like 对象。',
        code: 'const value = store.getter(userAtom)\nif (isPromiseLike(value)) await value',
      },
      {
        name: 'isContinuablePromise',
        role: 'Promise 判断',
        description: '判断增强状态 Promise 是否带有可继续读取的标记。',
        code: 'if (isContinuablePromise(store.getter(userAtom))) {\n  // 可读取 status / value / reason\n}',
      },
      {
        name: 'CONTINUE_PROMISE_TAG',
        role: '高级标记',
        description: '增强 Promise 使用的内部 Symbol 标记；通常只在基础设施适配中使用。',
        code: 'const tagged = promise[CONTINUE_PROMISE_TAG]',
      },
    ],
  },
  {
    title: 'Store：框架外读取、写入与订阅',
    navLabel: 'Store',
    description: '同一个 atom 可以被任意组件、服务或测试直接读取；组件层级不再承担状态传递。',
    entries: [
      {
        name: 'createStore',
        role: 'Store 创建',
        description: '创建独立 store，适用于测试、服务层或自定义 Provider 边界。',
        code: "const store = createStore()\nstore.setter(profileAtom, { name: 'Ada' })\nconst profile = store.getter(profileAtom)",
      },
      {
        name: 'getDefaultStore',
        role: '默认 Store',
        description: '取得默认 store；未提供 Provider 的绑定会回退到它。',
        code: 'const store = getDefaultStore()\nconst name = store.getter(labelAtom)',
      },
      {
        name: 'storeAtom',
        role: 'Store 引用',
        description: '公开的 Store atom，可在需要把 store 作为依赖建模时使用。',
        code: 'const activeStore = store.getter(storeAtom)',
      },
    ],
  },
  {
    title: '选择、刷新与粒度控制',
    navLabel: '选择与刷新',
    description: '把状态拆成事实和局部投影，让新增或修改需求只影响短小的依赖链。',
    entries: [
      {
        name: 'selectAtom',
        role: '局部派生',
        description: '从一个 atom 选择切片，订阅者只依赖所需部分。',
        code: 'const nameAtom = selectAtom(profileAtom, (profile) => profile.name)',
      },
      {
        name: 'atomWithCompare',
        role: '比较写入',
        description: '只有比较函数判定为变化时，才更新源 atom。',
        code: "const queryAtom = atomWithCompare('', (prev, next) => prev === next)",
      },
      {
        name: 'atomWithRefresh',
        role: '手动刷新',
        description: '给 read atom 加入无参数刷新能力；有 write 时仍可转交参数。',
        code: 'const clockAtom = atomWithRefresh(() => Date.now())\nstore.setter(clockAtom)',
      },
      {
        name: 'atomWithLazyRefresh',
        role: '惰性刷新',
        description: '首次读取前保持未初始化，调用无参数写入后才刷新 read 结果。',
        code: 'const reportAtom = atomWithLazyRefresh((get) => get(sourceAtom))\nstore.setter(reportAtom)',
      },
      {
        name: 'incrementAtom',
        role: '增量写入',
        description: '创建可接受值或基于 getter、前值的更新函数的 atom。',
        code: 'const countAtom = incrementAtom(0)\nstore.setter(countAtom, (get, prev) => prev + 1)',
      },
      {
        name: 'uninitialized',
        role: '未初始化标记',
        description: '用于显式区分“尚未设置”与合法的 undefined 值。',
        code: 'const selectionAtom = atom<typeof uninitialized | string>(uninitialized)',
      },
    ],
  },
  {
    title: '动态 atom 缓存',
    navLabel: 'Atom 缓存',
    description: '按 id 或参数生成的细粒度 atom 可以复用实例，并限制缓存规模。',
    entries: [
      {
        name: 'memo',
        role: '弱引用缓存',
        description: '按 WeakKey 缓存工厂结果，常用于稳定的派生 atom 实例。',
        code: "const getNameAtom = (userAtom: object) => memo(() => atom('Ada'), userAtom)",
      },
      {
        name: 'createCacheStom',
        role: '参数缓存',
        description: '把 atom 工厂变成按参数缓存的工厂，可设置 LRU 上限。',
        code: "const getUserAtom = createCacheStom({\n  createAtom: (id: string) => atom({ id }),\n  debuggerKey: 'user',\n  maxSize: 200,\n})",
      },
      {
        name: 'createCacheStomById',
        role: 'id atom 缓存',
        description: '为单个 string id 创建并缓存 atom。',
        code: "const getRowAtom = createCacheStomById({\n  defaultState: { selected: false },\n  debuggerKey: 'row',\n})\nconst rowAtom = getRowAtom('r-1')",
      },
      {
        name: 'createGetFamilyAtomById',
        role: 'family atom',
        description: '按 id 取得同一实例的 family atom；可用 defaultState 或 createAtom 定义。',
        code: "const getTodoAtom = createGetFamilyAtomById({\n  defaultState: { done: false },\n  debuggerKey: 'todo',\n})\nconst todoAtom = getTodoAtom('t-1')",
      },
    ],
  },
  {
    title: '订阅与历史',
    navLabel: '订阅与历史',
    description: '基础订阅和显式事务历史能力，适合调试、撤销/重做等基础设施。',
    entries: [
      {
        name: 'watchAtom',
        role: '全局观察',
        description: '把 atom 加入全局观察集合，供 subscribe 统一接收变更。',
        code: 'watchAtom(profileAtom)',
      },
      {
        name: 'subscribe',
        role: '全局订阅',
        description: '订阅 watchAtom 注册的 atom 变更；返回取消订阅函数。',
        code: 'const unsubscribe = subscribe((atoms) => console.log(atoms))\nunsubscribe()',
      },
      {
        name: 'createHistory',
        role: '撤销 / 重做',
        description: '创建显式事务日志历史；调用方在 transaction 中记录可回放操作。',
        code: "const history = createHistory(store)\nhistory.transaction('编辑标题', () => {\n  history.record({ key: 'title', before: 'A', after: 'B' })\n})",
      },
      {
        name: 'DEFAULT_HISTORY_CAP',
        role: '历史默认值',
        description: 'createHistory 未传 cap 时使用的默认历史条数。',
        code: 'const history = createHistory(store, { cap: DEFAULT_HISTORY_CAP })',
      },
    ],
  },
]
