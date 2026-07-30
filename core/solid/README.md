# @einfach/solid

Einfach 状态管理库的 Solid.js 绑定。

## 安装

```bash
npm install @einfach/solid
# 或
yarn add @einfach/solid
# 或
pnpm add @einfach/solid
```

## 基本用法

```jsx
import { atom } from '@einfach/core';
import { useAtom } from '@einfach/solid';

// 创建一个 atom
const counterAtom = atom(0);

function Counter() {
  const { value, setValue } = useAtom(counterAtom);

  return (
    <div>
      <p>Count: {value()}</p>
      <button onClick={() => setValue(c => c + 1)}>增加</button>
      <button onClick={() => setValue(c => c - 1)}>减少</button>
    </div>
  );
}
```

## Solid 状态边界

- 同一 Provider/store 边界内，组件直接订阅所需 atom；不要为了传递共享状态建立 props 链。
- 跨 atom 更新推荐使用 `atom(null, (getter, setter, ...args) => {})` 定义命令 atom。
- 业务异步用 `atom(async (getter) => ...)` 建模；`loadable` 只负责把已有 Promise 映射为 UI 状态。

## API

### Hooks

- `useAtom(atom)` - 订阅 atom 并获取读写能力
- `useAtomValue(atom)` - 订阅 atom 并获取只读值
- `useSetAtom(atom)` - 获取 atom 的设置函数，不订阅变化
- `useStore(options?)` - 获取当前 store 实例

### 工具函数

- `createHistory(options?)` - 事务日志式撤销/重做（由 `@einfach/core` 导出）
- `createSelector(atom, selectorFn)` - 创建一个选择器 atom
- `useSelector(atom, selectorFn)` - 从 atom 中选择部分状态
- `loadable(asyncDerivedAtom)` - 把已有异步 derived atom 映射为 UI 状态

## 许可证

MIT
