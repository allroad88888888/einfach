# Agent Orchestration

多 Agent 并发编排系统 —— `@einfach/spreadsheet-ui-core` 的 agent 协调模块。

## 协议文档

参见 [`docs/AGENT_ORCHESTRATION.md`](../../docs/AGENT_ORCHESTRATION.md)

## 状态分类

### Source Atoms

| Atom | 类型 | 说明 | Cap |
|---|---|---|---|
| `agentRegistryAtom` | `Map<string, AgentRecord>` | Agent 注册表 | 20 |
| `agentFileLockAtom` | `FileLock[]` | 活跃文件锁 | ~200 |
| `agentResultMapAtom` | `Map<string, AgentResult>` | 结果聚合树 | 20 |

### Derived

| 函数 | 说明 |
|---|---|
| `getAgentStatusAtom(getter, agentId)` | 查询 agent 状态 |
| `checkLockConflicts(getter, paths)` | 检测锁冲突 |

### Command Atoms

| Atom | 说明 |
|---|---|
| `registerAgentAtom` | 注册 agent（idle） |
| `deregisterAgentAtom` | 注销 agent + 释放锁 |
| `acquireLocksAtom` | 获取文件排他锁（全或无） |
| `releaseLocksAtom` | 释放 agent 所有锁 |
| `assignTaskAtom` | 分配任务（idle → discovering） |
| `completeTaskAtom` | 完成任务（working → reviewing） |
| `approveResultAtom` | 审批结果（reviewing → done/working） |
| `spawnAgentAtom` | Spawn 子 agent（含前置条件检查） |

## 约束

- 所有 atom 使用 `spreadsheet.agentOrchestration.*` debugLabel
- 不依赖 Solid/React/DOM/Worker/WASM
- 不引入外部状态库
- 无 per-cell/per-row/per-column atom
- 全部 bounded

## 测试

```bash
npx jest vanilla/spreadsheet-ui-core/test/agent-orchestration.test.ts --runInBand
```
