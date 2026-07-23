# Agent Spawn Template

用于父 agent spawn 子 agent 时的标准化请求模板。

## 模板

```ts
import type { SpawnRequest } from '../types'

const spawnRequest: SpawnRequest = {
  // 父 agent 的任务 ID（用于结果聚合时关联）
  parentTaskId: '<parent-task-uuid>',

  // 子 agent 的角色
  role: 'core-engineer',  // 见下方 Role 枚举

  // 分配给子 agent 的文件边界（必须是父边界的子集，不与兄弟重叠）
  fileBoundaries: [
    'vanilla/spreadsheet-ui-core/src/<feature>/*',
    'vanilla/spreadsheet-ui-core/test/<feature>.test.ts',
  ],

  // 任务描述
  task: {
    taskId: '<unique-task-uuid>',
    title: '<简短标题>',
    description: '<详细描述，包括上下文、设计约束、参考文档>',
    acceptanceCriteria: [
      '<验收条件 1>',
      '<验收条件 2>',
    ],
    dependencies: [],  // 依赖的其他 taskId（可选）
    timeoutMs: 30 * 60 * 1000,  // 默认 30 分钟
  },
}
```

## Role 枚举

| Role | 典型文件边界 | 说明 |
|---|---|---|
| `orchestrator` | `docs/*`, `vanilla/spreadsheet-ui-core/src/*` | 根协调 agent |
| `core-engineer` | `vanilla/spreadsheet-ui-core/src/<feature>/*` | UI core 状态/逻辑实现 |
| `ui-integrator` | `solid/excel/src-vnext/<feature>/*` | Solid.js UI 组件 |
| `formula-engineer` | `rust/excel-core/src/*` | Rust 公式引擎 |
| `render-engineer` | `solid/excel/src-vnext/grid/*` | Canvas/DOM 渲染 |
| `reviewer` | 跨边界审查 | Review 已完成的 work |
| `e2e-tester` | `solid/excel/e2e/*` | Playwright e2e 测试 |

## 示例：Spawn 两个并行子 agent

```ts
// 父 agent (orchestrator) 持有边界: ['docs/*', 'vanilla/spreadsheet-ui-core/src/*', 'vanilla/spreadsheet-ui-core/test/*']

// 子 agent A: 实现 find-replace 核心
const spawnA: SpawnRequest = {
  parentTaskId: 'design-wave-8',
  role: 'core-engineer',
  fileBoundaries: [
    'vanilla/spreadsheet-ui-core/src/find-replace/*',
    'vanilla/spreadsheet-ui-core/test/find-replace.test.ts',
  ],
  task: {
    taskId: 'wave-8-impl-find-replace',
    title: 'Implement find-replace paged search',
    description: '...',
    acceptanceCriteria: ['atom 测试通过', '不引入 per-cell atom'],
    dependencies: [],
    timeoutMs: 1800000,
  },
}

// 子 agent B: 对接 Solid UI（文件边界与 A 不重叠）
const spawnB: SpawnRequest = {
  parentTaskId: 'design-wave-8',
  role: 'ui-integrator',
  fileBoundaries: [
    'solid/excel/src-vnext/find-replace/*',
    'solid/excel/test/vnext-find-replace.test.tsx',
  ],
  task: {
    taskId: 'wave-8-ui-find-replace',
    title: 'Integrate find-replace into Solid UI',
    description: '...',
    acceptanceCriteria: ['e2e 测试通过', 'Ctrl+F 快捷键可触发'],
    dependencies: [],
    timeoutMs: 1800000,
  },
}
```

## Handoff 协议（多 Agent 扩展）

```
### Handoff: <feature> / <日期>

From Agent: <fromAgentId>
To Agent:   <toAgentId>

Status:
Touched files:
Public types changed:
Atoms added/changed:
Backend ports added/changed:
Tests run:
Known risks:
Next request:
```

与原有 CC↔Codex 固定模式的差异：
- `From/To` 不再是固定角色，而是任意 agentId
- 子 agent 的 handoff 目标是其父 agent
- 父 agent 收到 handoff 后进行结果聚合
