# @einfach/utils

Einfach 工具函数库，提供深拷贝、深比较、路径操作和函数记忆化等工具。

## 安装

```bash
npm install @einfach/utils
# or
pnpm add @einfach/utils
```

## 使用

### 路径操作

```ts
import { easyGet, easySetIn, easyHas } from '@einfach/utils'

const obj = { a: { b: { c: 1 } } }

easyGet(obj, 'a.b.c')        // 1
easyGet(obj, ['a', 'b', 'c']) // 1
easyHas(obj, 'a.b.c')        // true

const newObj = easySetIn(obj, 'a.b.c', 2)
// { a: { b: { c: 2 } } }  — 返回新对象，不修改原对象
```

### 深拷贝与深比较

```ts
import { easyClone, easyEqual } from '@einfach/utils'

const clone = easyClone({ a: [1, 2], b: new Map() })
easyEqual({ a: 1 }, { a: 1 }) // true
```

### 函数记忆化

```ts
import { memoizeFn, memoizeOneArg } from '@einfach/utils'

const expensive = memoizeFn((a: number, b: number) => {
  // 耗时计算...
  return a + b
})

// 单参数 WeakMap 记忆化
const getInfo = memoizeOneArg((user: User) => computeInfo(user))
```

## API

### 路径操作

| API | 说明 |
|-----|------|
| `easyGet(obj, path)` | 按路径获取嵌套值 |
| `easySetIn(obj, path, value)` | 按路径设置嵌套值（返回新对象） |
| `easyHas(obj, path)` | 检查嵌套路径是否存在 |
| `exprPath(pathStr)` | 将路径字符串解析为数组 |

### 深操作

| API | 说明 |
|-----|------|
| `easyClone(value)` | 深拷贝（支持 Object/Array/Set/Map） |
| `easyEqual(a, b)` | 深度相等比较 |

### 记忆化

| API | 说明 |
|-----|------|
| `memoizeFn(fn, equalFn?)` | 函数记忆化，支持自定义参数比较 |
| `memoizeOneArg(fn)` | 单参数 WeakMap 记忆化 |

## 许可证

MIT
