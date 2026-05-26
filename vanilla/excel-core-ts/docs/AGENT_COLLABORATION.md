# Excel Core (TS) Port — Agent Collaboration

> 本文档是 CC、Codex 和子代理在 `@einfach/excel-core-ts` 落地过程中的共享工作台。
> 配套阅读：[PLAN.md](./PLAN.md)（范围 / 阶段 / 决策）+ [ARCHITECTURE.md](./ARCHITECTURE.md)（数据流 / 代码形态）。

目标：以并行小作战的形式把 Rust 38k 行 evaluator 搬到 TS。同一个 wave 内多 agent 可以同时开工，靠**预先冻结的 contracts** 防止互相踩踏。

---

## 使用规则

- **开工前先读** PLAN.md + ARCHITECTURE.md + 本文件，对齐之后再更新 in-flight 看板。
- 每个 agent 只持有**明确的文件边界**。看到别人 dirty 的文件，当作"对方仍在工作"，不要回退。
- **跨边界改动必须先在本文件留言** 并等接管方确认，否则视为破坏并行假设。
- 接到的子任务**只能引入 `@einfach/core`** —— 不能引 `solid-js`、React、DOM、`navigator`、`window`、`worker` API、wasm 绑定，也不能引入 jotai/zustand/mobx 任何外部状态库。
- **绝不**写 per-cell / per-row / per-column atom。整张表只有 `sheetAtom`（PLAN §4.1 / ARCH §2.3）。
- **绝不**让 evaluator 走 `get(cellAtom)`。evaluator 拿到 sheetAtom 的 Map snapshot 之后用普通 `Map.get` 查 ref（ARCH §4）。
- 单元测试用 jest + ts，**不要起 worker / wasm / DOM**。`@einfach/excel-core-ts` 必须能在纯 node 环境 `jest --no-coverage` 通过。
- **不动 CI / `.github/workflows`**。本期阶段全部不推 origin。

---

## In-flight 看板

| 日期 | Owner | Wave / Task | 状态 | 文件边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 2026-05-26 | CC | docs (PLAN / ARCH / 本文档) | done | `vanilla/excel-core-ts/docs/*.md` | — |
| 2026-05-26 | CC | Wave A — package skeleton + contracts | done | `vanilla/excel-core-ts/{package.json,tsconfig.json,src/types.ts,src/index.ts,test/types.test.ts,README.md}` + root `tsconfig.json` + `jest.config.mjs` moduleNameMapper | Spawn Wave B's 3 tracks (B1 parser / B2 workbook+evaluator skeleton / B3 refs+a1+ranges) |

### Handoff: A / 2026-05-26

Owner: CC
Status: done
Touched files:
- `vanilla/excel-core-ts/package.json` (new)
- `vanilla/excel-core-ts/tsconfig.json` (new)
- `vanilla/excel-core-ts/src/types.ts` (new — public contracts)
- `vanilla/excel-core-ts/src/index.ts` (new — re-exports)
- `vanilla/excel-core-ts/test/types.test.ts` (new — smoke)
- `vanilla/excel-core-ts/README.md` (new)
- `tsconfig.json` (added project reference)
- `jest.config.mjs` (added moduleNameMapper entry)

Public types changed: established (none broken — package is new).
Atoms added/changed: none yet (Wave B/B2 creates sheetAtom).
Tests run: `npx jest vanilla/excel-core-ts --no-coverage` → 7/7 pass; full regression on `vanilla/spreadsheet-ui-core` + `vanilla/core` → 880/880 pass; `npx tsc -b vanilla/excel-core-ts` → clean.

Known risks:
- `Workbook` / `WorkbookSheet` are staged as `unknown` so D-track agents can name them — Wave B/B2 must replace these with real interfaces and update `src/index.ts`.
- The smoke test pins discriminator strings (e.g. `kind: 'crossSheet'`) — Wave B/B1 parser must emit those exact tags.

Next request: spawn 3 concurrent Agent calls for Wave B (B1/B2/B3) with file boundary white-lists per `## Wave 划分 → Wave B` section above.

状态值与原 `spreadsheet-ui-core/AGENT_COLLABORATION.md` 一致：`planned` / `in progress` / `needs review` / `blocked` / `done`。

---

## 角色分工

**CC（implementer agent）** 主力做：
- `vanilla/excel-core-ts/src/*` 实现
- `vanilla/excel-core-ts/test/*` jest 单测
- AST、Value、EvalContext、FunctionImpl 等公共类型的初版
- 子 agent 分派（每个 wave 内的并发任务由 CC 一次性 spawn 出去）

**Codex（review agent）** 主力做：
- 每个 wave 完成后的代码评审（性能 / 边界 / 接口一致性）
- 跨文件接口冲突检查（contracts 是否被破坏）
- 数学 / 财务 / 文本函数实现与 Excel 真行为的差异校对
- 关键节点的 BLOCK 决策（参考 memory `feedback_codex.md`）

**Solid 端接线**（worker shim / 新 demo）由 CC 在 Wave D 里完成；UI / playwright 验收由 Codex 走 MCP playwright（参考 memory `feedback_ui_smoke.md`）。

---

## Wave 划分

并行粒度的核心思路：先冻结**公共契约**，再把"按文件可切分"的工作扇出给多个 agent，避免在同一文件上排队。

### Wave A — 地基与契约（1-2 agent，1-2 天）

不可并行的开局。**所有后续 wave 都依赖本 wave 的 outputs**。

| Task | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **A1** package skeleton | 1 agent | `package.json`、`tsconfig.json`、`jest.config.js`、`src/index.ts` 空 export | `npx jest vanilla/excel-core-ts` 跑 0 个 spec 不报错；`tsc -b` 干净 |
| **A2** 冻结公共契约 | 同一 agent，串行 | `src/types.ts`：`Value`、`ErrorCode`、`CellKey`、`Cell`、`SheetMutation`、`EvalContext`、`FunctionImpl`、AST 离散联合 `Expr`（先只列字段，不实现 parser） | 类型可被外部 import，无运行时代码；写 5-10 行 README 注解每个类型边界 |

**Wave A done 之前不允许 spawn 任何子 agent**。这是为了避免后面 4 个 agent 各自拍脑袋造 `Value` 类型。

#### A2 冻结的契约草案

```ts
// 公共值类型 —— 所有函数实现的输入输出
export type Value =
  | { kind: 'blank' }
  | { kind: 'number';  value: number }
  | { kind: 'string';  value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error';   code: ErrorCode; message?: string }
  | { kind: 'array';   value: Value[][] }

// 函数实现签名 —— Wave C 子 agent 全部按这个写
export type FunctionImpl = (args: Value[], ctx: EvalContext) => Value

// 求值上下文 —— evaluator 注入，函数实现按需取用
export interface EvalContext {
  cells: ReadonlyMap<CellKey, Cell>  // 当前 sheet snapshot
  refLookup(ref: string): Value
  rangeLookup(start: string, end: string): Value[][]
  callCustom(name: string, args: Value[]): Value | undefined
  currentlyEvaluating: Set<CellKey>
  // ... 详见 src/types.ts
}
```

---

### Wave B — 核心拆三路并发（3 agent，3-5 天）

依赖 Wave A done。本 wave 的三条工作流**完全没有文件交集**，互不阻塞。

| Track | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **B1** parser | agent #1 | `src/parser/tokenizer.ts`、`src/parser/parser.ts`、`test/parser.test.ts` | Pratt 解析器，覆盖 `=1+2`、`=A1*B2-C3`、`=IF(A1>0,SUM(B1:B10),0)`、`=Sheet2!A1`、字符串 / 布尔 / 错误字面量；50+ fixture 跑过 |
| **B2** workbook + sheetAtom + 求值骨架 | agent #2 | `src/workbook.ts`、`src/sheet.ts`、`src/eval/evaluate.ts`（只实现算术 + 字面量，函数全部 throw `#NAME?`）、`test/workbook.test.ts` | `Workbook.setCell` / `Workbook.formulaCellAtom(key)` 跑通；vanilla/core sub 链路验证；`=1+2*3` → 7、`=A1+B1` 跨 cell 引用 |
| **B3** refs / a1 / ranges | agent #3 | `src/refs/a1.ts`、`src/refs/ranges.ts`、`test/refs.test.ts` | `A1 ↔ {row:0,col:0}`、`$A$1`、`AA12`、`A1:B10` 展开、`A:A`、`1:1`、range intersection；纯函数，不碰 atom |

**B1 → B2 的接口**：parser 产出的 `Expr` 必须严格符合 Wave A 在 `src/types.ts` 冻结的 AST schema。如需扩字段，B1 改类型前在本文档留言并 ping B2。

**B3 → B1+B2 的接口**：`a1.ts` 提供的 `parseRef` / `parseRange` 是 B1 解析时和 B2 evaluator refLookup 的共用依赖；早交付能解锁两边的测试。

#### Wave B 同步点

- B1 提交 tokenizer 后，B2 可以临时用 `parseExpr(text)` 串 test fixture（先用字符串 token 也可）。
- B2 可用 mock AST 跑 evaluator 单测，不等 B1。
- 三路完成后**Codex 做一次架构 review**（检查公共契约是否被偷偷破坏），通过才进入 Wave C。

---

### Wave C — 内置函数 5 路扇出（5 agent，1 周）

依赖 Wave B done。每个文件**互相独立**，最大并行度。

| Track | Owner | Files | Functions | Acceptance |
| --- | --- | --- | --- | --- |
| **C1** math | agent #1 | `src/eval/functions/math.ts`、`test/math.test.ts` | SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN, INT, MOD, ABS, POWER, SQRT, SIGN | 每个函数 ≥ 4 个 fixture，包含错误传播（`#DIV/0!`）+ 类型胁迫（string→number） |
| **C2** logical | agent #2 | `src/eval/functions/logical.ts`、`test/logical.test.ts` | IF, IFERROR, IFNA, AND, OR, NOT, IFS, SWITCH, TRUE, FALSE | IF 短路语义 + IFS 多分支 + SWITCH default fallback 都覆盖 |
| **C3** lookup | agent #3 | `src/eval/functions/lookup.ts`、`test/lookup.test.ts` | VLOOKUP, HLOOKUP, INDEX, MATCH, XLOOKUP | exact / approximate / wildcard 三种模式分别测；范围参数走 `rangeLookup`（Wave B 提供） |
| **C4** text | agent #4 | `src/eval/functions/text.ts`、`test/text.test.ts` | CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM, TEXT, VALUE | Unicode safe（用 `Array.from(str)` 而非 `str.length` 切片）；TEXT 的 numberFormat 跟 spreadsheet-ui-core 现有格式器对齐 |
| **C5** date + stats | agent #5 | `src/eval/functions/date.ts`、`src/eval/functions/stats.ts`、`test/date.test.ts`、`test/stats.test.ts` | TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY；COUNTIF, SUMIF, COUNTIFS, SUMIFS | 日期序列号采用 1900 epoch（Excel 默认），含 1900 闰年 quirk；COUNTIF 的通配符 `*` / `?` 跟 Rust 行为对齐 |

**注册中心**：所有函数在 `src/eval/functions/index.ts` 一个 `Map<string, FunctionImpl>` 集中注册。最后由 CC 串联（最快 1 文件 5 行）。

**单文件单 agent**：避免任何两个 agent 同时改同一文件。`index.ts` 是唯一的合并点，CC 最后统一注册。

**所有函数禁止**：
- 不能写 `console.log`（ESLint will fail）
- 不能 `import` 任何 `@einfach/excel-core-ts` 外的内部包
- 不能在函数实现里 mutate `args`、`ctx`、或捕获到的 Map

---

### Wave D — Worker shim + 新 demo（1-2 agent，2-3 天）

依赖 Wave C done（至少 C1/C2 done，演示用得到 SUM/IF 即可）。本 wave 是 cross-package，回到 `solid/excel/`。

| Task | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **D1** worker runtime | 1 agent | `solid/excel/src-vnext/adapter/worker-runtime-ts.ts`、`solid/excel/src-vnext/adapter/worker-factory.ts`（追加 ts 分支） | postMessage 解码 / 回包；保持与现有 wasm runtime 相同 backend port 行为；jest 单测 |
| **D2** 新 demo + URL flag | 同一 agent | `solid/excel/src-vnext/demos/VNextWorkerTsDemo.tsx`、`solid/excel/src/main.tsx` 注册 | 浏览器访问 `?backend=ts` 切到 TS worker；MCP playwright smoke：seed 一个公式 `=SUM(A1:A3)` 显示正确 |

完成后**Codex 走 MCP playwright** 全流程烟测（同时跟 wasm demo 比对几个 demo），按 memory `feedback_ui_smoke.md` 的纪律。

---

### Wave E — 功能对齐 4 路并发（4 agent，1-1.5 周）

依赖 Wave D done。四条 track 都不冲突，可同时开。

| Track | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **E1** spill 数组 + range 函数 | agent #1 | `src/eval/spill.ts`、`src/refs/ranges.ts` 扩展、`test/spill.test.ts` | TRANSPOSE / SEQUENCE / SUMPRODUCT；anchor cell 持 `{kind:'array'}`；renderer index 在 Wave F1 接线 |
| **E2** 跨表引用 | agent #2 | `src/refs/crossSheet.ts`、`src/workbook.ts` 扩 sheetName 索引、`test/cross-sheet.test.ts` | `Sheet2!A1`、`Sheet2!A1:B10`；evaluator 自动 `get(otherSheetAtom)` 登记跨表 dep |
| **E3** 命名范围 + LAMBDA | agent #3 | `src/names.ts`、`src/eval/lambda.ts`、`test/names.test.ts` | DEFINED.NAME 一个、LAMBDA 一个、范围名引用一个 |
| **E4** 自定义公式 port | agent #4 | `src/custom.ts`、`test/custom.test.ts`；以及 `solid/excel/src-vnext/adapter/worker-runtime-ts.ts` 的 register 桥（须协调 D1 的 owner） | 现有 `custom-formulas.spec.ts` 切到 TS worker 全绿；同步标量、范围参数（2D array）、错误传播都覆盖 |

E4 与 D1 共用一个文件 `worker-runtime-ts.ts`。**E4 owner 必须在 in-flight 看板上 `needs review` 阶段 ping D1 owner**，避免合入冲突。

---

### Wave F — 函数填充 + 切换 + 退役（mostly sequential）

| Task | Owner | 说明 |
| --- | --- | --- |
| **F1** 函数扩到 ~200 | 多 agent 滚动批 | 每批 10-20 个函数，跟 Wave C 同模式扇出；不再列单条 acceptance，按 Rust eval.rs 的 spec 一对一 port + jest 对照 |
| **F2** e2e 套件迁移 | 1 agent | `solid/excel/e2e/*` 所有 demo / formula spec 切到 `?backend=ts` 跑；记下 diff，回灌 fix |
| **F3** flip 默认 + Rust 退役 | 1 agent，最后做 | 把 TS worker 设为默认；rust/excel-core/ + rust/wasm/ + solid/excel/wasm-pkg/ + build:wasm 脚本 + wasm-pack toolchain step 全部移除 |

F3 是不可逆操作，**做之前必须 codex 全面 review**（参考 memory `feedback_codex.md`）。

---

## 跨 wave 同步点（必须等齐）

```
Wave A done  ──┐
               ├──► Wave B 3 路并发 ──► Codex 架构 review ──┐
               │                                              │
               │                                              ▼
               └────────────────────────────────────────► Wave C 5 路并发 ──► merge index.ts ──┐
                                                                                                │
                                                                                                ▼
                                                                                          Wave D shim 完成 ──┐
                                                                                                              │
                                                                                                              ▼
                                                                                                        Wave E 4 路并发 ──┐
                                                                                                                          │
                                                                                                                          ▼
                                                                                                                    Wave F 滚动收尾
```

不能跳跃；不能在 Wave A 没冻 contracts 之前并发 spawn 子 agent。

---

## Handoff 模板

把工作交给另一个 agent 时，在本文件追加：

```md
### Handoff: <wave>.<track> / <日期>

Owner（交付方）：
Status：done / needs review / blocked
Touched files：
Public types changed：（无 / 列具体名）
Atoms added/changed：（无 / 列 debugLabel）
Tests run：（jest summary，pass count）
Known risks：
Next request：
```

---

## 子 agent 分派操作要点（CC 视角）

- 一次 wave 内的多 track **必须用一条消息里并列多个 `Agent` tool 调用**，确保真正并发跑（不是排队）。
- 每个子 agent 的 prompt 必须包含：
  - 它的 track 名称（`Wave B / B2` 这种）
  - 文件边界白名单（防止越界改 sibling track 的文件）
  - 公共契约的 import 路径（让它认得 `Value` / `EvalContext` / `FunctionImpl`）
  - 完成标准（哪些 jest spec 必须绿）
  - 完成后必须更新本文件的 in-flight 看板（否则下一波看不到状态）
- 子 agent **不允许调起 codex 或别的子 agent**。需要 review 的时候交回 CC，由主线统一调度。

---

## 反爬陷阱（写之前过一遍）

- 看到任何 "per-cell atom"、"cellAtom factory" 的诱惑 → 停。整张表一个 sheetAtom（ARCH §2.3）。
- 写 evaluator 时打算在 ref-lookup 里 `get(...)` → 停。evaluator 只 `get(sheetAtom)` 一次，剩下走普通 `Map.get`（ARCH §4）。
- 想在 vanilla/core 上面加 cycle 检测层 → 停。守卫在 evaluator 内部 `currentlyEvaluating` set（ARCH §5）。
- 想给 `NOW()` 加一个 `volatileFlagAtom` → 停。`recalc()` 直接 `set(sheetAtom, new Map(prev))` 触发广播（ARCH §7）。
- 想偷偷在 `@einfach/excel-core-ts` 里 import solid / DOM / worker → 停。架构层有明文禁令，CI 之外的 grep 也会被 review 抓出来。

---

## 调度建议（首次落地）

按下面的顺序投放代理，能在两到三周内推进到"TS worker 跑通基础 demo"：

1. **第 1 天**：CC 单 agent 跑 Wave A 全部。
2. **第 2-4 天**：CC 一次性 spawn 3 个并发子 agent 跑 Wave B（B1/B2/B3）。中间 Codex 做一次 review。
3. **第 5-9 天**：CC 一次性 spawn 5 个并发子 agent 跑 Wave C，CC 主线合 `index.ts`。中间 Codex 抽样几个函数做精度 review。
4. **第 10-12 天**：CC 接 Wave D（1-2 agent 串行 / 部分并行）。Codex 走 MCP playwright 烟测。
5. **第 13-21 天**：CC spawn 4 个并发子 agent 跑 Wave E。再上一轮 Codex review。
6. **第 22 天起**：Wave F 滚动批，按需展开。

如果哪个 wave 出现延迟（function 实现 bug 多），优先**保住下一 wave 的并发度**而不是抓完美 —— 函数细节可以在 Wave F 阶段补完。
