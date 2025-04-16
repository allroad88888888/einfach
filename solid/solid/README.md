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

## API

### Hooks

- `useAtom(atom)` - 订阅 atom 并获取读写能力
- `useAtomValue(atom)` - 订阅 atom 并获取只读值
- `useSetAtom(atom)` - 获取 atom 的设置函数，不订阅变化
- `useStore(options?)` - 获取当前 store 实例

### 工具函数

- `createUndoRedo(atom, options?)` - 为 atom 创建撤销/重做功能
- `createSelector(atom, selectorFn)` - 创建一个选择器 atom
- `useSelector(atom, selectorFn)` - 从 atom 中选择部分状态
- `loadable(asyncFn)` - 从异步函数创建 loadable atom

## 许可证

MIT
