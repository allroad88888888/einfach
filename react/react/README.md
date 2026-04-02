# @einfach/react

Einfach 状态管理库的 React 绑定，提供 hooks 驱动的 atom 状态管理。

## 安装

```bash
npm install @einfach/react
# or
pnpm add @einfach/react
```

## 快速上手

```tsx
import { atom, useAtom, useAtomValue, useSetAtom, Provider } from '@einfach/react'

const countAtom = atom(0)
const doubleAtom = atom((get) => get(countAtom) * 2)

function Counter() {
  const [count, setCount] = useAtom(countAtom)
  const double = useAtomValue(doubleAtom)

  return (
    <div>
      <p>Count: {count}, Double: {double}</p>
      <button onClick={() => setCount((c) => c + 1)}>+1</button>
    </div>
  )
}

function App() {
  return (
    <Provider>
      <Counter />
    </Provider>
  )
}
```

## API

### 组件

| API | 说明 |
|-----|------|
| `Provider` | Store 上下文提供者，可嵌套创建独立 store |

### Hooks

| Hook | 说明 |
|------|------|
| `useAtom(atom)` | 订阅 atom，返回 `[value, setter]` |
| `useAtomValue(atom)` | 订阅 atom，返回只读值 |
| `useSetAtom(atom)` | 获取 atom 的 setter 函数，不订阅变化 |
| `useStore(options?)` | 获取当前 store 实例 |
| `useAtomMethods(atom)` | 创建绑定 getter/setter 的方法对象 |
| `useAtomCallback(callback)` | 创建可访问 getter/setter 的记忆化回调 |
| `useAtomSync(atom)` | 在两个 store 间同步 atom |
| `useIncrementAtom(atom)` | 使用 incrementAtom 并自动清理 |

### 工具函数

| API | 说明 |
|-----|------|
| `loadable(atom)` | 将异步 atom 转为 `{ state, data, error }` |

### 来自 @einfach/core

本包重新导出了 `@einfach/core` 的所有 API，包括 `atom`、`createStore`、`getDefaultStore` 等。

## 异步数据

```tsx
const userAtom = atom(async (get) => {
  const res = await fetch('/api/user')
  return res.json()
})

const userLoadableAtom = loadable(userAtom)

function User() {
  const { state, data, error } = useAtomValue(userLoadableAtom)

  if (state === 'pending') return <p>加载中...</p>
  if (state === 'rejected') return <p>错误: {error}</p>
  return <p>用户: {data.name}</p>
}
```

## 许可证

MIT
