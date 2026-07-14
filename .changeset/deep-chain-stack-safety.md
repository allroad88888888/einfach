---
'@einfach/core': patch
---

修复深层嵌套依赖链爆栈：求值改为深度受限递归（250 层内与旧行为一致）+ 超限后切换显式栈迭代，set 传播完全交由 flushPending 循环推进，任意深度依赖链不再 RangeError。flushPending 改为先收敛整张依赖图再统一通知，listener 中读取下游 atom 一定拿到新值。循环依赖现在报明确的 Circular dependency 错误。
