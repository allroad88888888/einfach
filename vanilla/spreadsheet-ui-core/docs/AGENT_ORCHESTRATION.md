# Agent Orchestration Protocol

多 Agent 并发编排协议 —— 层级化 AI 编码 agent 的 spawn/join/锁/聚合规范。

**状态**: 已设计，待实现核心 atoms 和模板。

## 1. 动机

`AGENT_COLLABORATION.md` 定义了 CC + Codex 双 agent 手动看板模式，在文件边界隔离下工作良好。随着项目规模增长（45+ src 模块、90+ 测试文件），两个 agent 的吞吐量成为瓶颈。

本协议将双 agent 模式推广为**层级化 N-agent 并发系统**，同时保留所有现有约束（框架无关、atom 状态管理、文件边界隔离）。

## 2. 层级 Agent 模型

### 2.1 Agent 树

```
                    ┌──────────────┐
                    │  Root Agent  │  (e.g., orchestrator)
                    │  id: "root"  │
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌─────────┐  ┌─────────┐  ┌─────────┐
        │ Agent A │  │ Agent B │  │ Agent C │   ← parent agents
        │ parent: │  │ parent: │  │ parent: │
        │  root   │  │  root   │  │  root   │
        └────┬────┘  └────┬────┘  └─────────┘
        ┌────┼────┐       │
        ▼    ▼    ▼       ▼
      [A1] [A2] [A3]   [B1]                       ← leaf agents
```

### 2.2 深度与并发限制

| 参数 | 值 | 说明 |
|---|---|---|
| MAX_DEPTH | 3 | root → parent → leaf，不允许 4 层 |
| MAX_CHILDREN_PER_PARENT | 5 | 一个 agent 最多同时 spawn 5 个子 agent |
| MAX_CHILDREN_PER_LEAF | 3 | leaf agent spawn 的孙 agent 上限更紧 |
| MAX_TOTAL_AGENTS | 20 | 整个 agent 树中活跃 agent 总数上限 |

超过限制的 spawn 请求被拒绝，返回错误并记录。

### 2.3 Agent 身份

```ts
interface AgentIdentity {
  /** 树内唯一 id，格式: {parentId}:{role} 或 "root" */
  agentId: string
  /** 父 agent 的 id，"root" 没有父 */
  parentId: string | null
  /** 角色标签，如 "core-engineer", "ui-integrator", "reviewer" */
  role: string
  /** spawn 时间戳 */
  spawnedAt: number
}
```

## 3. 生命周期状态机

```
         ┌──────────┐
         │   idle   │ ◄────────────────────────┐
         └────┬─────┘                          │
              │ spawn(task)                    │
              ▼                                │
     ┌────────────────┐                        │
     │  discovering   │ 分析任务，列出所需文件    │
     └───────┬────────┘                        │
             │ files identified                │
             ▼                                 │
    ┌──────────────────┐                       │
    │ acquiring_locks  │ 尝试获取文件排他锁      │
    └────────┬─────────┘                       │
             │ locks acquired                  │
             ▼                                 │
    ┌────────────────┐    error/timeout        │
    │    working     │ ─────────────────────►  │
    └────────┬───────┘                         │
             │ work complete                   │
             ▼                                 │
    ┌────────────────┐    parent rejects       │
    │   reviewing    │ ─────────────────────►  │
    └────────┬───────┘   (retry)               │
             │ parent approves                 │
             ▼                                 │
        ┌────────┐         ┌────────┐
        │  done  │         │ failed │──────────┘
        └────────┘         └────────┘  (terminal)
```

### 状态详解

| 状态 | 含义 | 允许的操作 |
|---|---|---|
| `idle` | 已注册但未分配任务 | 接收 spawn 任务 |
| `discovering` | 分析任务需求，枚举所需文件路径 | 不可中断，超时 60s |
| `acquiring_locks` | 尝试获取文件锁 | 阻塞等待，超时 120s 后 failed |
| `working` | 持有所有锁，正在执行 | 可 spawn 子 agent（leaf 层） |
| `reviewing` | 工作完成，等待父 agent review | 父 agent 调用 approve/reject |
| `done` | 父 agent 批准，锁释放 | 只读 |
| `failed` | 错误/超时/被拒绝且放弃 | 锁释放，结果标记为失败 |

## 4. 文件锁系统

### 4.1 锁模型

**排他写锁（exclusive）**：同一时刻只有一个 agent 持有某文件路径的锁。

锁基于**文件路径字符串**精确匹配，支持 glob 模式：
- `vanilla/spreadsheet-ui-core/src/find-replace/*` — 锁定整个 find-replace 目录
- `vanilla/spreadsheet-ui-core/test/find-replace.test.ts` — 锁定单个测试文件

### 4.2 锁操作

```ts
interface FileLock {
  path: string           // 锁定的路径（glob 字面量）
  holderAgentId: string  // 持有者
  acquiredAt: number     // 获取时间戳
  mode: 'exclusive'
}

// 原子操作
acquireLock(agentId, paths: string[]): AcquireResult  // 全部获取或全部失败
releaseLock(agentId): void                              // 释放该 agent 的所有锁
queryLocks(): FileLock[]                                // 查询当前所有活跃锁
isBlocked(paths: string[]): string | null               // 返回冲突的 agentId 或 null
```

### 4.3 锁获取规则

1. **全或无**：agent 声明一组文件路径，要么全部获取，要么一个都不获取。
2. **子集约束**：子 agent 的文件路径必须是父 agent 路径的子集，且兄弟 agent 之间不能重叠。
3. **超时释放**：锁持有超过 `LOCK_TIMEOUT_MS = 30 min` 自动释放，agent 标记为 failed。
4. **释放时机**：agent 进入 `done` 或 `failed` 时自动释放。

### 4.4 冲突检测

```ts
function detectConflict(requested: string[], existing: FileLock[]): Conflict | null {
  for (const lock of existing) {
    for (const path of requested) {
      if (pathsOverlap(path, lock.path)) {
        return { holderAgentId: lock.holderAgentId, conflictingPath: lock.path }
      }
    }
  }
  return null
}
```

## 5. 递归 Spawn 协议

### 5.1 Spawn 请求

```ts
interface SpawnRequest {
  /** 父 agent 的任务 id */
  parentTaskId: string
  /** 子 agent 的 role */
  role: string
  /** 分配给子 agent 的文件边界（必须是父边界的子集） */
  fileBoundaries: string[]
  /** 任务描述 */
  task: AgentTask
}

interface AgentTask {
  taskId: string
  title: string
  description: string
  acceptanceCriteria: string[]
  /** 依赖的其他 taskId（子 agent 可以等待兄弟完成） */
  dependencies: string[]
  /** 超时，默认 30 min */
  timeoutMs: number
}
```

### 5.2 Spawn 前置条件检查

父 agent 在 spawn 子 agent 前必须验证：

1. `agentTreeDepth(parentId) < MAX_DEPTH`
2. `activeChildrenCount(parentId) < MAX_CHILDREN_PER_PARENT`
3. `activeAgentsTotal() < MAX_TOTAL_AGENTS`
4. 子 agent 的 `fileBoundaries` ⊆ 父 agent 的 `fileBoundaries`
5. 子 agent 的 `fileBoundaries` ∩ 所有活跃兄弟的 `fileBoundaries` = ∅

任一条件不满足 → spawn 被拒绝。

### 5.3 子 Agent 并发模式

```
父 agent working
    │
    ├─► spawn(A1, files=[src/a/*, test/a.test.ts])
    ├─► spawn(A2, files=[src/b/*, test/b.test.ts])     ← 并行执行
    ├─► spawn(A3, files=[src/c/*, test/c.test.ts])
    │
    ├─► wait(A1) → result
    ├─► wait(A2) → result
    └─► wait(A3) → result
         │
         ▼
    aggregate → 父 agent 继续
```

子 agent 之间**完全并行**，只要文件边界不重叠。有依赖关系时，子 agent 在 `discovering` 阶段检查依赖是否满足。

## 6. 结果聚合

### 6.1 Agent 结果

```ts
interface AgentResult {
  agentId: string
  taskId: string
  status: 'done' | 'failed'
  /** 创建/修改的文件列表 */
  touchedFiles: string[]
  /** 交付物描述 */
  deliverables: { path: string; kind: 'created' | 'modified' }[]
  /** 测试结果摘要 */
  testResults: { suite: string; passed: number; failed: number; skipped: number }[]
  /** 已知风险 */
  knownRisks: string[]
  /** 子 agent 的结果（递归） */
  childResults: AgentResult[]
  /** 耗时 ms */
  durationMs: number
}
```

### 6.2 聚合规则

父 agent 收到所有子 agent 结果后：

1. **全部 done** → 父 agent 合并 `touchedFiles`、聚合 `testResults`，产生自己的 `AgentResult` 进入 `reviewing`
2. **任一 failed** → 父 agent 决定：重试（重新 spawn）/ 降级（接受部分结果）/ 失败（自己也 failed）
3. **超时** → 未完成的子 agent 被强制终止，按失败处理

## 7. 与现有约束的兼容

本协议是 `AGENT_COLLABORATION.md` 的**超集**，不破坏任何现有规则：

| 现有约束 | 多 Agent 模式如何保持 |
|---|---|
| 框架无关（不能依赖 Solid/React/DOM/Worker/WASM）| 所有 agent 协调 atoms 在 `vanilla/spreadsheet-ui-core` 中，不引入新依赖 |
| 状态只能用 Einfach atom/store | `agentRegistryAtom`、`agentFileLockAtom` 等全部基于 `@einfach/core` |
| 不允许 per-cell/per-row/per-column atom | agent 注册表 bounded（MAX_TOTAL_AGENTS=20），文件锁 bounded（按活跃 agent 数） |
| 每个 feature 的 backend port 必须可选 | agent 协调不新增任何 backend port |
| 所有 atom 必须有 `debugLabel` | 使用 `spreadsheet.agentOrchestration.*` 命名空间 |

## 8. 安全边界

### 8.1 死锁预防

- 锁获取是**全或无**的原子操作 → 不存在 hold-and-wait
- 子 agent 的文件边界是父 agent 的子集 → 不存在父子竞争
- 兄弟 agent 文件边界不重叠 → 不存在兄弟竞争
- 超时自动释放 → 不存在永久死锁

### 8.2 资源限制

- `MAX_TOTAL_AGENTS = 20` — 防止 agent 爆炸
- `LOCK_TIMEOUT_MS = 30 * 60 * 1000` — 30 分钟超时
- `DISCOVERING_TIMEOUT_MS = 60 * 1000` — 分析阶段 1 分钟超时

### 8.3 不能做的事

- ❌ 不能跨文件边界写文件（只能动自己锁定的文件）
- ❌ 不能回退其他 agent 的改动
- ❌ 不能在同一任务中既当 parent 又当 leaf（不能自 spawn）

## 9. 示例：用多 Agent 模式推进 Wave 8

```
Root Agent ("orchestrator")
    fileBoundaries: ["docs/*", "vanilla/spreadsheet-ui-core/src/*"]
    │
    ├─► spawn("8.1-designer", role="formula-engineer")
    │     fileBoundaries: ["rust/excel-core/src/eval.rs",
    │                      "docs/wave-8-formula-extension-and-export.md"]
    │     task: "设计 Wave 8.1 REMOTE() 函数的新方案（对齐已落地的 #BUSY! 机制）"
    │
    ├─► spawn("8.4-designer", role="render-engineer")
    │     fileBoundaries: ["vanilla/spreadsheet-ui-core/src/copy-as/*",
    │                      "solid/excel/src-vnext/grid/SpreadsheetGridOverlay.tsx"]
    │     task: "完成 Wave 8.4 Range PNG screenshot"
    │
    └─► 等待两个子 agent → 聚合结果 → reviewing → done
```

## 10. 实现路线

参见 `ROADMAP.md` Wave 8 之后的多 Agent 编排实现：本协议定义的 atoms 在 `vanilla/spreadsheet-ui-core/src/agent-orchestration/` 实现，不在任何业务 Wave 范围内。
