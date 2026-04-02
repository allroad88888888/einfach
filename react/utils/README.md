# @einfach/react-utils

Einfach React 工具 hooks 库，提供通用 React hooks 和 atom 路径操作工具。

## 安装

```bash
npm install @einfach/react-utils
# or
pnpm add @einfach/react-utils
```

## API

### 通用 Hooks

| Hook | 说明 |
|------|------|
| `useInit(fn, deps?)` | 初始化执行，deps 变化时重新执行 |
| `useMethods(methodsObj)` | 记忆化方法对象 |
| `useDoRender()` | 获取强制重渲染函数 |
| `useFetch(fetchFn, options?)` | 数据获取 hook，支持自动/手动模式 |
| `useOnce(fn)` | 仅执行一次并缓存结果 |
| `useReRef(props)` | 创建 partial props 的 ref |
| `useDepAndFormateFn(fn, deps)` | 依赖变化时格式化函数 |

### Atom 工具

| API | 说明 |
|-----|------|
| `selectEasyAtom(atom, path)` | 按路径创建派生 atom |
| `useEasySelectAtomValue(atom, path)` | 按路径读取 atom 嵌套值 |
| `useEasySetAtom(atom, path)` | 按路径设置 atom 嵌套值 |
| `syncAtom(atom, storeA, storeB)` | 在两个 store 间同步 atom |
| `useSyncAtom(atom, storeA, storeB)` | 同步 atom（hook 版本） |

### React 工具

| API | 说明 |
|-----|------|
| `htmlToHump(str)` | 将 kebab-case 转为 camelCase |

## 使用示例

### 路径操作

```tsx
import { atom } from '@einfach/react'
import { useEasySelectAtomValue, useEasySetAtom } from '@einfach/react-utils'

const formAtom = atom({ user: { name: 'Alice', age: 20 } })

function UserName() {
  const name = useEasySelectAtomValue(formAtom, 'user.name')
  const setForm = useEasySetAtom(formAtom, 'user.name')

  return <input value={name} onChange={(e) => setForm(e.target.value)} />
}
```

### 数据获取

```tsx
import { useFetch } from '@einfach/react-utils'

function UserList() {
  const { data, loading, run } = useFetch(() => fetch('/api/users').then(r => r.json()))

  if (loading) return <p>加载中...</p>
  return (
    <div>
      {data?.map(user => <p key={user.id}>{user.name}</p>)}
      <button onClick={run}>刷新</button>
    </div>
  )
}
```

## 许可证

MIT
