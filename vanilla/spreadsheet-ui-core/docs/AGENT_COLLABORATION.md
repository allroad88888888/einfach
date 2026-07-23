# Spreadsheet UI Core Agent Collaboration

> **Multi-Agent Mode 现已可用。** 参见 [`AGENT_ORCHESTRATION.md`](./AGENT_ORCHESTRATION.md) 了解层级化并发编排协议，以及 `src/agent-orchestration/` 了解 atom 实现。

---

## Multi-Agent Mode

本文件现在支持 **双模式**：

| 模式 | 章节 | 适用场景 |
|---|---|---|
| **Multi-Agent** | 本章节 | 3+ 个 AI agent 并发推进，支持递归 spawn |
| **Legacy Dual-Agent** | [见下方](#legacy-dual-agent-mode) | CC + Codex 手动看板（历史兼容） |

### 快速上手

1. **注册 Root**: `store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', ... })`
2. **获取锁**: `store.setter(acquireLocksAtom, { agentId: 'root', paths: [...] })`
3. **Spawn**: `store.setter(spawnAgentAtom, { parentAgentId: 'root', request: {...} })`
4. **等待**: 子 agent → `completeTaskAtom` → 父 agent → `approveResultAtom`
5. **聚合**: 父 agent 收集 `childResults` 产生 `AgentResult`

### In-flight 看板（Multi-Agent）

| 日期 | Agent ID | Feature | 状态 | 文件边界 | 父 |
|---|---|---|---|---|---|
| 2026-07-23 | root | agent-orchestration | in progress | `vanilla/spreadsheet-ui-core/src/agent-orchestration/*`, `vanilla/spreadsheet-ui-core/test/agent-orchestration.test.ts`, `vanilla/spreadsheet-ui-core/docs/AGENT_ORCHESTRATION.md`, `vanilla/spreadsheet-ui-core/docs/AGENT_COLLABORATION.md` | — |

### 角色模板

| Role | 典型文件 |
|---|---|
| `orchestrator` | 全局协调、spawn/join |
| `core-engineer` | `vanilla/spreadsheet-ui-core/src/<feature>/*` |
| `ui-integrator` | `solid/excel/src-vnext/<feature>/*` |
| `formula-engineer` | `rust/excel-core/src/*` |
| `render-engineer` | `solid/excel/src-vnext/grid/*` |
| `reviewer` | 跨边界审查 |
| `e2e-tester` | `solid/excel/e2e/*` |

### 冲突处理（Multi-Agent）

1. **自动检测**: `agentFileLockAtom` 在 spawn 时检测兄弟锁冲突
2. **祖先委托**: 子 agent 可获取祖先已持有的锁
3. **超时释放**: 锁持有超过 30 min 自动释放
4. **冲突升级**: 同文件多 agent 修改 → 父 agent 仲裁

---

## Legacy Dual-Agent Mode

> 以下为原有的 CC + Codex 双 agent 手动看板。保留作为历史参考。

### 使用规则

- 开工前先读本文件、`ROADMAP.md` 和对应 feature doc。
- 开工前更新 In-flight 看板；完成后更新状态、测试和遗留风险。
- 不要回退对方改动。看到非自己改的 dirty file，先把它当作对方正在工作。
- 一个 agent 同一时间只拥有明确文件边界；跨边界要先在本文件留言。
- `vanilla/spreadsheet-ui-core` 必须保持框架无关：不能依赖 Solid、React、DOM、worker、wasm。
- 状态只能用 Einfach atom/store。
- 不允许 per-cell/per-row/per-column atom。

### In-flight 看板（Legacy）

| 日期 | Owner | Feature | 状态 | 文件边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 2026-05-15 | CC/Codex | multi-range-selection | done | `src/selection/*`, `src/keyboard/*`, `src/pointer/*` | — |
| 2026-05-15 | Codex | multi-range UI integration | done | `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx` | — |
| 2026-05-15 | CC | rich-types core | done | `src/rich-types/*` | — |
| 2026-05-15 | Codex | rich-types UI integration | done | `solid/excel/src-vnext/*` | — |
| 2026-07-14 | CC | Wave 8.2 custom formulas async | done | `rust/core`+`rust/excel-core`+`rust/wasm` | — |

状态值: `planned` / `in progress` / `needs review` / `blocked` / `done`

### 角色分工（Legacy）

**CC** — `vanilla/spreadsheet-ui-core/src/*` 核心实现 + 单测 + 契约同步
**Codex** — 架构 review + `solid/excel/src-vnext/*` UI 接线 + Playwright e2e + release gate

共同责任: backend port 必须可选、atom 必须有 debugLabel、跨包类型变更必须过 boundary test。

### Feature 交接模板

```md
### Handoff: <feature> / <日期>
Owner:
Status:
Touched files:
Public types changed:
Atoms added/changed:
Backend ports added/changed:
Tests run:
Known risks:
Next request:
```

### 实现准入

- 是否属于当前 wave / 有明确插队理由
- 是否需要扩展 `DisplayCell` / `SpreadsheetBackend` / keyboard intent / toolbar command / projection result
- 是否保持可视窗口有界
- backend optional port 缺失时降级路径
- 是否影响 `solid/excel/src-vnext` adapter

### 测试门禁

```bash
# 文档
git diff --check -- vanilla/spreadsheet-ui-core/docs

# UI core
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit --pretty false
npx jest vanilla/spreadsheet-ui-core/test/<feature>.test.ts --runInBand
npx jest vanilla/spreadsheet-ui-core/test/package-boundary.test.ts --runInBand

# Solid adapter
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
npx jest solid/excel/test/vnext-*.test.tsx solid/excel/test/vnext-adapter.test.ts --runInBand
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

视觉/交互/clipboard/worker/viewport 改动必须做 MCP Playwright 验证。

### Review 重点

- 状态来源是否唯一
- 是否在 render/projection 循环里动态创建 atom
- 是否引入全表扫描
- backend optional port 缺失降级
- 类型导出不破坏 package boundary

---

## Multi-Agent Dry-Run: Agent Orchestration Implementation

| Stage | Task | Status | Deliverables |
|---|---|---|---|
| design | 设计编排协议 | done | `docs/AGENT_ORCHESTRATION.md` |
| implement-core | 实现协调 atoms | done | `src/agent-orchestration/{types,atoms,index,README}.md` |
| implement-templates | spawn 模板 + task schema | done | `src/agent-orchestration/{spawn-template.md,task-schema.json}` |
| update-collab | 升级本文档 | done | AGENT_COLLABORATION.md |
| verify | 测试验证 | done | 17/17 tests passed |

**Tests**: `npx jest vanilla/spreadsheet-ui-core/test/agent-orchestration.test.ts --runInBand` → 17 passed, 0 failed

**Next**: 用 multi-agent 模式推进 Wave 8.1 (remote formulas 设计) 和 8.4 (range PNG screenshot)
