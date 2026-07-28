---
'@einfach/core': minor
---

**破坏性变更**：移除 `createUndoRedo` 与 `openUndoRedoAtom`，由事务日志式的 `createHistory` 取代。旧实现按快照记录整棵状态树，新实现只记录 `HistoryOp` 序列，并提供 `HistoryApplier`（自定义应用方式）、`HistoryPersistPort`（持久化）、`DEFAULT_HISTORY_CAP = 100` 的有界栈。迁移需按新 API 重写调用点，二者不兼容。

新增 `isSourceAtom()` 与 `SYNTHESIZED_WRITE` 标记：`atom(initialValue)` 合成的 write 现在带标记，使「源子 atom」可与只读派生、可写派生、命令 atom（`atom(null, fn)`）在运行时区分开 —— 撤销/重做与持久化回放需要这个判定才能安全地写回历史旧值。

深链求值改为 `READ_RECURSION_BUDGET = 256` 的预算内递归 + 超预算后的 FAULT 哨兵帧循环，替换 0.2.19 中基于缺失依赖异常 + 显式栈的实现。两者对外保证一致（任意深度不再 RangeError、环报明确错误、等值传播剪枝），已用 0.2.19 的 `deepNesting.test.ts` 全套 19 个用例回归验证。三处可观察差异：超预算深链上 read fn 可能执行多次（副作用须自行幂等）、`options.getter` 的函数身份只在单轮 read 内稳定、`runDependenciesChange` 的反向依赖集合按压栈时刻快照而非实时遍历。

`createCacheStom` / `createCacheStomById` 的泛型参数由 `AtomEntity` 更名为 `TAtom`，避免与同名导出类型遮蔽（仅类型参数名，不影响调用方）。
