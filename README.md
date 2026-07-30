# Einfach

TypeScript 优先的 atom 状态管理库。用小颗粒 source atom 表达事实，用 derived atom 表达规则；
`atom(async (get) => ...)` 直接表达异步衍生，命令 atom 负责跨 atom 写入。提供框架无关的核心，
以及 React 和 Solid.js 绑定。

> "einfach" 在德语中意为"简单"

## 特性

- 基于 atom 的响应式状态管理
- 框架无关的核心引擎
- React hooks 绑定
- Solid.js 绑定
- 表单处理（React / Solid.js）
- TypeScript 优先
- Tree-shakeable（`sideEffects: false`）

## 包

| 包                                         | 版本                                                      | 说明                                 |
| ------------------------------------------ | --------------------------------------------------------- | ------------------------------------ |
| [@einfach/core](./core/core)               | ![npm](https://img.shields.io/npm/v/@einfach/core)        | 核心 atom 引擎（框架无关）           |
| [@einfach/utils](./core/utils)             | ![npm](https://img.shields.io/npm/v/@einfach/utils)       | 工具函数（深拷贝、路径操作、记忆化） |
| [@einfach/react](./core/react)             | ![npm](https://img.shields.io/npm/v/@einfach/react)       | React hooks 绑定                     |
| [@einfach/react-utils](./core/react-utils) | ![npm](https://img.shields.io/npm/v/@einfach/react-utils) | React 工具 hooks                     |
| [@einfach/react-form](./core/react-form)   | ![npm](https://img.shields.io/npm/v/@einfach/react-form)  | React 表单处理                       |
| [@einfach/solid](./core/solid)             | ![npm](https://img.shields.io/npm/v/@einfach/solid)       | Solid.js 绑定                        |
| [@einfach/solid-form](./core/solid-form)   | ![npm](https://img.shields.io/npm/v/@einfach/solid-form)  | Solid.js 表单处理                    |

## 文档与演示站

官网以真实 `@einfach/react` atom 驱动交互演示，并提供核心包的 API 导览。它位于
[`apps/site`](./apps/site)，可在本地启动：

```bash
pnpm docs:dev
```

构建静态产物：

```bash
pnpm docs:build
```

给编码 Agent 的简明状态建模规则见 [AI Guide](./docs/AI_GUIDE.md)；站点同时暴露
[`/llms.txt`](./apps/site/public/llms.txt)，供文档工具发现正确入口。

## 快速上手

### React

```bash
npm install @einfach/react
```

```tsx
import { atom, useAtom, Provider } from '@einfach/react'

const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom)
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>
}

function App() {
  return (
    <Provider>
      <Counter />
    </Provider>
  )
}
```

### Solid.js

```bash
npm install @einfach/solid
```

```tsx
import { atom } from '@einfach/core'
import { useAtom } from '@einfach/solid'

const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom)
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count()}</button>
}
```

### 仅核心（无框架）

```bash
npm install @einfach/core
```

```ts
import { atom, createStore } from '@einfach/core'

const countAtom = atom(0)
const store = createStore()

store.sub(countAtom, () => {
  console.log('count:', store.getter(countAtom))
})

store.setter(countAtom, 1) // 输出: count: 1
```

## 开发

```bash
git clone https://github.com/allroad88888888/einfach.git
cd einfach
pnpm install
npm run build
npm test
```

## 贡献

参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
