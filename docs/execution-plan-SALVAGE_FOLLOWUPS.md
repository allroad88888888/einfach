# SALVAGE_FOLLOWUPS 执行计划

> 来源：`solid/excel/docs/online-excel-parity/SALVAGE_FOLLOWUPS_2026-07-27.md`
> 版本：v2（已根据架构师 review 修正 12 处）
> 总子任务数：60 个
> 预计总耗时：~15 小时

---

## 背景

`claude/rust-core-state-plan-Auzcj` 分支上 16.6k 行未提交改动经审查后拆分为 4 个 commit 已合入。剩余 P0/P1/P2 问题 + Remote Formulas 重启指引如下。

---

## ⛔ 并行工作区互斥（所有 Agent 必须遵守）

当前环境存在另一个 AI 正持有且未提交的文件。以下红线任何人不得触碰：

```
禁止区域（零容忍，碰了就炸）:
  apps/                    ← 另一个 AI 的工作区
  package.json             ← monorepo 根配置
  pnpm-workspace.yaml      ← workspace 声明
  pnpm-lock.yaml           ← 依赖锁定文件

硬性规则:
  1. 禁 git add -A / git add -u / git add .
     提交必须用显式文件清单: git add path/to/file1.ts path/to/file2.ts

  2. 禁碰上述四处禁止区域，一个字节都不行

  3. npm test 若触发 pnpm-lock.yaml 变化 → 不得暂存
     （pnpm 在并行环境下可能重解依赖）

  4. 每条链工作前先 git status --short，确认无意外 dirty file
```

---

## Commit 策略

```
pre-commit hook 现状:
  npm run build && npm test   ← 约 5-10 分钟，且 build 失败会清包产物

策略:
  - 全部 commit 使用 --no-verify 跳过 pre-commit hook
  - 按链切 commit（一链 = 一个 commit），不混链提交
  - 每个 Wave 出口手动跑一次完整门禁替代 pre-commit:

    Wave 门禁命令:
      npx tsc -b
      npx jest vanilla/spreadsheet-ui-core --runInBand
      npx jest solid/excel --runInBand
      cd rust/excel-core && cargo test

  - commit message 格式:
    fix(SALVAGE): <链名> — <一句话描述>
    例如: fix(SALVAGE): D 链 — tsc -b 零错误
```

---

## 依赖图与并发策略

```
Wave 1（全部并行，32 个 subtask）
┌──────────────────────────────────────────────────────────┐
│ A 链: static 错误字面量 (7 tasks)    ─── Agent 1         │
│ B 链: WASM numberFormat 别名 (5)    ─── Agent 2          │
│ C 链: eslint solid/* 门禁 (4)       ─── Agent 3          │
│ D 链: tsc -b 零错误 (11)            ─── Agent 4          │
│ E 链: react flaky (4)               ─── Agent 5          │
│                                                          │
│ 5 条链零互相依赖，3-agent 方案:                           │
│ Agent 1 = A + E, Agent 2 = B + D, Agent 3 = C            │
│                                                          │
│ ⚠️ C 链 Wave 1 只交 C1.4 报告，清理行动另排              │
└──────────────────────────────────────────────────────────┘
                          │
                    汇合点 ⎫ tsc -b 零错误
                          ⎬ parity 全绿
                          ⎭ eslint 评估报告 ready
                          ↓
Wave 2（架构师主导，10 tasks）
┌──────────────────────────────────────────────────────────┐
│ F 链: ack-hardening 共享 helper 重构                      │
│ F1.4 editing 先做 pilot → 冻结 helper API                 │
│ → F1.5~F1.9 其余 5 模块串行迁移（每个 30min）             │
└──────────────────────────────────────────────────────────┘
                          ↓
Wave 3（依赖 F，6+12 tasks）
┌──────────────────────────────────────────────────────────┐
│ G 链: fill undo 聚合 (6)    ⎤ 可并行                     │
│ H 链: lint 旧债清零 (12)    ⎦                             │
└──────────────────────────────────────────────────────────┘
                          ↓
Wave 4（可选，C 链报告 + 架构师决策后启动）
┌──────────────────────────────────────────────────────────┐
│ eslint 存量清理（C1.5a-n，规模 TBD）                      │
│ REMOTE 公式全链路重启（7 步，每步验证后再下一步）          │
└──────────────────────────────────────────────────────────┘
```

---

## Wave 1：止血 + 补门禁（最大并行）

---

### A 链：static 求值器裸错误字面量

**优先级**：P0 | **Agent**：1 | **耗时**：~1.5h | **依赖**：无

#### A1.1 [10min] 梳理 Rust 侧 13 个 error token 清单

```
入口: rust/wasm/src/lib.rs → error_token_to_value_error

交付物: 精确列表
  #NULL!   #DIV/0!   #N/A     #REF!    #VALUE!
  #NAME?   #NUM!     #CYCLE!  #TYPE!   #ARGS!
  #SPILL!  #CALC!    #BUSY!

注意:
  - #N/A 无叹号结尾
  - #NAME? 以问号结尾
  - 其余以叹号结尾
```

#### A1.2 [20min] tokenizer 新增 ErrorLiteral token

```
入口: solid/excel/src-vnext/adapter/static-formula-eval.ts

操作:
  在 tokenizer 的 switch/if 链中新增 ErrorLiteral 识别分支
  正则: /^#(NULL!|DIV\/0!|N\/A|REF!|VALUE!|NAME\?|NUM!|CYCLE!|TYPE!|ARGS!|SPILL!|CALC!|BUSY!)/
  返回 { type: 'ErrorLiteral', value: ValueError }

约束:
  允许新增 AST 节点类型（这是合理的最小改动），不重构既有节点
```

#### A1.3 [15min] parser 将 ErrorLiteral → 错误值节点

```
入口: 同文件 parser 部分

操作:
  新增 ErrorLiteral → 直接产出错误值 AST 节点
  不需要额外 parse 步骤，token 本身就足够
  如果有现成的错误值/字面量节点可复用就复用；
  若必须新增节点类型则新增（合理最小改动）
```

#### A1.4 [10min] 求值器错误传播路径确认

```
入口: 同文件 eval 部分

操作:
  确认算术运算（+ - * / ^）中任意操作数为错误值 → 短路返回该错误
  确认比较运算（= <> < <= > >=）中错误值同样短路
  大概率已有此逻辑，只读确认
```

#### A1.5 [10min] static 单测

```
入口: solid/excel/test/static-formula-eval.test.ts（如不存在则新建）

方法: 直接调 evaluateFormula（或走 static-backend 端到端）
  不是 setCellInput — setCellInput 是后端 API，不是求值器 API

操作:
  新增用例: evaluateFormula('=#REF!+1') → 结果 '#REF!'
  可选: 覆盖 '#N/A'、'#NAME?'、'#DIV/0!' 等
  跑: npx jest solid/excel/test/static-formula-eval.test.ts --runInBand
```

#### A1.6 [15min] parity 场景 7 双侧对齐

```
入口: solid/excel/test/vnext-auto-fill-static-wasm-parity.test.ts

操作:
  场景 7: 双侧都断言 '#REF!'（不再分别钉住现值）
  删除文件头和用例上的 FIXME 注释
  跑: npx jest solid/excel/test/vnext-auto-fill-static-wasm-parity.test.ts --runInBand
```

#### A1.7 [5min] 回归确认

```bash
npx jest solid/excel --runInBand
# 预期: 全绿，无新增失败
```

---

### B 链：WASM numberFormat 别名

**优先级**：P0 | **Agent**：2 | **耗时**：~1h | **依赖**：无

#### B1.1 [10min] Rust wire 枚举加 serde alias

```
入口: rust/wasm/src/lib.rs

操作:
  找到 number_format_kind 的反序列化枚举
  给 decimal 变体加 #[serde(alias = "number")]
  保持序列化输出仍为 "decimal"

示例:
  #[serde(rename = "decimal")]
  #[serde(alias = "number")]
  Decimal,
```

#### B1.2 [15min] native 测试

```
入口: rust/excel-core/tests/ (新建或追加已有关联测试)

操作:
  构造 SpreadsheetCellFormat { numberFormat: { kind: "number" } }
  序列化 → 反序列化 → 断言 kind 为 "decimal"
  断言格式字段（digits/thousands/negative）完整保留

  cargo test --test <测试文件名>
```

#### B1.3 [20min] 同类别名扫荡

```
唯一口径:
  vanilla/spreadsheet-ui-core/src/backend/types.ts → SpreadsheetNumberFormat 类型定义
  这是 canonical source，不要凭记忆列举

操作:
  1. 读 SpreadsheetNumberFormat 的 kind 联合，提取所有成员
  2. 对每个成员 grep rust/wasm/src/lib.rs 中的 wire 反序列化
  3. 对照 TS 类型文档中声明的别名关系（如有 "percentage" ↔ "percent" 等）
  4. 确认每个别名在 Rust 侧都有对应的 serde alias
  5. 缺口 → 补齐

跑: cargo test --test <测试文件名>
```

#### B1.4 [15min] 架构不变性测试（非快照 regen）

```bash
cd rust/excel-core
# 先跑，预期直接绿（serde alias 不改公共签名）
cargo test --test architecture_invariants

# 仅当上述失败时才 regen:
cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored
# ⚠️ 不要无脑跑 regen——会在快照文件上留无意义 diff
```

#### B1.5 [5min] 回归确认

```bash
cd rust/excel-core && cargo test
# 预期: 全绿
```

---

### C 链：eslint solid/* 门禁

**优先级**：P1 | **Agent**：3 | **耗时**：~0.5h | **依赖**：无
**⚠️ Wave 1 只交付 C1.4 报告，清理行动另排 Wave 4**

#### C1.1 [10min] 改 rules/.eslintrc

```
入口: rules/.eslintrc

操作:
  parserOptions.project 数组新增:
    "./solid/*/tsconfig.json"
```

#### C1.2 [10min] 评估 Solid JSX overrides 需求

```
入口: rules/.eslintrc 中 react 目录的 overrides 段落

操作:
  读 react overrides 写法（no-unused-vars 对 JSX 组件引用）
  判断 solid 是否需要同样处理
  如需要 → 加 overrides 段落
```

#### C1.3 [5min] 只读验证（定向、单文件）

```bash
# ⚠️ 不跑全仓！不跑 --fix！
# 用一个 solid 文件验证配置是否生效即可
npx eslint --config rules/.eslintrc \
  --ignore-path rules/.eslintignore \
  'solid/excel/src-vnext/public.ts'

# 预期: 能解析出规则结论即证明配置生效（有 lint 错误也算"生效"）
# 对比: 改配置前该文件解析直接失败
```

#### C1.4 [10min] 生成分类报告

```bash
# 全量只读扫描（仍然不 --fix）
npx eslint --config rules/.eslintrc \
  --ignore-path rules/.eslintignore \
  'solid/excel/**/*.{ts,tsx}' 2>&1 | tee /tmp/eslint-solid-report.txt
```

```
输出格式:

=== eslint solid/* 评估报告 ===
总错误数: ___

按规则分类:
  max-len:               ___ 个
  no-unused-vars:        ___ 个
  no-use-before-define:  ___ 个
  @typescript-eslint/*:  ___ 个
  其他:                   ___ 个

按文件 Top 10:
  1. ___ (___ 个)
  2. ___ (___ 个)
  ...

建议策略:
  [ ] < 50   → 一次性清理 commit → 归入 Wave 4
  [ ] 50-200 → 分文件批量清理     → 归入 Wave 4
  [ ] > 200  → .eslintignore 豁免存量 + 新文件生效 + 分期还债 → 归入 Wave 4
```

#### C1.5 [待定] 清理行动

```
⚠️ 不占 Wave 1 预算。
架构师根据 C1.4 报告决策后，作为独立 Wave 4 执行。
```

---

### D 链：tsc -b 全仓零错误

**优先级**：P1 | **Agent**：4 | **耗时**：~2.5h | **依赖**：无

#### D1.1 [5min] 收集错误清单

```bash
npx tsc -b 2>&1 | tee /tmp/tsc-errors.txt
wc -l /tmp/tsc-errors.txt
# 文档说 ~39 个错误，先确认实际数字
```

#### D1.2 [15min] viewport 测试 it.each 修复

```
入口: vanilla/spreadsheet-ui-core/test/viewport.test.ts

错误模式: it.each(readonly tuple) 回调参数类型不兼容

解法:
  表数据已 as const → 回调签名改为:
    (...args: (typeof TABLE)[number])
  或给 it.each 显式泛型参数:
    it.each<[number, number, string]>(TABLE)(...)

跑: npx jest vanilla/spreadsheet-ui-core/test/viewport.test.ts --runInBand
```

#### D1.3 [15min] toolbar 测试 it.each 修复

```
入口: vanilla/spreadsheet-ui-core/test/toolbar.test.ts
错误模式: 同 D1.2
解法: 同 D1.2

跑: npx jest vanilla/spreadsheet-ui-core/test/toolbar.test.ts --runInBand
```

#### D1.4 [15min] effective-hidden 测试 it.each 修复

```
入口: vanilla/spreadsheet-ui-core/test/effective-hidden.test.ts
错误模式: 同 D1.2
解法: 同 D1.2

跑: npx jest vanilla/spreadsheet-ui-core/test/effective-hidden.test.ts --runInBand
```

#### D1.5 [10min] conditional-formatting TS6133

```
入口: vanilla/spreadsheet-ui-core/test/conditional-formatting.test.ts

错误模式: TS6133 — 未使用导入/常量

操作:
  grep 未使用的 import/const
  确认是真死代码 → 删除
  确认是类型断言用 → void expr 或 satisfies
```

#### D1.6 [10min] workspace TS6133

```
入口: vanilla/spreadsheet-ui-core/test/workspace.test.ts
错误模式 + 操作: 同 D1.5
```

#### D1.7 [10min] selection TS6133

```
入口: vanilla/spreadsheet-ui-core/test/selection*.test.ts
错误模式: TS6133（含 *_IS_READ_ONLY 常量块）

操作:
  逐一确认每个常量是否被使用
  真死代码 → 删除
  类型断言用 → void expr
```

#### D1.8 [10min] filter-sort TS6133

```
入口: vanilla/spreadsheet-ui-core/test/filter-sort.test.ts
错误模式 + 操作: 同 D1.5
```

#### D1.9 [15min] protection.test.ts TS2559

```
入口: vanilla/spreadsheet-ui-core/test/protection.test.ts

错误模式: TS2559 — mock 形状与 SheetProtectionPersistencePort 无交集

操作:
  选项 A: mock 补上端口缺失方法
  选项 B: Partial<Port> + 显式断言

跑: npx jest vanilla/spreadsheet-ui-core/test/protection.test.ts --runInBand
```

#### D1.10 [20min] worker-runtime.ts:368 类型不匹配

```
入口: solid/excel/src-vnext/adapter/worker-runtime.ts:368

错误模式: CustomFormulaCallable vs AsyncCustomCallable 参数类型不匹配

前置:
  先读 rust/excel-core/src/CUSTOM_FORMULAS.md § Marshaling
  确认 range 实参路径有测试覆盖

操作:
  CustomFormulaCallable 参数对齐 AsyncCustomArg[]
  或 pump 的 lookup 泛化

验证（不只是 tsc）:
  npx tsc -b  零错误
  npx jest solid/excel/test/vnext-custom-formulas.test.tsx --runInBand  全绿
  npx jest solid/excel/test/excel-core-ts-custom-formulas.test.ts --runInBand  全绿
  npx jest solid/excel/test/vnext-worker-ts.test.ts --runInBand  全绿
  # 确认 range 实参（二维数组）路径行为不变
```

#### D1.11 [5min] 最终确认

```bash
npx tsc -b
# 预期: 零错误
```

---

### E 链：react asyncWith flaky

**优先级**：P1 | **Agent**：5（或 Agent 1 兼） | **耗时**：~1h | **依赖**：无

#### E1.1 [15min] 分析根因

```
入口: react/react/test/asyncWith.test.tsx

操作:
  找出所有真实计时器位置（setTimeout、waitFor 默认超时）
  确认 1.5-2s 等待的代码路径
```

#### E1.2 [30min] 改为 fake timers

```
入口: 同文件

操作:
  beforeEach → jest.useFakeTimers()
  所有真实 setTimeout → advanceTimersByTime 推进
  微任务: await Promise.resolve() 手动排空

注意:
  如果 asyncWith 行为依赖真实宏任务/微任务交错：
  先尝试 fake timers，不行再走 E1.3 Plan B
```

#### E1.3 [10min] Plan B — 加超时（仅当 E1.2 行不通）

```
操作:
  waitFor 超时从默认 1s → 10s
  jest.setTimeout(30_000)
  加注释说明为何不能用 fake timers

注意: 不用 jest.retryTimes — 只是藏 flaky
```

#### E1.4 [15min] 验证（全量并行负载）

```bash
# ⚠️ flake 只在全量并行下复现，单跑 --runInBand 本来就是绿的
# 正确验收: 全量并行连续 3 次零失败

for i in $(seq 1 3); do
  echo "=== npm test run $i ==="
  npm test || { echo "FAILED at run $i"; exit 1; }
done

# 如果 npm test 太重，最低替代:
npx jest react --maxWorkers=8
# 连续 10 次零失败
```

---

## Wave 1 汇合检查清单

在进入 Wave 2 之前，以下必须全部绿：

```
[ ] A1.7: npx jest solid/excel --runInBand                             全绿
[ ] B1.5: cargo test                                                    全绿
[ ] B1.4: cargo test --test architecture_invariants                     绿（未 regen）
[ ] C1.3: eslint 能解析 solid/excel/src-vnext/public.ts                 配置生效
[ ] C1.4: eslint 评估报告已交付架构师
[ ] D1.11: npx tsc -b                                                   零错误
[ ] D1.10: custom-formulas / async-pump 相关套件                         全绿
[ ] E1.4: npm test 连续 3 次（或 npx jest react --maxWorkers=8 ×10）  零失败
[ ] solid/excel/test/vnext-auto-fill-static-wasm-parity.test.ts          无 FIXME
```

---

## Wave 2：ack-hardening 重构（架构师主导）

**优先级**：P2 | **Agent**：架构师 | **耗时**：~4h | **依赖**：Wave 1 汇合点

---

### F 链：ack-hardening 共享 helper

```
执行顺序（串行，不并行）:

  F1.1 审计 → F1.2 建模块 → F1.3 写单测 → F1.4 editing 做 pilot
       ↓
  冻结 helper API（signature 不再改）
       ↓
  F1.5 → F1.6 → F1.7 → F1.8 → F1.9  其余 5 模块串行迁移
       ↓
  F1.10 最终验证

为什么不全串行:
  每个模块迁移只需 30min，pilot 之后 API 冻结，
  串行也不慢但避免了"6 个并行分支同时发现签名要改"的返工风险。
```

#### F1.1 [20min] 审计重复代码

```bash
# 找出所有 snapshotAcknowledgement 定义
grep -rn 'function snapshotAcknowledgement' vanilla/spreadsheet-ui-core/src

# 找出所有 runBoundedOperation 定义
grep -rn 'runBoundedOperation' vanilla/spreadsheet-ui-core/src

# 找出所有超时常量散落点
grep -rn '15000' vanilla/spreadsheet-ui-core/src

# 找出 captureInput / authorityWitness 重复
grep -rn 'captureInput\|authorityWitness' vanilla/spreadsheet-ui-core/src

# 输出: 精确的重复位置清单（文件 + 行号 + 代码段）
```

#### F1.2 [30min] 新建共享模块

```
入口: vanilla/spreadsheet-ui-core/src/internal/ack-hardening.ts
      （新建，不从包入口导出，纯内部模块）

内容骨架:

// ============================================================
// 超时常量 — 所有 mutation 模块共用
// ============================================================
export const MUTATION_TRANSPORT_TIMEOUT_MS = 15_000

// ============================================================
// snapshotAcknowledgement 泛型工厂
// ============================================================
export function snapshotAcknowledgement<TAck, TSpec extends Record<string, keyof TAck>>(
  ack: TAck,
  spec: TSpec,
): Readonly<Partial<TAck>> {
  // ... 按字段规格提取 + 冻结 ACK 快照
  // 保持与现有 8 份实现逐字节等价
}

// ============================================================
// runBoundedOperation 统一超时竞速
// ============================================================
export async function runBoundedOperation<T>(
  run: () => Promise<T>,
  timeoutMs: number = MUTATION_TRANSPORT_TIMEOUT_MS,
  timeoutError: string = 'operation timed out',
): Promise<T> {
  // ... Promise.race 超时逻辑
}

// ============================================================
// ticket 基类型
// ============================================================
export interface MutationTicket {
  requestId: number
  revision: number | string
  startedAt: number
}

// ============================================================
// captureInput / authorityWitness 泛型工厂
// ============================================================
export function createCaptureInput<TInput>() {
  // ...
}

export function createAuthorityWitness<T>() {
  // ...
}
```

#### F1.3 [20min] 共享模块自身单测

```
入口: vanilla/spreadsheet-ui-core/test/ack-hardening.test.ts（新建）

覆盖:
  - snapshotAcknowledgement: 正常提取、空 ack、null ack、字段冻结
  - runBoundedOperation: 正常完成、超时抛出、取消 token
  - captureInput/authorityWitness: 生命周期、序列化
  - MUTATION_TRANSPORT_TIMEOUT_MS 值不变

跑: npx jest vanilla/spreadsheet-ui-core/test/ack-hardening.test.ts --runInBand
```

#### F1.4 [30min] ⭐ editing 模块迁移（pilot）

```
入口: vanilla/spreadsheet-ui-core/src/editing/index.ts

操作:
  1. import { snapshotAcknowledgement, runBoundedOperation, MUTATION_TRANSPORT_TIMEOUT_MS } from '../internal/ack-hardening'
  2. 删除模块内自己的 snapshotAcknowledgement / runBoundedOperation 定义
  3. 保持所有公共 API 导出面不变
  4. grepping 确认错误消息字符串、debugLabel 逐字节不变

验证:
  npx jest vanilla/spreadsheet-ui-core/test/editing.test.ts --runInBand  全绿
  npx jest vanilla/spreadsheet-ui-core/test/mutation-gateway.test.ts --runInBand  全绿

⚠️ 此模块完成后，helper API 冻结，不再改签名，然后才继续下面模块
```

#### F1.5 [30min] history 模块迁移

```
入口: vanilla/spreadsheet-ui-core/src/history/index.ts

操作: 同 F1.4 模式

验证:
  npx jest vanilla/spreadsheet-ui-core/test/history.test.ts --runInBand  全绿
```

#### F1.6 [30min] filter-sort 模块迁移

```
入口: vanilla/spreadsheet-ui-core/src/filter-sort/index.ts

操作: 同 F1.4 模式

验证:
  npx jest vanilla/spreadsheet-ui-core/test/filter-sort.test.ts --runInBand  全绿
```

#### F1.7 [30min] operations 模块迁移

```
入口: vanilla/spreadsheet-ui-core/src/operations/index.ts

操作: 同 F1.4 模式

验证:
  npx jest vanilla/spreadsheet-ui-core/test/operations.test.ts --runInBand  全绿
```

#### F1.8 [30min] paste-special 模块迁移

```
入口: vanilla/spreadsheet-ui-core/src/paste-special/index.ts

操作: 同 F1.4 模式

验证:
  npx jest vanilla/spreadsheet-ui-core/test/paste-special.test.ts --runInBand  全绿
```

#### F1.9 [30min] remove-duplicates 模块迁移

```
入口: vanilla/spreadsheet-ui-core/src/remove-duplicates/index.ts

操作: 同 F1.4 模式

验证:
  npx jest vanilla/spreadsheet-ui-core/test/remove-duplicates.test.ts --runInBand  全绿
```

#### F1.10 [5min] 最终验证

```bash
# 确认只有一个定义
grep -rn 'function snapshotAcknowledgement' vanilla/spreadsheet-ui-core/src
# 预期: 只有 internal/ack-hardening.ts 一处

grep -rn 'runBoundedOperation' vanilla/spreadsheet-ui-core/src | grep -v 'import' | grep -v '//' | wc -l
# 预期: 定义 1 处 + 各模块调用 N 处（N = 迁移模块数）

# 公共 API 导出面无变化
diff <(git show HEAD:vanilla/spreadsheet-ui-core/src/index.ts) \
     vanilla/spreadsheet-ui-core/src/index.ts
# 预期: 无差异

# 全测试
npx jest vanilla/spreadsheet-ui-core --runInBand  全绿
npx jest solid/excel --runInBand                     全绿
```

---

## Wave 3：fill undo + lint 旧债

**优先级**：P2 | **耗时**：~5h | **依赖**：Wave 2（F 链完成）

---

### G 链：fill undo 聚合

#### G1.1 [15min] 审计当前兜底路径

```
入口: vanilla/spreadsheet-ui-core/src/auto-fill/index.ts

操作:
  找出 runAutoFillAtom 的兜底路径（宿主无 fillRange/importCells 端口）
  确认逐格 setCellInput 循环
  MAX_UI_FILL_FALLBACK_CELLS = 200
  确认每格都压了一条 history
```

#### G1.2 [15min] 评估载荷上限

```
入口: vanilla/spreadsheet-ui-core/src/history/

已知:
  MAX_HISTORY_SIDE_PAYLOADS = 64
  兜底路径最多 200 格

决策:
  [ ] 选项 A: 行程压缩连续区间（如 row 5 col 2-10 → 单条 payload 记 begin+end）
  [ ] 选项 B: 复合条目单独上限声明（不受 64 限制）
  [ ] 选 A 还是 B？——架构师根据 G1.1 审计结果决策
```

#### G1.3 [30min] 实现复合 history entry

```
入口: vanilla/spreadsheet-ui-core/src/history/

操作:
  兜底路径 N 次 setCellInput → 聚合为单条 entry
  entry side payload 存逆操作列表（行程压缩格式）
  入口在 runAutoFillAtom 兜底分支中聚合后再压栈
  复用 F 链的共享 helper
```

#### G1.4 [20min] 实现 undo 执行

```
入口: 同 G1.3

操作:
  undo 时识别复合 entry
  逆序回放逆操作
  任一失败 → outcome-unknown（不能半撤销）
```

#### G1.5 [15min] 补测试 ⚠️ 位置修正

```
正确位置: vanilla/spreadsheet-ui-core/test/auto-fill-command.test.ts

为什么不在 vnext-fill-series:
  - 兜底路径前提: 宿主没有 fillRange/importCells 端口
  - vnext-fill-series 跑的是 static 后端，两个端口都有
  - 必须用只有 setCellInput 的 mock 宿主来测

操作:
  构造 mock 宿主: { setCellInput: jest.fn(), /* 无 fillRange, 无 importCells */ }
  新增用例: 兜底路径填 5 格
  断言: history 长度 +1（不是 +5）
  断言: 一次 undo → 全部还原
```

#### G1.6 [10min] 回归确认

```bash
npx jest vanilla/spreadsheet-ui-core/test/auto-fill-command.test.ts --runInBand  全绿
npx jest vanilla/spreadsheet-ui-core/test/auto-fill-series.test.ts --runInBand  全绿
npx jest solid/excel/test/vnext-auto-fill-static-wasm-parity.test.ts --runInBand  全绿
# 真实后端路径行为不变
```

---

### H 链：lint/type 存量旧债

#### H1.1 [15min] format-painter max-len

```
入口: vanilla/spreadsheet-ui-core/test/format-painter.test.ts
  + vanilla/spreadsheet-ui-core/src/format-painter/index.ts

操作: 超过 100 字符的行 → 合理换行/提取变量
跑: npx jest vanilla/spreadsheet-ui-core/test/format-painter.test.ts --runInBand
```

#### H1.2 [15min] find-replace max-len

```
入口: vanilla/spreadsheet-ui-core/test/find-replace.test.ts
  + vanilla/spreadsheet-ui-core/src/find-replace/index.ts

操作: 同 H1.1
跑: npx jest vanilla/spreadsheet-ui-core/test/find-replace.test.ts --runInBand
```

#### H1.3 [15min] conditional-formatting max-len + 未使用导入

```
入口: vanilla/spreadsheet-ui-core/test/conditional-formatting.test.ts
  + vanilla/spreadsheet-ui-core/src/conditional-formatting/index.ts

操作: 同 H1.1 + 删未使用导入
跑: npx jest vanilla/spreadsheet-ui-core/test/conditional-formatting.test.ts --runInBand
```

#### H1.4 [15min] frozen-panes max-len

```
入口: vanilla/spreadsheet-ui-core/test/frozen-panes.test.ts
  + vanilla/spreadsheet-ui-core/src/viewport/freeze.ts

操作: 同 H1.1
跑: npx jest vanilla/spreadsheet-ui-core/test/frozen-panes.test.ts --runInBand
```

#### H1.5 [15min] menu max-len

```
入口: vanilla/spreadsheet-ui-core/test/menu.test.ts
  + vanilla/spreadsheet-ui-core/test/menu-bar.test.ts
  + vanilla/spreadsheet-ui-core/src/menu/
  + vanilla/spreadsheet-ui-core/src/menu-bar/

操作: 同 H1.1
```

#### H1.6 [15min] viewport max-len

```
入口: vanilla/spreadsheet-ui-core/test/viewport.test.ts
  + vanilla/spreadsheet-ui-core/src/viewport/

操作: 同 H1.1
```

#### H1.7 [15min] toolbar max-len

```
入口: vanilla/spreadsheet-ui-core/test/toolbar.test.ts
  + vanilla/spreadsheet-ui-core/src/toolbar/

操作: 同 H1.1
```

#### H1.8 [15min] selection max-len

```
入口: vanilla/spreadsheet-ui-core/test/selection.test.ts
  + vanilla/spreadsheet-ui-core/src/selection/

操作: 同 H1.1
```

#### H1.9 [15min] workspace max-len + 未使用常量

```
入口: vanilla/spreadsheet-ui-core/test/workspace.test.ts
  + vanilla/spreadsheet-ui-core/src/workspace/

操作: 同 H1.1 + 删未使用常量
```

#### H1.10 [15min] protection max-len

```
入口: vanilla/spreadsheet-ui-core/test/protection.test.ts
  + vanilla/spreadsheet-ui-core/src/protection/

操作: 同 H1.1
```

#### H1.11 [20min] history.test.ts max-lines-per-function

```
入口: vanilla/spreadsheet-ui-core/test/history.test.ts

问题: 单箭头函数 1192 行

操作:
  按 describe('场景A') / describe('场景B') 块拆分
  每个 describe 块独立 it()，不共享闭包 mutable 状态
  beforeEach 中复现共用 setup

跑: npx jest vanilla/spreadsheet-ui-core/test/history.test.ts --runInBand
```

#### H1.12 [10min] 回归确认

```bash
npx eslint --config rules/.eslintrc \
  --ignore-path rules/.eslintignore \
  'vanilla/spreadsheet-ui-core/src/**/*.ts' \
  'vanilla/spreadsheet-ui-core/test/**/*.ts'

# 预期: 零错误（涉及文件范围）
```

---

## Wave 3 汇合检查清单

```
[ ] F1.10: snapshotAcknowledgement 唯一定义        只剩 1 处
[ ] F1.10: 公共 API 导出面无变化                   无差异
[ ] F1.10: npx jest vanilla/spreadsheet-ui-core    全绿
[ ] F1.10: npx jest solid/excel                    全绿
[ ] G1.6:  fill undo 聚合测试                      全绿
[ ] G1.6:  parity 套件回归                         全绿
[ ] H1.12: eslint 涉及文件                         零错误
```

---

## Wave 4：eslint 存量清理 + REMOTE（可选）

### eslint 存量清理（依赖 C1.4 报告）

```
由架构师根据 C1.4 报告决策:
  < 50 错误 → 一次性清理 commit
  50-200   → 按文件拆 C1.5a ~ C1.5n，分批 commit
  > 200    → .eslintignore 豁免存量 + 新文件生效 + 分期还债
```

### REMOTE 公式全链路重启

**优先级**：可选 | **耗时**：~3-5 天 | **依赖**：Wave 3 完成

#### 核心原则（吸取上次教训）

```
⚠️ 每层接通验证后再做下一层
⚠️ 禁止出现"设计文档与代码不一致"
⚠️ 先端口 → 再 capability → 再引擎 → 再 pump → 再 adapter → 最后测试
⚠️ 上次失败的三个具体坑:
   1. #REMOTE! error token 漏了输出方向（全部退化成 #VALUE!）
   2. TS-worker 按 createWorkerRuntimeTs() 次数重复挂监听（跨 jsdom 测试泄漏 + callId 串线）
   3. 文档描述的架构与代码不一致
```

### Step 1 [半天] 端口先行

```
入口: vanilla/spreadsheet-ui-core/src/backend/types.ts

操作:
  SpreadsheetBackend 增加可选方法:
    registerRemoteResolver?(key: string, fn: RemoteResolverFn): void
    unregisterRemoteResolver?(key: string): void

  UI core 按惯例: 宿主缺端口 → 隐藏 REMOTE 相关入口

验收:
  tsc 通过
  package-boundary.test.ts 绿
```

### Step 2 [半天] capability 家族

```
入口: solid/excel/src-vnext/adapter/worker-protocol.ts

操作:
  仿 auto-fill 的 scoped witness 模式
  声明 remote 能力: { scope: 'remote', enabled: boolean }
  fail-closed: TS worker 明确 remote: false + 结构化 UNSUPPORTED

验收:
  TS worker 启动不报错
  remote: false 时 REMOTE() 调用返回 #NAME?
```

### Step 3 [1天] 引擎

```
入口: rust/excel-core/src/sheet.rs (call_custom)

操作:
  1. call_custom 加 REMOTE 前置分支
     走 async-custom memo/pending 基建（#BUSY! 路径）

  2. ✅ 关键: ValueError::Remote 接进 rust/wasm error token 表
     ⚠️ 双向都要加：
       - error_token_to_value_error（输入方向）
       - Value → error token（输出方向）
     ⚠️ 上次正是漏了输出方向导致全部退化成 #VALUE!

  3. Workbook::is_builtin_function_name 加 "REMOTE"

验收:
  cargo test 全绿
  REMOTE() 语法解析通过
  #REMOTE! 错误 token 双向通畅
```

### Step 4 [2h] 名字保留

```
入口:
  vanilla/spreadsheet-ui-core/src/custom-formulas/engine-builtin-names.ts
  rust/excel-core/src/eval.rs → is_builtin_function_name

操作:
  两个影子表同步加 "REMOTE"
  自定义公式注册路径拒绝 REMOTE 名（引擎会先截胡）

验收:
  registerCustomFormula('REMOTE', ...) → 被拒绝
  =REMOTE(...) → 引擎截胡（不走到自定义路径）
```

### Step 5 [半天] pump

```
入口: solid/excel/src-vnext/adapter/async-custom-pump.ts

操作:
  加 routeRemote hook
  ⚠️ 每个 runtime 实例只挂一次 postMessage 监听
  ⚠️ 上次 TS-worker 按 createWorkerRuntimeTs() 调用次数重复挂监听
     → 跨 jsdom 测试泄漏 + callId 串线

验收:
  单 worker runtime: REMOTE() → #BUSY! → resolve → 正确值
  多 runtime: callId 不串线
```

### Step 6 [半天] 主线程 adapter

```
入口: solid/excel/src-vnext/adapter/worker-workbook-backend.ts

操作:
  处理 remote-call → 查 resolver → remote-result 回传
  无 resolver → 回 #NAME?
  reject/超时 → 回 #REMOTE!

验收:
  registerRemoteResolver('MYAPI', fn) → REMOTE('MYAPI', arg) → round-trip 成功
  无 resolver → #NAME?
  reject → #REMOTE!
```

### Step 7 [1天] 验收线

```bash
# Engine native
cargo test  # 全绿

# Worker 双 runtime 一致性
npx jest solid/excel/test/vnext-worker-ts.test.ts --runInBand  全绿
npx jest solid/excel/test/wasm-workbook-worker.test.ts --runInBand  全绿

# 主线程 round-trip
npx jest solid/excel/test/vnext-custom-formulas.test.tsx --runInBand  全绿

# Playwright e2e
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/custom-formulas.spec.ts
# 新增用例: 真实 resolver mock 数据 → 单元格显示正确值
```

---

## Agent 分配方案（Wave 1 选配）

### 方案 A：5 Agent（最理想）

```
Agent 1 → A 链全部 (A1.1 → A1.7)
Agent 2 → B 链全部 (B1.1 → B1.5)
Agent 3 → C 链全部 (C1.1 → C1.4)
Agent 4 → D 链全部 (D1.1 → D1.11)
Agent 5 → E 链全部 (E1.1 → E1.4)

每组 0.5-2.5h 完成，完全并行
```

### 方案 B：3 Agent（实战推荐）

```
Agent 1 → A 链 + E 链
          先做 A1.1→A1.7 (1.5h)，再做 E1.1→E1.4 (1h)
          A 链和 E 链互不依赖，A 先因为 P0 优先级更高

Agent 2 → B 链 + D 链
          先做 B1.1→B1.5 (1h)，再做 D1.1→D1.11 (2.5h)
          Rust 改动少，做完马上切 JS 层

Agent 3 → C 链 (C1.1→C1.4)
          半小时出报告 → 提交给架构师 → 可休假或协助 D 链
```

---

## 全局验收标准

```bash
# ===== 类型检查 =====
npx tsc -b
# 预期: 零错误

# ===== Lint（定向验证配置生效，不全仓 --fix）=====
npx eslint --config rules/.eslintrc --ignore-path rules/.eslintignore \
  'solid/excel/src-vnext/public.ts'
# 预期: 能解析出规则结论

# ===== 测试 =====
npm test
# 预期: 全绿，无 flaky

# ===== Rust =====
cd rust/excel-core && cargo test
# 预期: 全绿

# ===== E2E =====
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
# 预期: 全绿

# ===== 重构验证 =====
grep -rn 'function snapshotAcknowledgement' vanilla/spreadsheet-ui-core/src | wc -l
# 预期: 1（只有 internal/ack-hardening.ts）

# ===== 零 FIXME =====
grep -rn 'FIXME' solid/excel/test/vnext-auto-fill-static-wasm-parity.test.ts
# 预期: 空（A1.6 已清理）
```

---

## 备案（不立项，仅记录）

- **static 求值器不支持跨表引用**（`Sheet!A1`）：`static-formula-eval.ts` 头部已声明"worker backend covers those"，是演示后端的既定边界。不建议在演示求值器上加戏。
- **`escapeAutoFillOpaqueRevisionWitness`**：有测试钉住 lone-surrogate 全域性，已收窄到 auto-fill 专用推进路径。保留，除非重构 revision 语义否则不动。
- **`DisplayCell.format` 投影冗长度差异**（WASM 全展开 vs static 稀疏）：两者描述同一有效格式；parity 套件用 `normalizeFormat` 归一后比较。若未来做格式序列化对外导出再统一。

---

## 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| D1.10 worker-runtime 类型对齐涉及运行时语义 | 中 | 高 | 先确认 range 实参测试覆盖再改；加 custom-formulas/async-pump 套件验证 |
| F 链迁移中错误消息字符串不一致 | 中 | 中 | pilot 先冻结 API → 每模块迁移前后 grepping diff |
| C1.4 eslint 存量过大（>200） | 中 | 低 | Wave 1 只交报告，清理另排 Wave 4 |
| A1.2 tokenizer 改动影响已有公式解析 | 低 | 中 | ErrorLiteral 只在表达式内出现，不影响正常 token |
| E1.2 fake timers 与 React 响应式不兼容 | 低 | 低 | 有 Plan B 超时兜底 |
| G1.2 200 格 > 64 payload 无法用行程压缩 | 低 | 低 | 选复合条目单独上限 |
| 并行工作区冲突（apps/ 被另一个 AI 持有） | 低 | 🔴 | 硬性规则：禁 git add -A、禁碰 apps/ package.json pnpm-*.yaml |
