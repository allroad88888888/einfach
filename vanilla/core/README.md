# @einfach/core

轻量级、受 Jotai 启发的 atom 状态管理核心库（框架无关）。

## 安装

```bash
npm install @einfach/core
# or
pnpm add @einfach/core
```

## 基本用法

### 创建 Atom

```ts
import { atom, createStore } from '@einfach/core'

// 基础 atom
const countAtom = atom(0)

// 派生 atom（只读）
const doubleAtom = atom((get) => get(countAtom) * 2)

// 可写派生 atom
const incrementAtom = atom(
  (get) => get(countAtom),
  (get, set, step: number) => set(countAtom, get(countAtom) + step)
)
```

### 使用 Store

```ts
const store = createStore()

// 读取
store.getter(countAtom) // 0

// 写入
store.setter(countAtom, 1)
store.getter(countAtom) // 1

// 订阅
const unsub = store.sub(countAtom, () => {
  console.log('count changed:', store.getter(countAtom))
})

// 取消订阅
unsub()

// 清空 store
store.clear()
```

### 异步 Atom

```ts
const userAtom = atom(async (get) => {
  const id = get(userIdAtom)
  const res = await fetch(`/api/users/${id}`)
  return res.json()
})
```

## API

### 核心

| API | 说明 |
|-----|------|
| `atom(initialValue)` | 创建基础 atom |
| `atom(readFn)` | 创建只读派生 atom |
| `atom(readFn, writeFn)` | 创建可写派生 atom |
| `createStore()` | 创建 store 实例 |
| `getDefaultStore()` | 获取默认 store 单例 |

### Store 方法

| 方法 | 说明 |
|------|------|
| `store.getter(atom)` | 读取 atom 值 |
| `store.setter(atom, ...args)` | 写入 atom 值 |
| `store.sub(atom, listener)` | 订阅 atom 变化，返回取消订阅函数 |
| `store.clear()` | 清空 store |

### 工具函数

| API | 说明 |
|-----|------|
| `selectAtom(atom, selectorFn, equalFn?)` | 创建带选择器的派生 atom |
| `atomWithCompare(initialValue, equalFn)` | 创建带自定义比较的 atom |
| `atomWithRefresh(readFn)` | 创建可刷新的 atom |
| `atomWithLazyRefresh(readFn)` | 创建懒加载可刷新 atom |
| `createAsyncParamsAtom(asyncFn)` | 创建接收参数的异步 atom |
| `createUndoRedo(atom)` | 创建撤销/重做系统 |
| `incrementAtom(atom, derivations)` | 创建带派生计算的 atom |
| `createCacheStom(atomFn, options?)` | 创建 LRU 缓存 atom 工厂 |
| `memo(weakKey, fn)` | 基于 WeakKey 缓存值 |

## 许可证

MIT
