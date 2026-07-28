# 仓库拆分计划：einfach → einfach + einfach-excel

**日期**：2026-07-28
**状态**：P0 已消解、P1 合并部分已完成（`43abddd` + `2cb4ce1`），待发布 `@einfach/core@0.3.0`；P2 起未开始
**决策**：`core/core` + `utils` + `react/*` + `core/solid` + `core/solid-form` 留在原仓
`allroad88888888/einfach`；excel 相关全部迁往 `git@github.com:allroad88888888/einfach-excel.git`。
原仓保留，不归档、不删除。

---

## 0. 目标仓状态（2026-07-28 核实）

| 项 | 值 |
|---|---|
| `allroad88888888/einfach-excel` | 已存在，public，**完全空**（2026-07-24 建，无分支、无默认分支） |
| 新仓 secrets | 无（旧仓有 `NPM_TOKEN`） |
| 旧仓 open PR / issue | 0 / 0 |
| 旧仓远端分支 | `main`、`changeset-release/main`、`claude/rust-core-state-plan-Auzcj`、`feat/export-cell导出` |
| 旧仓 tag | 28 |
| 推送范围（已定） | **只推 `main`** |

---

## 1. 归属清单

### 迁往 einfach-excel（878 个受控文件）

**目录合并已于 2026-07-28 在旧仓完成**（决策见 §6）：全部 excel 代码已收进顶层 `excel/`，
留守代码收进顶层 `core/`。因此拆仓时不再需要路径映射 —— 迁移面就是 `excel/` 这一棵树。

| 路径 | 原路径 | 包名 / crate | 文件数 | 备注 |
|---|---|---|---|---|
| `excel/spreadsheet-ui-core` | `vanilla/spreadsheet-ui-core` | `@einfach/spreadsheet-ui-core` v0.1.0 | 250 | 已发布包 |
| `excel/excel-core-ts` | `vanilla/excel-core-ts` | `@einfach/excel-core-ts` v0.0.0 | 73 | private |
| `excel/solid-excel` | `solid/excel` | `@einfach/solid-excel` v0.1.0 | 403 | 含 e2e / playwright |
| `excel/showcase` | `apps/excel-showcase` | `@einfach/excel-showcase` v0.1.0 | 8 | private |
| `excel/rust/core` | `rust/core` | `einfach-core`（Rust） | 10 | **见下** |
| `excel/rust/excel-core` | `rust/excel-core` | `einfach-excel-core` | 105 | |
| `excel/rust/wasm` | `rust/wasm` | `einfach-wasm` | 5 | |
| `excel/rust/docs` | `rust/docs` | — | 24 | |

**`excel/rust/core` 的归属（2026-07-28 决策：跟 excel 走）**：它是 `einfach-core` —— 1790 行 Rust 版 atom store
（`atom.rs` 369 / `store.rs` 1297 / `family.rs` 117），带 twin 测试（`store_twin.rs` / `family_twin.rs`，
每个用例是 `core/core` jest 测试的逐条移植，钉 INV-1 与 TS 实现同构）。
身份上属 core，但消费方只有 `excel/rust/excel-core` 与 `excel/rust/wasm` 两个 crate，二者都以 `path = "../core"` 相对路径引用。
跟 excel 一起走 ⟹ **Rust 侧零跨仓依赖**，相对路径关系原样成立；留在原仓则必须改成 crates.io 发布或 git 依赖。
代价：Rust 与 TS 两版 atom store 分居两仓，twin 测试的对照物变成跨仓引用（仅文档引用，非代码依赖）。

### 留在 einfach（209 个受控文件）

`core/core` (48)、`core/utils` (26)、`core/react` + `core/react-utils` + `core/react-form` (83)、
`core/solid` (18)、`core/solid-form` (34)。

---

## 2. 跨仓接缝

excel 侧对留守侧的全部引用只有两个包，且只用到最稳定的原语：

| 来源 | 符号 | 引用点 |
|---|---|---|
| `@einfach/core` | `atom` `Atom` `AtomEntity` `createStore` `Getter` `Setter` `Store` `WritableAtom` | 94 |
| `@einfach/solid` | `Provider` `useAtomValue` `useSetAtom` `useStore` | 34 |

已核实：

- excel 侧对 `@einfach/utils`、`@einfach/react*` **零引用**；对 `createHistory` / `createUndoRedo` **零引用**。
- `excel/spreadsheet-ui-core` 对 `@einfach/solid` 和 `solid-js` **零引用**（三层分层约束成立，可整体搬走）。
- 留守侧对 excel 侧的引用只存在于 `jest.config.mjs`、根 `package.json`、`rollup.config.mjs` 三个配置文件，源码零耦合。
- **Rust 侧无跨仓接缝**：`excel/rust/core` 跟 excel 一起走（§6），三个 crate 的 `path = "../…"` 相对依赖原样成立，不需要 crates.io 或 git 依赖。

---

## 3. P0（阻塞项）：core 已双向分叉 —— **已解决 2026-07-28**

| 事实 | 值 |
|---|---|
| npm 已发布 | `@einfach/core@0.2.19`（= `origin/main`，含 `8e46430` 深层依赖链爆栈修复） |
| 当前分支 HEAD | **不含** `8e46430`；自己重写了 `store.ts`；`createUndoRedo` → `createHistory`（breaking） |
| `origin/main..HEAD` 的 `core/core/src/store.ts` 差异 | **590 行** |
| excel 测试实际吃的 core | jest `moduleNameMapper` → **HEAD 源码**，该版本从未发布 |

**后果**：新仓若直接依赖 `@einfach/core@^0.2.19`，excel 将跑在一个与其开发/测试基线差 590 行引擎代码的 core 上。

**结论**：拆仓的第一步不是拆，是**在原仓合掉 core 的两条分叉并发一版**（含 `createHistory` 则为 `0.3.0`）。

**反向好消息**：`core/solid/src` 的未发布改动逐行核实为纯格式（`import type` 转换、尾逗号、`return await value` → `return value`），
**零行为变更** → npm `@einfach/solid@0.2.18` 与 HEAD 功能等价，**不需要为拆仓重发 solid**。

### 解决结论（2026-07-28）

两条线是**同一问题的两次独立实现**，相隔 3 天：`d995942`（07-11，本分支，`READ_RECURSION_BUDGET = 256` + FAULT 哨兵帧循环，587 行）
与 `8e46430`（07-14，main，`MAX_SYNC_EVALUATION_DEPTH = 250` + 缺失依赖异常 + 显式栈，473 行）。技术路线一致。

判定依据：把 main 的 `deepNesting.test.ts` 原样打在本分支引擎上，**19 个用例全绿**（含 249/250/251/500 临界深度切换）
→ 本分支引擎行为上覆盖 `8e46430`，且多 791 行深链护栏测试。

处置（`43abddd`）：合并 `origin/main`，冲突面仅 2 个文件，均取本分支实现 ——
`core/core/src/store.ts`（已证明为超集）、`core/react/test/asyncWith.test.tsx`（本分支已改写为 `waitFor` + 10s，
超集于 main 的 `timeout: 3000`）。main 的 `deepNesting.test.ts` 并入长期保留，作为跨实现回归钉。
同时带入 7 个包的版本号 / CHANGELOG 与 `publish.yml` 的 `NODE_AUTH_TOKEN` 修复。

副作用：`8e46430`、`a558de1`、`4e33a33` 现已是 HEAD 祖先，**原 P0 的 GC 风险自动消解**，无需再打 backup 分支。

---

## 4. 分阶段

### ~~P0 保命~~ —— 已由 P1 的合并消解

原风险：`8e46430`、`a558de1`、`4e33a33` 只活在 remote-tracking ref 里，fetch/prune 后会被 GC。
`43abddd` 合并 `origin/main` 后三者均为 HEAD 祖先，风险不存在。

### P1 收口 core 分叉并发版（原仓内完成）—— 合并已完成，发版待做

1. ~~把 HEAD 的 `store.ts` 重写与 `8e46430` 的深度受限递归 + 显式栈迭代合并~~ → `43abddd`，见 §3 解决结论。
2. ~~跑深链护栏全套~~ → `npx jest core/core core/react` 30 套 225 passed / 3 skipped；
   下游 `npx jest excel/spreadsheet-ui-core solid core/utils react` 205 套 3727 passed / 6 skipped。
3. ~~写 changeset~~ → `2cb4ce1`，`@einfach/core: minor` → 0.3.0。
   用 `minor` 而非 `major`：包在 0.x，changesets 不对 0.x 特殊处理，`major` 会跳到 1.0.0。
4. **待做**：发布 `@einfach/core@0.3.0`。需本分支合入 `main` 后由 `publish.yml` 执行 —— 受「arc 收口前不推远端」约束。
   `@einfach/solid` 无需重发（见 §3）。

**第 4 步不完成，新仓没有可依赖的 core。**

发布面变化（相对已发布 0.2.19）：移除 `createUndoRedo` / `openUndoRedoAtom`（全仓零代码引用，仅
`excel/solid-excel/docs/STRUCTURAL_UNDO.md` 两处概念性提及），新增 `createHistory` 全套 + `isSourceAtom` / `SYNTHESIZED_WRITE`，
引擎换实现。`core/utils/src` 与 `core/solid/src` 的净变更分别只是测试文件和纯格式，均不需要发版。

### P2 内容拆分（在新仓工作副本内进行，不改原仓）

- **历史策略（待定）**：`git filter-repo` 保留 excel 相关提交历史（本机 `git-filter-repo` 未安装，需 `brew install git-filter-repo`）；
  或 squash 成单个 initial commit + `git mv`。二选一。
- **路径映射已不需要**：目录合并已在旧仓完成，excel 全部代码位于 `excel/` 一棵树下，切分退化为：

  ```
  git filter-repo --path excel --path <保留的根配置>
  ```

  根配置（`package.json` / `pnpm-workspace.yaml` / `jest.config.mjs` / `tsconfig*.json` /
  `rollup.config.mjs` / `rules/` / `.swcrc` / `babel.config.cjs` / `.prettierrc.mjs` / `.gitignore`）
  要么随切分带走后改造，要么在新仓重写 —— 见下条。
- 根配置各留改造版：
  - `pnpm-workspace.yaml` — 收窄 glob
  - `jest.config.mjs` — 删除 `@einfach/core` / `@einfach/solid` 的 `moduleNameMapper`，让其走 node_modules
  - `tsconfig*.json` — 去掉不存在的 project references
  - `rollup.config.mjs`、`rules/`、`.swcrc`、`babel.config.cjs`、`.prettierrc.mjs`、`.gitignore`
  - 根 `package.json` scripts（`ensureWasm` / `build` / `eslint` / `test`）
- **必须原样带走**：根 `pnpm.overrides.solid-js: "1.9.12"`。
  `@einfach/solid` 的 peer 是 `solid-js: ^1.9.0`、`excel/solid-excel` 直接依赖 `^1.9.12`，
  丢掉这条 override 就可能出现两份 solid-js 解析 —— 即已修复的 Provider 重挂 bug 复发路径。
- `@einfach/core`、`@einfach/solid` 从 `workspace:*` 改为 npm 版本号。
- 12 个硬编码旧 URL 的文件（根 + 9 个子包 `package.json`、`README.md:96`、`CONTRIBUTING.md:13`）按各自归属改写。
- `CLAUDE.md` / `skills/` / 文档按两仓边界拆。

### P3 验证（进新仓 CI 之前，本地必须全绿）

```
pnpm install → npm run build:wasm → npm run build
npx jest excel/spreadsheet-ui-core --no-coverage
npx jest excel/solid-excel --no-coverage
npm run e2e -w @einfach/solid-excel
```

**验证重点**：excel 跑在 **npm 版 core** 上仍全绿。不绿则退回 P1 补发。

### P4 首推（只推 main）

- 先推 `main`，让新仓默认分支落成 `main`。
- `.github/workflows/{ci,e2e,publish}.yml` 无任何 owner/repo 硬编码，可原样带走（触发条件均为 `branches: [main]`）。
- **首推 main 会同时触发 ci + e2e + publish**：
  - 新仓无 `NPM_TOKEN` → `publish.yml` 必红；
  - 补 token 后 changesets/action 可能直接发包或开 Version Packages PR，还需在新仓打开
    "Allow GitHub Actions to create and approve pull requests"。
  - 规避：首推前配好 token 与权限，或先把 `publish.yml` 的 `on` 临时改为 `workflow_dispatch`
    （该动作修改 workflow，须等当前 arc 收口后再做）。

### P5 原仓收口

- 从 `pnpm-workspace.yaml` 摘掉已迁出目录；清理 `jest.config.mjs` mapper、`tsconfig` references、`rollup.config.mjs`。
- `README.md` 写明 excel 已迁至 `einfach-excel`。
- 两仓共用 `@einfach` npm scope，包名不重叠，发布互不冲突。

---

## 5. 风险与不变式

| 风险 | 处置 |
|---|---|
| ~~`8e46430` 等 3 个提交只在 remote-tracking ref~~ | 已消解：`43abddd` 合并后三者均为 HEAD 祖先 |
| ~~core 双向分叉 590 行~~ | 已收敛：`43abddd` 取本分支实现，main 的测试全绿回归；剩发布未做 |
| solid-js 单实例不变式跨仓 | 新仓根 `pnpm.overrides` 必须带 `solid-js: 1.9.12`；lockfile 中只能有一条 `solid-js@` 解析 |
| `provider-remount` 契约测试对被拆开 | `core/solid/test/provider-remount.test.tsx` 留守、`excel/solid-excel/test/provider-remount-1912.test.tsx` 迁出；迁出侧改为验证 npm 版 `@einfach/solid`，两侧都要保留 |
| 首推即触发 publish | P4 规避方案二选一 |
| 128 个本地 worktree 共享一个 `.git` | 拆仓不影响它们；新仓需重建自己的 worktree 体系 |

---

## 6. 已定决策（2026-07-28）

| 决策 | 结论 | 理由 |
|---|---|---|
| `core/solid` + `core/solid-form` 归属 | **留原仓**，只有 `excel/solid-excel` 走 | 用户拍板 |
| `excel/rust/core` 归属 | **跟 excel 走** | 消费方只有 excel 侧两个 crate；一起走则 Cargo 相对路径依赖零改动，Rust 侧无跨仓依赖 |
| excel 目录合并时机 | **改为立即在旧仓做**（用户拍板，2026-07-28 已完成） | 先前建议并进拆仓那步，以省下 84 个在飞分支的重命名合并税；用户选择即刻建立可见边界，代价已知并接受 |
| 顶层分组 | `core/`（库）+ `excel/`（表格栈） | 目录叶子名与包名对齐（`core/react-utils` ↔ `@einfach/react-utils`），唯一例外 `excel/showcase` |
| 推送范围 | 只推 `main` | 用户拍板 |
| 旧仓 | 保留，不归档不删 | 用户拍板 |

---

## 7. 待定项

1. **历史策略**：`git filter-repo` 保留 excel 历史，还是 squash 起步。
2. **P1 的 core 版本号**：changeset 已按 `minor` → `0.3.0` 落地（`2cb4ce1`），**待你确认**；
   若要走 `1.0.0`，把该 changeset 的 `minor` 改成 `major` 即可。
3. **执行时机**：P1 的合并与 changeset 已在当前分支完成；发布与 P2 之后仍需等 arc 收口。
