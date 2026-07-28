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
| 2026-05-26 | CC | docs (PLAN / ARCH / 本文档) | done | `excel/excel-core-ts/docs/*.md` | — |
| 2026-05-26 | CC | Wave A — package skeleton + contracts | done | `excel/excel-core-ts/{package.json,tsconfig.json,src/types.ts,src/index.ts,test/types.test.ts,README.md}` + root `tsconfig.json` + `jest.config.mjs` moduleNameMapper | Spawn Wave B's 3 tracks (B1 parser / B2 workbook+evaluator skeleton / B3 refs+a1+ranges) |
| 2026-05-26 | B1 agent | Wave B / B1 — parser | done | `excel/excel-core-ts/src/parser/{tokenizer,parser,index}.ts`, `excel/excel-core-ts/test/parser.test.ts`, single-line append to `excel/excel-core-ts/src/index.ts` (`parseFormula` re-export) | hand off to B2 evaluator for AST consumption |
| 2026-05-26 | B3 agent | Wave B / B3 — refs / a1 / ranges | done | `excel/excel-core-ts/src/refs/{a1,ranges,index}.ts`, `excel/excel-core-ts/test/refs.test.ts`, append to `excel/excel-core-ts/src/index.ts` (refs re-exports) | unblocks B1 ref parsing + B2 refLookup + Wave C range fns |
| 2026-05-26 | B2 agent | Wave B / B2 — workbook + evaluator skeleton | done | `excel/excel-core-ts/src/{workbook,sheet}.ts`, `excel/excel-core-ts/src/eval/{evaluate,coerce,index}.ts`, `excel/excel-core-ts/test/{workbook,evaluate}.test.ts`, replace staged `Workbook`/`WorkbookSheet` in `src/types.ts` + append runtime exports to `src/index.ts` | hand off to Wave C function registry |
| 2026-05-26 | C2 agent | Wave C / C2 — logical functions | done | `excel/excel-core-ts/src/eval/functions/logical.ts`, `excel/excel-core-ts/test/logical.test.ts` | wait for sibling C1/C3/C4/C5; CC main session merges `functions/index.ts` registry |
| 2026-05-26 | C4 agent | Wave C / C4 — text functions | done | `excel/excel-core-ts/src/eval/functions/text.ts`, `excel/excel-core-ts/test/text.test.ts` | wait for sibling C1/C3/C5; CC main session merges `functions/index.ts` registry |
| 2026-05-26 | C1 agent | Wave C / C1 — math functions | done | `excel/excel-core-ts/src/eval/functions/math.ts`, `excel/excel-core-ts/test/math.test.ts` | wait for sibling C2/C3/C4/C5; CC main session merges `functions/index.ts` registry |
| 2026-05-26 | C3 agent | Wave C / C3 — lookup functions | done | `excel/excel-core-ts/src/eval/functions/lookup.ts`, `excel/excel-core-ts/test/lookup.test.ts` | wait for sibling C1/C2/C4/C5; CC main session merges `functions/index.ts` registry |
| 2026-05-26 | C5 agent | Wave C / C5 — date + stats functions | done | `excel/excel-core-ts/src/eval/functions/date.ts`, `excel/excel-core-ts/src/eval/functions/stats.ts`, `excel/excel-core-ts/test/date.test.ts`, `excel/excel-core-ts/test/stats.test.ts` | CC main session merges `functions/index.ts` registry — all C1..C5 tracks now done |
| 2026-05-26 | E3+E4 agent | Wave E / E3 — LAMBDA in evaluator + Wave E / E4 — custom formula e2e verify | done | `excel/excel-core-ts/src/types.ts` (add `lambdaScope?` to `EvalContext`, additive), `excel/excel-core-ts/src/eval/evaluate.ts` (`call` + `name` arms wire LAMBDA scope + dispatch), `excel/excel-core-ts/test/lambda.test.ts` (new — 16 specs), `excel/solid-excel/test/excel-core-ts-custom-formulas.test.ts` (new — 9 specs against `worker-runtime-ts`) | hand off — Wave E1 (spill) / E2 (cross-sheet) remain; F2 e2e migration unblocked for LAMBDA/custom-formula scenarios |
| 2026-05-26 | CC | Wave E / E1 — spill arrays + array functions | done | `excel/excel-core-ts/src/eval/functions/array.ts` (new — SEQUENCE/TRANSPOSE/SORT/FILTER/UNIQUE), `excel/excel-core-ts/test/array.test.ts` (new — 24 specs), `excel/excel-core-ts/src/eval/functions/index.ts` (registry merge), `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts` (spill projection helper + readCellValue collapse), `excel/solid-excel/test/excel-core-ts-spill.test.ts` (new — 3 specs) | Wave E complete (E2 cross-sheet was already done by B2) — F2 e2e migration now fully unblocked |
| 2026-05-26 | F1 agent | Wave F / F1 — function fill-out (info / financial / math+ / text+) | done | `excel/excel-core-ts/src/eval/functions/info.ts` (new — 8 fns), `excel/excel-core-ts/src/eval/functions/financial.ts` (new — 10 fns), `excel/excel-core-ts/src/eval/functions/math.ts` (append CEILING/FLOOR/TRUNC/SUMPRODUCT/PRODUCT — +5 fns), `excel/excel-core-ts/src/eval/functions/text.ts` (append SEARCH/FIND — +2 fns), `excel/excel-core-ts/src/eval/functions/index.ts` (register info + financial), `excel/excel-core-ts/test/info.test.ts` (new — 31 specs), `excel/excel-core-ts/test/financial.test.ts` (new — 37 specs), `excel/excel-core-ts/test/math.test.ts` (append CEILING/FLOOR/TRUNC/SUMPRODUCT/PRODUCT — +24 specs), `excel/excel-core-ts/test/text.test.ts` (append SEARCH/FIND — +15 specs) | total built-in function count now 82 across 8 files; F1 second batch ready for spawn (more info/financial/text/date/stats/lookup follow-ons) |
| 2026-05-26 | F2 agent | Wave F / F2 — TS-backend e2e parity probe | done | `excel/solid-excel/e2e/vnext-worker-ts.spec.ts` (new — single side-by-side spec, 3 active + 2 fixme) | Filed spill-projection-via-readSparseRange regression (see Handoff below); LAMBDA host-UI gap noted; full e2e suite migration is still F2-followup scope, not blocked by this probe |
| 2026-05-27 | F-LAMBDA agent | Wave F follow-up — LAMBDA host-UI surface in the Name Manager | done | `excel/spreadsheet-ui-core/src/named-ranges/types.ts` (extend `NamedRangeRefersTo` with `kind:'lambda'` variant), `excel/spreadsheet-ui-core/src/named-ranges/index.ts` (5 atom-backed dialog drafts: kind / params / name / scope / refersTo), `excel/spreadsheet-ui-core/src/go-to/types.ts` (widen `NamedRangeLite.refersTo` so `NamedRange` stays assignable — Go-To silently skips lambdas), `excel/solid-excel/src-vnext/named-ranges/SpreadsheetNameManagerDialog.tsx` (kind selector + params input; per-instance state migrated from `createSignal` locals to `@einfach/core` atoms per Solid 1.9.12 Provider memory), `excel/solid-excel/src-vnext/adapter/worker-protocol.ts` (`NameBindingWire` union + `defineName` / `undefineName` on `WorkerWorkbookClient`), `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts` (`defineName` / `undefineName` dispatch — parses lambda body via `parseFormula`, recalc-fires on success; mutating-cmd list updated), `excel/solid-excel/src-vnext/adapter/worker-runtime.ts` (wasm worker gracefully refuses `defineName` / `undefineName` with `NAME_BINDING_UNSUPPORTED`), `excel/solid-excel/src-vnext/adapter/worker-workbook-backend.ts` (forwards `setNamedRange` / `deleteNamedRange` to the worker, swallows `NAME_BINDING_UNSUPPORTED` + `UNKNOWN_COMMAND` so range/value cache still works on wasm), `excel/solid-excel/src/i18n/locales/{en,zh}.ts` (kind / params / lambdaBody / paramsRequired strings), `excel/solid-excel/test/excel-core-ts-lambda-ui.test.ts` (new — 10 specs), `excel/solid-excel/e2e/vnext-worker-ts-lambda.spec.ts` (new — 2 specs, replaces the `test.fixme` in `vnext-worker-ts.spec.ts`), test fakes in `excel/solid-excel/test/{vnext-adapter,worker-workbook-store}.test.ts` extended | TS worker handles LAMBDA end-to-end; wasm worker refuses gracefully (range/value still work on both backends via the host-side `namedRanges` cache); existing `name-refers-to` / `name-save-button` testids preserved for back-compat |
| 2026-05-27 | perf-bench agent | Wave F follow-up — TS vs WASM perf bench | done | `excel/solid-excel/test/perf-ts-vs-wasm.bench.ts` (new — in-process bench against both `createWorkerRuntimeTs()` and `WasmWorkbook`, gated on `EINFACH_PERF=1`, `.bench.ts` suffix keeps it out of default `testMatch`), `excel/solid-excel/test/perf-ts-vs-wasm-report.md` (new — auto-written by bench `afterAll` between `<!-- BENCH:RESULTS:* -->` markers) | TS is **faster** than WASM on every phase at all 3 sizes — Tiny ~0.1-1×, Medium ~0.02-0.62×, Large ~0.01-0.46× (TS/WASM). The big surprise: TS bulkApply install is 40-73× **faster** than WASM `bulk_import_cells` (66 ms vs 4.7 s at 100k cells × 50k formulas), because TS's broad-invalidation model (PLAN.md §4.1) needs no per-cell dep-graph update at install time, whereas Rust's `WorkbookLoader::flush` walks the dep index for every formula. PLAN.md §2's "TS ~3-10× slower" assumption needs revisiting — the actual perf wall is at recalc time, where TS still wins ~2× because read-back amortizes the lazy eval evenly. Recalc on Large is 2.1 s TS vs 4.6 s WASM. Bench wall-clock 22.5 s, well within prompt budget. Invocation: `EINFACH_PERF=1 npx jest --testRegex 'perf-ts-vs-wasm\.bench\.ts$' --no-coverage` (filename suffix means default `npx jest` ignores it). |

### Handoff: F-LAMBDA / 2026-05-27

Owner: F-LAMBDA agent (CC subagent)
Status: done

Touched files:
- `excel/spreadsheet-ui-core/src/named-ranges/types.ts` (extend `NamedRangeRefersTo`)
- `excel/spreadsheet-ui-core/src/named-ranges/index.ts` (atom drafts)
- `excel/spreadsheet-ui-core/src/go-to/types.ts` (widen `NamedRangeLite`)
- `excel/solid-excel/src-vnext/named-ranges/SpreadsheetNameManagerDialog.tsx` (kind selector + params; atom-backed)
- `excel/solid-excel/src-vnext/adapter/worker-protocol.ts` (`NameBindingWire` + RPC method)
- `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts` (defineName/undefineName dispatch)
- `excel/solid-excel/src-vnext/adapter/worker-runtime.ts` (wasm graceful refusal)
- `excel/solid-excel/src-vnext/adapter/worker-workbook-backend.ts` (forward to worker)
- `excel/solid-excel/src/i18n/locales/{en,zh}.ts` (i18n keys)
- `excel/solid-excel/test/{vnext-adapter,worker-workbook-store}.test.ts` (fake-client stubs)
- `excel/solid-excel/test/excel-core-ts-lambda-ui.test.ts` (new — 10 specs)
- `excel/solid-excel/e2e/vnext-worker-ts-lambda.spec.ts` (new — 2 specs)

Public types changed:
- `NamedRangeRefersTo` gains a `{ kind: 'lambda'; params: string[]; body: string }` variant. Existing consumers that exhaustively switched on `kind` will need a `lambda` arm (Go-To already gates on `'range'` so it skips silently — no behavioural change).
- `NamedRangeLite.refersTo` widens to mirror `NamedRangeRefersTo` (additive — `NamedRange` is structurally assignable).
- `WorkerWorkbookClient` gains `defineName(name, NameBindingWire)` and `undefineName(name)`. Test fakes need to be extended.

Atoms added: `nameManagerKindDraftAtom`, `nameManagerParamsDraftAtom`,
`nameManagerRefersToDraftAtom`, `nameManagerNameDraftAtom`,
`nameManagerScopeDraftAtom` (all `spreadsheet.namedRanges.*Draft`
debugLabel-prefixed). The dialog now resets these atoms on the
closed→open edge, replacing the prior `createSignal` locals — closes the
Solid 1.9.12 Provider remount window for this dialog even though the
underlying bug is resolved (`2b7d65e`).

Tests run:
- `npx jest excel/solid-excel/test/excel-core-ts-lambda-ui --no-coverage` → 10/10 pass
- `npx jest --no-coverage` → 2628/2628 pass (no regressions)
- `npx playwright test e2e/vnext-worker-ts-lambda.spec.ts` → 2/2 pass
- `npx playwright test e2e/vnext-worker-ts.spec.ts e2e/toolbar-name-manager.spec.ts e2e/vnext-worker-ts-lambda.spec.ts` → 11 pass + 1 pre-existing `test.fixme` skipped
- `npx tsc -b` clean

Known risks / follow-ups:
- The `test.fixme` in `vnext-worker-ts.spec.ts:166` ("LAMBDA registration round-trips through the TS worker (no host UI surface yet)") is now testable but was not modified (file boundary). A follow-up wave can remove the fixme and either drop the placeholder or extend it with additional assertions.
- The wasm worker's `defineName` refusal is structural (`NAME_BINDING_UNSUPPORTED`). If a future host wants range/value bindings to ALSO route through the engine on wasm, the `excel/rust/excel-core` side needs `defineName` support; until then range/value resolution on the wasm backend remains host-cache-only (existing behaviour, no regression).
- `parseFormula` is total — it returns `{kind:'error', code:'#VALUE!'}` on parse failure instead of throwing. The worker handler now checks for `ast.kind === 'error'` and surfaces `INVALID_LAMBDA_BODY` so the host can show a meaningful error rather than silently storing a binding that always evaluates to `#VALUE!`.

### Handoff: A / 2026-05-26

Owner: CC
Status: done
Touched files:
- `excel/excel-core-ts/package.json` (new)
- `excel/excel-core-ts/tsconfig.json` (new)
- `excel/excel-core-ts/src/types.ts` (new — public contracts)
- `excel/excel-core-ts/src/index.ts` (new — re-exports)
- `excel/excel-core-ts/test/types.test.ts` (new — smoke)
- `excel/excel-core-ts/README.md` (new)
- `tsconfig.json` (added project reference)
- `jest.config.mjs` (added moduleNameMapper entry)

Public types changed: established (none broken — package is new).
Atoms added/changed: none yet (Wave B/B2 creates sheetAtom).
Tests run: `npx jest excel/excel-core-ts --no-coverage` → 7/7 pass; full regression on `excel/spreadsheet-ui-core` + `core/core` → 880/880 pass; `npx tsc -b excel/excel-core-ts` → clean.

Known risks:
- `Workbook` / `WorkbookSheet` are staged as `unknown` so D-track agents can name them — Wave B/B2 must replace these with real interfaces and update `src/index.ts`.
- The smoke test pins discriminator strings (e.g. `kind: 'crossSheet'`) — Wave B/B1 parser must emit those exact tags.

Next request: spawn 3 concurrent Agent calls for Wave B (B1/B2/B3) with file boundary white-lists per `## Wave 划分 → Wave B` section above.

状态值与原 `spreadsheet-ui-core/AGENT_COLLABORATION.md` 一致：`planned` / `in progress` / `needs review` / `blocked` / `done`。

---

## 角色分工

**CC（implementer agent）** 主力做：
- `excel/excel-core-ts/src/*` 实现
- `excel/excel-core-ts/test/*` jest 单测
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
| **A1** package skeleton | 1 agent | `package.json`、`tsconfig.json`、`jest.config.js`、`src/index.ts` 空 export | `npx jest excel/excel-core-ts` 跑 0 个 spec 不报错；`tsc -b` 干净 |
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
| **B2** workbook + sheetAtom + 求值骨架 | agent #2 | `src/workbook.ts`、`src/sheet.ts`、`src/eval/evaluate.ts`（只实现算术 + 字面量，函数全部 throw `#NAME?`）、`test/workbook.test.ts` | `Workbook.setCell` / `Workbook.formulaCellAtom(key)` 跑通；core/core sub 链路验证；`=1+2*3` → 7、`=A1+B1` 跨 cell 引用 |
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

依赖 Wave C done（至少 C1/C2 done，演示用得到 SUM/IF 即可）。本 wave 是 cross-package，回到 `excel/solid-excel/`。

| Task | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **D1** worker runtime | 1 agent | `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts`、`excel/solid-excel/src-vnext/adapter/worker-factory.ts`（追加 ts 分支） | postMessage 解码 / 回包；保持与现有 wasm runtime 相同 backend port 行为；jest 单测 |
| **D2** 新 demo + URL flag | 同一 agent | `excel/solid-excel/src-vnext/demos/VNextWorkerTsDemo.tsx`、`excel/solid-excel/src/main.tsx` 注册 | 浏览器访问 `?backend=ts` 切到 TS worker；MCP playwright smoke：seed 一个公式 `=SUM(A1:A3)` 显示正确 |

完成后**Codex 走 MCP playwright** 全流程烟测（同时跟 wasm demo 比对几个 demo），按 memory `feedback_ui_smoke.md` 的纪律。

---

### Wave E — 功能对齐 4 路并发（4 agent，1-1.5 周）

依赖 Wave D done。四条 track 都不冲突，可同时开。

| Track | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| **E1** spill 数组 + range 函数 | agent #1 | `src/eval/spill.ts`、`src/refs/ranges.ts` 扩展、`test/spill.test.ts` | TRANSPOSE / SEQUENCE / SUMPRODUCT；anchor cell 持 `{kind:'array'}`；renderer index 在 Wave F1 接线 |
| **E2** 跨表引用 | agent #2 | `src/refs/crossSheet.ts`、`src/workbook.ts` 扩 sheetName 索引、`test/cross-sheet.test.ts` | `Sheet2!A1`、`Sheet2!A1:B10`；evaluator 自动 `get(otherSheetAtom)` 登记跨表 dep |
| **E3** 命名范围 + LAMBDA | agent #3 | `src/names.ts`、`src/eval/lambda.ts`、`test/names.test.ts` | DEFINED.NAME 一个、LAMBDA 一个、范围名引用一个 |
| **E4** 自定义公式 port | agent #4 | `src/custom.ts`、`test/custom.test.ts`；以及 `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts` 的 register 桥（须协调 D1 的 owner） | 现有 `custom-formulas.spec.ts` 切到 TS worker 全绿；同步标量、范围参数（2D array）、错误传播都覆盖 |

E4 与 D1 共用一个文件 `worker-runtime-ts.ts`。**E4 owner 必须在 in-flight 看板上 `needs review` 阶段 ping D1 owner**，避免合入冲突。

---

### Wave F — 函数填充 + 切换（mostly sequential）

| Task | Owner | 说明 |
| --- | --- | --- |
| **F1** 函数扩到 ~200 | 多 agent 滚动批 | 每批 10-20 个函数，跟 Wave C 同模式扇出；不再列单条 acceptance，按 Rust eval.rs 的 spec 一对一 port + jest 对照 |
| **F2** e2e 套件迁移 | 1 agent | `excel/solid-excel/e2e/*` 所有 demo / formula spec 切到 `?backend=ts` 跑；记下 diff，回灌 fix |
| **F3** ~~flip 默认~~ → 双 backend 矩阵 | 2 并发 agent + 主线 audit | **完成 2026-05-27**。原计划 flip 默认被 codex blocked，改为做 dual-project：`?backend=ts\|wasm` URL routing + `playwright.config.ts` 两个 project。WASM 留作默认（保护既有用户），TS 通过 query 显式选；e2e 在两个 project 上都跑。**`?backend=wasm` / excel/rust/excel-core / excel/rust/wasm / excel/solid-excel/wasm-pkg / build:wasm 脚本 / wasm-pack toolchain 全保留不动**。 |

**显式不做**：删除 excel/rust/excel-core 或任何 wasm 产物。两条路径长期共存。

F3 实际产出（2026-05-27 commit 待定）：
1. `excel/excel-core-ts/src/{sheet,workbook}.ts` — 真正的 `debugFormulaCacheState` / `EvalCount` / `Count`
2. `worker-runtime-ts.ts` — 调真实现，不再 stub
3. `VNextWorkerDemo.tsx` — 读 `?backend=` URL 选 factory
4. `playwright.config.ts` — `wasm` / `ts` 两个 project
5. `e2e/helpers.ts` — `gotoRoot` 保留 project query
6. `e2e/BACKEND_PARITY.md` — 双 backend 矩阵
7. `vite.config.ts` — alias `@einfach/excel-core-ts` 到 src（codex 二次 review 找到的 P2 修复，否则 worker bundle 用旧 esm/ 出错）

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
- 想在 core/core 上面加 cycle 检测层 → 停。守卫在 evaluator 内部 `currentlyEvaluating` set（ARCH §5）。
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

---

### Handoff: B.B1 / 2026-05-26

Owner（交付方）: B1 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/parser/tokenizer.ts` (new — `Token` union + `tokenize`)
- `excel/excel-core-ts/src/parser/parser.ts` (new — Pratt parser + `ParseError`)
- `excel/excel-core-ts/src/parser/index.ts` (replaced the Wave B/B2 stub — `parseFormula`/`tokenize`/`parseTokens`/`ParseError` re-exports)
- `excel/excel-core-ts/test/parser.test.ts` (new — 102 specs)
- `excel/excel-core-ts/src/index.ts` (single-line append: `export { parseFormula } from './parser'`)

Public types changed: none. Parser consumes `Expr` from `../types` verbatim — no contract drift.
Atoms added/changed: none (parser is pure).
Tests run:
- `npx jest excel/excel-core-ts/test/parser --no-coverage` → 102/102 pass.
- `npx jest excel/excel-core-ts --no-coverage` → 196/196 pass (includes B3 refs suite + Wave A types smoke).
- Isolated `tsc --noEmit` over `src/parser/*.ts` + `test/parser.test.ts` → clean.
- `npx tsc -b excel/excel-core-ts` → still reports the two pre-existing errors in `src/eval/evaluate.ts` (`toBoolean` unused) and `src/sheet.ts` (`Expr` unused) — both **outside the B1 file whitelist**. B2 owns those.

Known risks / deviations:
- Tokenizer cap on column letters is 3 (`XFD`). Anything 4+ letters becomes a `name`. Matches Excel's documented max but means a hypothetical 4-letter column would mis-parse — non-issue for v1.
- `parseFormula` returns `{kind:'error', code:'#NAME?'}` for empty/whitespace-only input (per task spec). Tokenizer-error and structural-error inputs collapse to `#VALUE!`.
- `BLANK` is **not** emitted by the parser — leading `=` with no body still produces `#NAME?`, consistent with the task brief.
- Sheet-prefix identifiers are tokenized into two tokens (`sheet-prefix` + `bang`); evaluator side never sees the raw `!` token because the parser folds them inside `parseCrossSheet`.
- Right-assoc `^` binding powers are `(60, 59)`; postfix `%` uses bp `55` so `1+2%` parses as `1 + (2%)` (matches Excel).
- Inline array literals enforce rectangular rows at parse time (mismatched row width → `#VALUE!`). Excel also enforces this but at evaluation time; behavior is observationally identical for callers.

Next request: B2 (evaluator) can now `import { parseFormula } from '@einfach/excel-core-ts'` (or directly from `'../parser'`) to populate `Cell.ast`. The 13 Expr discriminator strings in `src/types.ts` §5 are all exercised by tests in the `Expr kind coverage tripwire` block — if B2 needs to change a tag it will be caught immediately.

---

### Handoff: B.B3 / 2026-05-26

Owner（交付方）: B3 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/refs/a1.ts` (new — `parseA1` / `formatA1` / `colNameToIndex` / `colIndexToName` + `EXCEL_MAX_COL` / `EXCEL_MAX_ROW`)
- `excel/excel-core-ts/src/refs/ranges.ts` (new — `parseRange` / `parseRangeString` / `normalizeRange` / `iterateRange` / `expandRange` / `rangeContains` / `rangesIntersect` / `cellKey` + `RangeTooLargeError`)
- `excel/excel-core-ts/src/refs/index.ts` (new — barrel)
- `excel/excel-core-ts/test/refs.test.ts` (new — 87 specs)
- `excel/excel-core-ts/src/index.ts` (append-only: refs re-exports added alongside B1's `parseFormula` re-export — no conflict)

Public types changed: none broken. **New surface** (additive, no upstream impact):
- Constants: `EXCEL_MAX_COL = 16383`, `EXCEL_MAX_ROW = 1048575`, `EXPAND_MAX_CELLS = 100_000`.
- `class RangeTooLargeError extends Error { range: CellRange; cellCount: number }`.
- `interface ParsedA1 { row, col, absRow, absCol }`, `interface FormatA1Input { row, col, absRow?, absCol? }`.
- Functions:
  - `colNameToIndex(name: string): number` ('A'→0, 'XFD'→16383, returns -1 on bad input).
  - `colIndexToName(idx: number): string` (throws `RangeError` for out-of-bounds — internal helper).
  - `parseA1(a1: string): ParsedA1 | null` (handles `A1` / `$A$1` / `$A1` / `A$1` / lowercase / boundary `XFD1048576`; null on malformed).
  - `formatA1(coord: FormatA1Input): string` (round-trip inverse of `parseA1`; emits `$` markers; throws `RangeError` on OOB).
  - `cellKey(coord: CellCoord): CellKey` (`${row}:${col}` — canonical Map key, **single source of truth** for B1/B2/Wave C).
  - `parseRange(start, end): CellRange | null` (both endpoints same shape: cell+cell / row+row / col+col; mixed shapes → null; auto-normalized).
  - `parseRangeString(text): CellRange | null` (splits on `:`, rejects multi-colon).
  - `normalizeRange(range): CellRange` (idempotent, swaps inverted start/end).
  - `iterateRange(range): IterableIterator<CellCoord>` (uncapped generator, row-major; safe for whole-column ranges).
  - `expandRange(range): CellCoord[]` (capped at `EXPAND_MAX_CELLS`; throws `RangeTooLargeError` past it).
  - `rangeContains(range, coord): boolean`, `rangesIntersect(a, b): boolean` (both inclusive, both auto-normalize).

Atoms added/changed: **none** (B3 is a pure-function module by mandate — no `@einfach/core` import).

Tests run:
- `npx jest excel/excel-core-ts/test/refs --no-coverage` → **87/87 pass** (target was 50+).
- `npx jest excel/excel-core-ts --no-coverage` → **196/196 pass** (full package: 87 refs + 102 parser + 7 types smoke).
- Isolated tsc over `src/refs/*.ts` + the new `src/index.ts` re-exports → clean.
- `npx tsc -b excel/excel-core-ts` still reports the same two pre-existing errors in B2's dirty files (`src/sheet.ts:26` unused `Expr`, `src/eval/evaluate.ts:41` unused `toBoolean`) — both outside the B3 whitelist; left for B2.

Known risks / TODOs left in code:
- `parseRange('A1','B')` (anchored-open ranges like `A1:A` or `A:A1`) returns `null`. Excel accepts these; out of scope for v1. Inline `TODO(B3)` comment in `src/refs/ranges.ts`. The parser layer (B1) already rejects these at tokenization so they never reach `parseRange` today.
- `parseRangeString` does **not** strip cross-sheet prefixes (`Sheet2!A1:B10`). That's the parser/B1 concern; refs only sees the post-prefix slice.
- Whitespace around the colon (`A1 : B10`) is rejected. Excel formulas are whitespace-strict; B1 pre-trim if needed.
- Absolute markers (`$`) are tolerated in range endpoints but **discarded** when forming the `CellRange` (the underlying coord is the same regardless). Preserving absolute-ness through range expansion would be an AST/parser concern, not a refs concern.

Next request: B1 + B2 can now import from `'../refs'` (or `'@einfach/excel-core-ts'`) for ref parsing and range materialization. Wave C math/stats/lookup should prefer `iterateRange` for streaming and reserve `expandRange` for cases with a guaranteed-bounded selection.

---

### Handoff: B.B2 / 2026-05-26

Owner（交付方）: B2 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/workbook.ts` (new — `createWorkbook`, `Workbook` interface, mutation API, `recalc`, name/custom registries)
- `excel/excel-core-ts/src/sheet.ts` (new — `createSheet`, `WorkbookSheet` interface, per-sheet `sheetAtom`, lazy `formulaCellAtom` factory, `keyFor`, `applyCell`)
- `excel/excel-core-ts/src/eval/evaluate.ts` (new — `evaluate`, `refLookupGeneric`, `rangeLookupGeneric`, `cycleGuardKey`, A1 thin shims)
- `excel/excel-core-ts/src/eval/coerce.ts` (new — `toNumber` / `toString` / `toBoolean` / `propagateError`, Excel coercion rules)
- `excel/excel-core-ts/src/eval/index.ts` (new — barrel)
- `excel/excel-core-ts/test/workbook.test.ts` (new — 20 specs)
- `excel/excel-core-ts/test/evaluate.test.ts` (new — 21 specs)
- `excel/excel-core-ts/src/types.ts` (edit — section 9 replaced: `Workbook` / `WorkbookSheet` now `export type … from './workbook' / './sheet'`; **all earlier sections unchanged** — `Value`, `Cell`, `Expr`, `SheetMutation`, `EvalContext`, `FunctionImpl`, `NameBinding`, `BinaryOp`, `ErrorCode` field/discriminator names stable)
- `excel/excel-core-ts/src/index.ts` (append-only: `createWorkbook` + `createSheet` + `keyFor` + `applyCell` + `evaluate` + coerce helpers + `parseRefToKey/Coord` re-exports)

Public types changed:
- `Workbook` and `WorkbookSheet` finalized — now real interfaces (replaces the Wave A `unknown` stage). Re-exports kept on `'./types'` so any earlier B3/D import path stays valid.
- **Additive surface** (new, no upstream break):
  - `interface Workbook { store, sheets, sheet, sheetByName, setCell, clearCell, bulkApply, setFormat, recalc, defineName, undefineName, registerCustomFormula, unregisterCustomFormula }`
  - `interface WorkbookSheet { id, name, sheetAtom, formulaCellAtom(key) }`
  - `interface CreateWorkbookOptions { parser?, store? }`, `interface SheetSeed { id, name }`, `interface BulkCellInput { row, col, input }`
  - `interface SheetResolvers { crossSheetCells, callCustom, resolveName }`
  - `type SheetState = ReadonlyMap<CellKey, Cell>`
  - `CoerceResult<T> = CoerceOk<T> | CoerceErr`
  - `function cycleGuardKey(cells, key): CellKey` (for callers that seed the cycle set before invoking `evaluate` directly)

Atoms added/changed:
- One `sheetAtom` per sheet, `debugLabel = 'excel-core.sheet.<id>.cells'`, holds `ReadonlyMap<CellKey, Cell>`. Writable.
- Lazy `formulaCellAtom(key)` derives, cached per (sheet, key); `debugLabel = 'excel-core.sheet.<id>.formulaCell.<key>'`. Read-only.
- **No per-cell, per-row, or per-column atom families** (PLAN §4.1 honored).
- **The derive registers exactly ONE dep on its own `sheetAtom` per run** (plus one dep per referenced cross-sheet's atom via `crossSheetCells`). The `cells` snapshot is captured once at the top of the derive; subsequent ref/range lookups walk that Map with `Map.get` (ARCH §4).

Tests run:
- `npx jest excel/excel-core-ts/test/workbook excel/excel-core-ts/test/evaluate --no-coverage` → **41/41 pass** (20 workbook + 21 evaluate).
- `npx jest excel/excel-core-ts --no-coverage` → **237/237 pass** (full package: 87 refs + 102 parser + 41 B2 + 7 types smoke).
- `npx tsc -b excel/excel-core-ts` → **clean** (no diagnostics).
- `npx jest core/core excel/spreadsheet-ui-core --no-coverage` → **880/880 pass** (no regression).

Coverage of the prompt's required cases:
- `=1+2*3 → 7`: `evaluate.test.ts` "literals + arithmetic" block.
- `=A1+B1` with A1=10, B1=20 → 30: `evaluate.test.ts` "refs against a seeded snapshot" + `workbook.test.ts` formula-derive block (uses real parser).
- `=A1*B1` short-circuits to `#REF!` when A1 holds `{kind:'error', code:'#REF!'}`: both test files.
- cycle A1=B1+1, B1=A1+1 → `#CIRCULAR!`: both test files; cross-sheet cycle false-collision avoided by `cycleGuardKey` tagging.
- recalc bumps the atom: `workbook.test.ts` recalc block (asserts fresh Map identity after `recalc()`).
- `setCell` + `formulaCellAtom` round-trip via core/core's `sub`: `workbook.test.ts` "formulaCellAtom" block (subscribes, mutates A1, observes B1 derive output).

Known risks / TODOs left in code:
- `defineName` is a synchronous map; mutating a name does **not** automatically invalidate formulas referencing it. Wave E will replace with an atom-backed registry. For now callers needing live name-driven invalidation should call `recalc()`.
- `evaluator.evaluate` handles `call` by trying `ctx.callCustom`, falling through to `#NAME?`. Wave C's function registry will own the built-in branch.
- `evaluator.evaluate` for `NameBinding.kind === 'lambda'` returns `#NAME?` — LAMBDA awaits Wave E.
- `rangeLookupGeneric` materializes full `Value[][]`. Whole-column / whole-row ranges are guarded by `RangeTooLargeError` → `#NUM!`. Wave E (range-fn streaming) will add an iterator path so SUM(A:A) doesn't fall over.
- Arithmetic on `{kind:'array'}` operands collapses to top-left scalar (Wave E adds broadcast). Comparison ops likewise.
- Format storage uses the shared `Cell.format` field (PLAN §2.2 alternative chosen for fewer atoms). `setFormat` over an empty range stamps blank cells carrying only format — matches the rust implementation's "format-only cell" concept.
- Parser injection (`createWorkbook(..., { parser })`) is a testing seam; production code uses the real `parseFormula` from `./parser`.
- The `cellsMapTags` WeakMap is module-scoped (one global counter for the package). Tags survive across workbook lifetimes; counter could theoretically wrap but at 1 alloc per sheet-snapshot per recalc that's a non-issue for any realistic session.

Next request: Wave C (5-way function-registry fanout) can wire `ctx.callCustom` and a built-in dispatcher inside `evaluate`'s `'call'` branch — same shape, just consults the built-in `Map<string, FunctionImpl>` first per AGENT_COLLABORATION.md §"Wave C". Workbook + sheetAtom + evaluator skeleton are done; Wave D can begin worker-shim work in parallel using the `Workbook` interface as the SpreadsheetBackend target.

---

### Handoff: C.C1 / 2026-05-26

Owner（交付方）: C1 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/eval/functions/math.ts` (new — 15 `FunctionImpl` exports + `FUNCTIONS` record)
- `excel/excel-core-ts/test/math.test.ts` (new — 88 specs)

Public types changed: none. Implementation strictly consumes `FunctionImpl` / `Value` / `EvalContext` from `../../types` and `propagateError` / `toNumber` from `../coerce` — zero contract drift.
Atoms added/changed: none (functions are pure, never read `ctx`).

Tests run:
- `npx jest excel/excel-core-ts/test/math --no-coverage` → **88/88 pass** (target was 60+).
- `npx jest excel/excel-core-ts --no-coverage` → **386/386 pass** (full package: 88 math + 84 logical + 87 refs + 102 parser + 20 workbook + 21 evaluate + smoke + types).
- Isolated `tsc --noEmit` over `src/eval/functions/math.ts` + `test/math.test.ts` → clean.
- `npx tsc -b excel/excel-core-ts` → reports **one pre-existing error in `src/eval/functions/lookup.ts:37`** (`'err' declared but never read`) — outside the C1 whitelist; C3 owns that file. No new diagnostics from C1.

Functions implemented (15/15): SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, ROUND, ROUNDUP, ROUNDDOWN, INT, MOD, ABS, POWER, SQRT, SIGN.

Excel semantics pinned (key rules covered by tests):
- **Aggregator scalar-vs-array split** (SUM / AVERAGE / MIN / MAX): scalar args coerce via `toNumber` (string `"5"` → 5, `TRUE` → 1); inside an array/range, strings + booleans + blanks are **ignored** silently. Errors propagate from both paths.
- **COUNT** only counts `kind: 'number'` (skip string-even-if-numeric-looking, skip boolean, skip blank); **COUNTA** counts every non-blank including errors-inside-arrays.
- **MIN/MAX** with no numeric values returns 0 (Excel quirk, not error).
- **ROUND** is half-away-from-zero (not JS's half-toward-positive-infinity); ROUNDUP is away-from-zero; ROUNDDOWN truncates toward zero. All three accept negative `digits` to round left of the decimal.
- **INT** floors toward negative infinity (so `INT(-8.9) = -9`).
- **MOD** uses `a - b * floor(a/b)` so the result's sign follows the divisor (Excel rule), not the dividend (JS `%`).
- **POWER**: `POWER(-2, 0.5)` → `#NUM!`; `POWER(0, 0)` → `#NUM!` (diverges from `Math.pow` which returns 1); `POWER(0, neg)` → `#DIV/0!`.
- **SQRT(-1)** → `#NUM!`.
- **Error short-circuit**: every function returns the first `kind: 'error'` positional arg verbatim before any coercion attempt (mirrors the dispatcher's default per `types.ts §8` discipline).

Known deviations / TODOs left in code:
- `ROUND(value)` (1-arg form) defaults `digits` to 0. Excel **requires** the second arg syntactically — this is an ergonomic extension that doesn't break any 2-arg call site. No TODO comment because the tests pin the behavior; if Codex review wants strict Excel parity, change the `args.length < 1 || args.length > 2` guard to `args.length !== 2` and update the 1-arg test.
- `MIN()` / `MAX()` with no args return `0` (Excel returns `0` too; matches). No TODO.
- Nested arrays inside aggregation walks are flattened recursively — Excel doesn't expose nested-array values via cells, but a future array-returning custom formula could, so the helper handles it.
- No interaction with `EvalContext`. Range materialization happens upstream in the evaluator (`rangeLookupGeneric`) — by the time args reach a math function they are already `{ kind: 'array' }` envelopes. If C3 lookup functions need to walk a range without materializing (Wave E streaming), they'll wire their own iterator; this file's helpers don't need to change.

Next request: CC main session, after all C tracks (C1/C2/C3/C4/C5) land, creates `src/eval/functions/index.ts` that imports each track's `FUNCTIONS` record and assembles the merged `Map<string, FunctionImpl>` consumed by the evaluator's `'call'` branch. C1's surface is `import { FUNCTIONS as MATH } from './math'`. No naming collisions with the other Wave C function sets (math vs logical vs lookup vs text vs date+stats are all disjoint by Excel's spec).

---

### Handoff: C.C2 / 2026-05-26

Owner（交付方）: C2 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/eval/functions/logical.ts` (new — IF, IFERROR, IFNA, AND, OR, NOT, IFS, SWITCH, TRUE, FALSE + `FUNCTIONS` registry export)
- `excel/excel-core-ts/test/logical.test.ts` (new — 61 specs)

Public types changed: none. Imports `FunctionImpl` / `Value` from `'../../types'` and `propagateError` / `toBoolean` from `'../coerce'` — no contract drift.

Atoms added/changed: none (pure functions).

Tests run:
- `npx jest excel/excel-core-ts/test/logical --no-coverage` → **61/61 pass** (target was 40+).
- `npx jest excel/excel-core-ts --no-coverage` → **386/386 pass** (full package; co-exists with C1 math suite, no regression in B1/B2/B3).
- `npx tsc -p excel/excel-core-ts/tsconfig.json --noEmit` → only pre-existing C3 lookup.ts diagnostic (`'err' is declared but its value is never read`, owned by C3). **No C2 errors.**

Semantic deviations from default error propagation (each pinned by ≥ 1 test):
- **IF**: only `cond` propagates; chosen branch is returned verbatim even if it's an error (test: `returns then-branch verbatim even if it is an error`).
- **IFERROR**: swallows ANY error in arg 0; passes blank through unchanged; returns `fallback` even if `fallback` itself is an error (3 dedicated tests).
- **IFNA**: only catches `#N/A`; other errors (`#DIV/0!`, `#REF!`, `#VALUE!`) pass through verbatim (3 dedicated tests).
- **AND/OR**: blanks are *ignored*, not coerced to false. All-blank + zero-arg both → `#VALUE!`. First-error-wins via `propagateError`.
- **NOT**: single-arg gatekeeper; arity ≠ 1 → `#VALUE!`.
- **IFS**: errors in *unreached* vals do NOT surface (test: `does NOT inspect unreached vals`). Odd-count args → `#N/A` after exhausting valid pairs.
- **SWITCH**: errors in cases beyond the match do NOT surface. Strings match case-insensitively; numbers strict; blank matches blank.
- **TRUE/FALSE**: zero-arg; extra args → `#VALUE!`.

Known Excel quirks NOT matched (documented for follow-up):
- **SWITCH blank-vs-zero**: Excel's arithmetic-equality treats blank as 0, so `=SWITCH("",0,"hit")` matches. We treat blank as a distinct case-kind (test: `matches blank to blank`); `SWITCH(BLANK, NUM(0), ...)` will NOT match. This is the more predictable choice and matches the Rust `eval.rs` behavior the port targets. If a future test fixture demands Excel-exact behavior, change `excelEquals` in `logical.ts` to coerce `blank` to `number(0)` when comparing.
- **IFS dangling-cond**: Excel surfaces a `#N/A` at evaluation time for odd-count args; we do the same. The Excel formula bar actually rejects the syntax pre-eval, but a constructed-AST path (e.g. via paste of a partial formula) lands here. Behavior pinned by test.
- **Array args**: AND/OR/NOT/IF/SWITCH currently inspect only the top-left scalar of `kind:'array'` operands (via `toBoolean` / `excelEquals`). Excel would broadcast / aggregate. Out of scope for v1; Wave E `spill.ts` will revisit.

Next request: CC main session can now register `FUNCTIONS` from `'./logical'` into the shared `src/eval/functions/index.ts` `Map<string, FunctionImpl>` alongside C1 math + C3 lookup + C4 text + C5 date/stats. No further C2 work expected unless an Excel-quirk test from Wave F surfaces a fixture mismatch.

---

### Handoff: C.C3 / 2026-05-26

Owner（交付方）: C3 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/eval/functions/lookup.ts` (new — `VLOOKUP` / `HLOOKUP` / `INDEX` / `MATCH` / `XLOOKUP` + `FUNCTIONS` registry)
- `excel/excel-core-ts/test/lookup.test.ts` (new — 56 specs)

Public types changed: none. Lookup functions consume only `Value` and `FunctionImpl` from `../../types` and helpers from `../coerce`.
Atoms added/changed: none (functions are pure).

Tests run:
- `npx jest excel/excel-core-ts/test/lookup --no-coverage` → **56/56 pass** (target 30+).
- `npx jest excel/excel-core-ts --no-coverage` → 566/567 pass (sole failure: `test/date.test.ts`, owned by C5 — outside C3 whitelist).
- `npx tsc -b excel/excel-core-ts` → clean for the C3 files (`src/eval/functions/lookup.ts`). Pre-existing diagnostics in `src/eval/functions/stats.ts` (C5 track) remain.

Coverage per function (acceptance was ≥ 6 fixtures each):
- **VLOOKUP** — 11 fixtures: exact-hit, exact-miss → #N/A, approximate (3 bucket cases), approximate below first → #N/A, wildcards (* and ?), case-insensitive, error propagation, col_index < 1 → #VALUE!, col_index > width → #REF!, wrong arity, escaped wildcards (`~*`).
- **HLOOKUP** — 8 fixtures: exact (2 rows), approximate, below first → #N/A, wildcards, not found → #N/A, error propagation, row_index < 1 → #VALUE!, row_index > height → #REF!.
- **INDEX** — 10 fixtures: 2-D row+col indexing, row_num=0 → whole column, col_num=0 → whole row, both 0 → whole array, 1-D row indexing, 1-D column indexing, out of bounds → #REF!, error propagation, scalar wrapped, negative → #VALUE!.
- **MATCH** — 11 fixtures: exact, exact wildcards, match_type 1 (largest <= 3 cases), match_type 1 default, match_type 1 below → #N/A, match_type -1 (desc, 2 cases), match_type -1 above → #N/A, not found → #N/A, error propagation, invalid match_type → #VALUE!, case-insensitive.
- **XLOOKUP** — 13 fixtures: exact hit (3 cases), exact miss → #N/A, exact miss with if_not_found (string + number sentinel), match_mode -1 (next smaller, 2 cases), match_mode 1 (next larger, 2 cases), match_mode 2 (wildcard, 2 cases), search_mode -1 (last-to-first), mismatched arrays → #VALUE!, error propagation (incl. if_not_found exception), case-insensitive, horizontal lookup_array, multi-column return, invalid match_mode → #VALUE!, invalid search_mode → #VALUE!.

Known risks / TODOs deliberately punted (inline `TODO(C3)` comments where punted):
- **XLOOKUP `search_mode = 2 | -2` (binary search)** — falls back to linear scan in the appropriate direction. Correct on sorted input, just slower than Excel's O(log n) path. Acceptance tests cover ≤ 20-element arrays so this is invisible at v1; Wave F can swap in a true binary search once a perf bench shows it matters. Marked with `TODO(C3)` in `findXLookupIndex` and `scanXLookupDesc`.
- **Approximate-match assumption (VLOOKUP/HLOOKUP/MATCH match_type=1)** — Excel docs say "if data isn't sorted, result is undefined". My impl is deterministic on sorted-ASC data (largest <= needle, scanning until first overshoot). On unsorted data my impl returns the largest seen before any overshoot — which is what Excel does in practice and matches the Rust `eval.rs` behavior. Documented in the file-level docstring.
- **Implicit dimension reduction in INDEX** — the rule "if `array` is 1-D and only one positional arg is given, the arg indexes within that line" is implemented for both single-row and single-column inputs. The edge case "1x1 array with INDEX(arr, 1)" returns the scalar; `INDEX(arr, 0)` (still 1x1) also returns the scalar (Excel returns the array). Tested via the "scalar wrapped" fixture.
- **XLOOKUP `if_not_found` error-propagation exception** — per the spec, `if_not_found` is the only positional that does NOT propagate errors (host may pass an error-like sentinel deliberately). The test pins this with `errDIV` in the `if_not_found` slot; positional 0/1/2/4/5 still propagate.
- **Compare semantics for blank vs other types** — blank compares equal to a `kind:'number'` zero in lookup contexts (`compareForLookup` line). Excel matches this in lookup tables. If a future fixture wants "blank is its own bucket", revisit.

Next request: CC main session merges `FUNCTIONS` from `'./lookup'` into the shared `src/eval/functions/index.ts` `Map<string, FunctionImpl>` alongside C1 math + C2 logical + C4 text + C5 date/stats. No further C3 work expected unless a Wave F e2e fixture exposes a parity gap with Rust `eval.rs`.

---

### Handoff: C.C4 / 2026-05-26

Owner（交付方）: C4 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/eval/functions/text.ts` (new — `FUNCTIONS` record for the 11 text functions)
- `excel/excel-core-ts/test/text.test.ts` (new — 79 specs across 11 describe blocks)

Public types changed: none. C4 consumes `Value`, `FunctionImpl`, `EvalContext` verbatim from `../../types` and `propagateError` / `toNumber` / `valueToString` from `../coerce`. Only new export is `FUNCTIONS: Record<string, FunctionImpl>`.

Atoms added/changed: **none** (function impls are pure value-in / value-out; ctx is unused inside text fns).

Tests run:
- `npx jest excel/excel-core-ts/test/text --no-coverage` → **79/79 pass** (target was 45+).
- `npx jest excel/excel-core-ts --no-coverage` → 520/521 pass; the one failure is in `lookup.test.ts` (sibling C3 track, outside C4 file whitelist).
- Isolated `tsc --noEmit` over `src/eval/functions/text.ts` + `test/text.test.ts` → clean.
- `npx tsc -b excel/excel-core-ts` → reports pre-existing errors in sibling tracks (`lookup.ts:37` unused `err`, `stats.ts:64` Value union narrowing, `stats.ts:227` unused `sameShape`) — all outside C4 whitelist; left for C3/C5 owners.

Functions delivered (11): CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM, TEXT, VALUE.

Test count by function:
- CONCATENATE 6, CONCAT 5, LEFT 7, RIGHT 6, MID 7, LEN 5, LOWER 4, UPPER 4, TRIM 6, TEXT 14, VALUE 15 — **79 total**.

Each function has ≥ 4 fixtures (mandate satisfied). LEN/LEFT/MID each have a dedicated emoji test pinning the `Array.from`-based codepoint split.

TEXT format codes covered (7, per task scope):
`"0"`, `"0.00"`, `"#,##0"`, `"#,##0.00"`, `"0%"`, `"0.00%"`, `"$#,##0.00"`.

TEXT format codes punted (task brief out-of-scope — `formatTextNumber` returns raw `String(n)`):
- Date / time codes (`"yyyy-mm-dd"`, etc.) — owned by Wave C/C5 dates.
- Negative-suffix sections (`"#,##0;(#,##0)"`) — only the positive section before `;` is honored; negative numbers format with the positive code (e.g. `-1234` under `"#,##0;(#,##0)"` becomes `-1,234`, not `(1,234)`). One TODO comment + one test pins this.
- Arbitrary `#`/`0` patterns beyond the canonical seven.
- Scientific (`0.00E+00`), fraction (`# ?/?`), embedded literal text, color sections.

Known risks / behavior deviations:
- **Unicode discipline**: LEN/LEFT/RIGHT/MID use `Array.from(text)` to split by code points, so emoji and other non-BMP codepoints count as 1 character. This **diverges from Excel**, which counts UTF-16 code units. Tests pin the einfach-ts behavior explicitly. Inline module-header comment documents the choice; if Codex review prefers strict Excel parity, swap `codepoints(s)` for a bare `s.split('')` (UTF-16-code-unit-based).
- **TRIM** mirrors Excel's strict ASCII-whitespace rule. Non-breaking space (U+00A0) is *not* trimmed — see inline comment. If product wants to trim NBSP too, swap the regex to `/\s+/g`.
- **Grapheme clusters not segmented**: flag emoji (regional-indicator pairs), keycap sequences, ZWJ family glyphs still count as multiple "characters" because we split at codepoint, not grapheme cluster. Full grapheme support needs `Intl.Segmenter`. Deferred.
- **CONCATENATE vs CONCAT**: CONCATENATE coerces an array arg to its top-left scalar (Excel's legacy behavior); CONCAT flattens arrays in row-major order (Excel's post-2019 behavior). Tests pin both.
- **VALUE** strict-comma check rejects leading / trailing / doubled commas, but `"1,2,3"` is currently accepted (simple comma-strip turns it into `123`). Documented gap; Wave F could tighten with a "comma every 3 digits" pattern check.
- **VALUE** with leading `$` after a sign (`"-$1234"`) — currently accepted (sign pulled off first, then `$`). Excel accepts this. Reverse order (`"$-1234"`) is rejected, matching Excel.
- **TEXT(<boolean>, fmt)** stringifies the boolean as "TRUE"/"FALSE" regardless of format code. Test pins this. Matches Excel.

Next request: CC main session merges `src/eval/functions/index.ts` consolidating all C-track `FUNCTIONS` records into a single dispatch Map. C4's import surface is `import { FUNCTIONS as TEXT } from './text'`. No naming collisions with C1/C2/C3/C5 (the 11 names are disjoint from the Excel-spec inventories of math, logical, lookup, date, stats).

---

### Handoff: C.C5 / 2026-05-26

Owner（交付方）: C5 agent
Status: done
Touched files:
- `excel/excel-core-ts/src/eval/functions/date.ts` (new — `TODAY` / `NOW` / `DATE` / `YEAR` / `MONTH` / `DAY` / `WEEKDAY` + `FUNCTIONS` record; internal `dateToSerial` / `serialToDate` / `weekdaySun0Mon1` helpers)
- `excel/excel-core-ts/src/eval/functions/stats.ts` (new — `COUNTIF` / `SUMIF` / `COUNTIFS` / `SUMIFS` + `FUNCTIONS` record; local `parseCriterion` / `matchesCriterion` / `wildcardMatch`)
- `excel/excel-core-ts/test/date.test.ts` (new — 41 specs)
- `excel/excel-core-ts/test/stats.test.ts` (new — 53 specs)

Public types changed: none. Both files consume only `FunctionImpl` / `Value` / `EvalContext` from `'../../types'` and `propagateError` / `toNumber` from `'../coerce'`. The criterion grammar / wildcard matcher are local to `stats.ts` (no cross-import from C3 lookup, per mandate). Single new ambient export per file: `FUNCTIONS: Record<string, FunctionImpl>`.

Atoms added/changed: **none** (pure function impls; ctx is unused inside both files — date / stats never consult `cells` or `refLookup`).

Tests run:
- `npx jest excel/excel-core-ts/test/date excel/excel-core-ts/test/stats --no-coverage` → **94/94 pass** (target was 50+).
- `npx jest excel/excel-core-ts --no-coverage` → **615/615 pass** (full package, 11 suites: 41 date + 53 stats + 88 math + 61 logical + 56 lookup + 79 text + 87 refs + 102 parser + 20 workbook + 21 evaluate + 7 types smoke).
- `npx tsc -b excel/excel-core-ts` → **clean** (no diagnostics). The pre-existing C5-owned errors flagged in C3/C4 handoffs (`stats.ts:64` Value narrowing, `stats.ts:227` unused `sameShape`) are now fixed; the lookup.ts `err` lint is C3's, untouched.

Functions delivered:
- **date (7)**: TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY.
- **stats (4)**: COUNTIF, SUMIF, COUNTIFS, SUMIFS.

Each function has ≥ 4 fixtures (mandate satisfied — DATE has 11, YEAR/MONTH/DAY share an 11-spec block, WEEKDAY 9, TODAY 4, NOW 4; COUNTIF 13, SUMIF 10, COUNTIFS 9, SUMIFS 9, plus 5 cross-cutting criterion-edge tests).

### Date semantics — 1900 epoch + Excel leap-year bug

The big risk-area in the task brief: **DATE(1900, 2, 29)** returns serial **60** (Excel-compat). Confirmed by test "DATE(1900, 2, 29) === 60 (Excel 1900 leap-bug)" in `date.test.ts`. The math:

- Anchor: `Date.UTC(1899, 11, 31)` → serial 0.
- `dateToSerial(d)` computes `realDays = (d - anchor) / 86_400_000`, then shifts `+1` when `realDays >= 60` to insert the phantom Feb 29 1900.
- `serialToDate(s)` is the inverse: shifts `-1` when `s > 60` to map the phantom day to JS's real 1900-03-01.
- `DATE()` special-cases the literal `(1900, 2, 29)` triple — JS Date.UTC rolls Feb 29 1900 over to March 1, so without this branch we'd return 61.
- Other rollover paths never land on serial 60 (no JS Date equates to Feb 29 1900), so the bug only surfaces on the explicit literal request.

Pinned values matching Excel:
- `DATE(2024, 1, 1) === 45292`
- `DATE(1900, 1, 1) === 1`
- `DATE(1900, 2, 28) === 59`
- `DATE(1900, 2, 29) === 60`
- `DATE(1900, 3, 1) === 61`
- `DATE(2024, 12, 31) === 45657`
- WEEKDAY uses `(serial - 1) % 7` (Sun=0) — internally consistent with Excel's bug-aware calendar. `WEEKDAY(1) = 1 (Sun)`, `WEEKDAY(45292) = 2 (Mon, 2024-01-01)`.

TODAY / NOW are exercised under `jest.useFakeTimers().setSystemTime(...)` so the non-deterministic clock is pinned per test.

### Stats semantics — criterion grammar

`parseCriterion(Value)` is the single entry point. It:
1. Propagates `kind: 'error'` criteria verbatim (`{error: Value}`).
2. For non-string criteria (number / boolean / blank / array), returns `op: '='` with the value as-is (arrays collapse to top-left).
3. For string criteria, strips the leading comparator (`<=`, `>=`, `<>`, `<`, `>`, `=`), trims the rest, attempts numeric coercion (strict regex `^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$`), recognizes `"TRUE"` / `"FALSE"`, then falls back to string. Wildcards are detected on the remaining string.

`matchesCriterion(value, parsed)`:
- Wildcards only apply for `=` / `<>` against string targets — wildcard against a non-string cell never matches (negated for `<>`).
- `=` / `<>` use `scalarEquals` (type-aware: number cell never equals string criterion; blank equals empty-string).
- Ordered comparison (`<`, `<=`, `>`, `>=`) coerces both sides via `numericComparable` (which yields `undefined` for string / blank / array / error). Comparison fails closed (returns false) on type mismatch — matches Excel's behavior, e.g. `COUNTIF(range, ">-1")` does NOT count blank cells even though they coerce to 0 in arithmetic.

### Excel quirks pinned by test

- **String case-insensitive equality**: `COUNTIF(["apple","APPLE","Banana"], "apple") === 2`.
- **Wildcard escaping**: `"a~*"` matches literal `"a*"`, not `"ab"`.
- **`<>` empty rest**: counts non-blank, non-empty-string cells (`COUNTIF([1, "", BLANK, 2], "<>") === 2`).
- **Blank vs empty-string equality**: `BLANK == ""` in `=` comparisons (`COUNTIF([BLANK, "", 1], "") === 2`).
- **Error cells in range are skipped** by COUNTIF/SUMIF/COUNTIFS (Excel-compat). Errors in `sum_range` of SUMIF/SUMIFS still propagate as `#REF!` / `#DIV/0!`.
- **Non-numeric sum-targets** are silently skipped in SUMIF/SUMIFS (e.g. a string cell in `sum_range` does not poison the sum).
- **Number criterion vs numeric-looking string cell**: `COUNTIF([5, "5"], 5) === 1` (only the real number).

### Known limitations / deviations

- **SUMIF unequal range sizes**: when `range` and `sum_range` differ in length, we pair index-by-index up to `min(len)` rather than auto-extending. Excel silently extends `sum_range` to match `range`'s shape — close enough for v1; tests pin both equal-length and shape-mismatch cases.
- **SUMIFS / COUNTIFS require exact shape match across criterion ranges** — `#VALUE!` when any pair differs. Matches Excel.
- **Wildcards only fire when the criterion is a string** that contains `*` or `?`. A bare-number criterion (e.g. cell-ref that resolves to a number) never engages wildcard logic. Matches Excel.
- **Boolean criteria**: passing `bool(true)` directly as the criterion does direct equality against boolean cells. Passing `str("TRUE")` also matches boolean `true` cells (via the `parseCriterion` boolean-keyword branch).
- **DATE year < 1900** → `#NUM!`. Excel's actual behavior shifts years 0..1899 by +1900 (`DATE(24, 1, 1)` → 2024-01-01) — we follow the simpler rule documented in the task brief; the shift is a Wave F polish, not a parity break.
- **WEEKDAY return_type 11..17** (Excel extension) — not implemented; only types 1, 2, 3 are accepted. Anything else → `#NUM!`.

### 1900 leap-year bug — final verdict

**`DATE(1900, 2, 29)` returns serial 60** (matches Excel verbatim). The bug is replicated mathematically (not bypassed) so:
- The phantom day participates in the calendar (serial 60 reports as 1900-02-29 via YEAR/MONTH/DAY).
- All real dates on or after 1900-03-01 are shifted up by 1 day relative to a "clean" calendar — `DATE(2024, 1, 1) === 45292`, the canonical Excel value.
- Date arithmetic with future date functions (DATEDIF, NETWORKDAYS, EDATE, EOMONTH — to be added in Wave F) will inherit this calendar automatically because they all go through `dateToSerial` / `serialToDate`.

Next request: CC main session can now register `FUNCTIONS` from both `'./date'` and `'./stats'` into the consolidated `src/eval/functions/index.ts` Map alongside C1 math + C2 logical + C3 lookup + C4 text. **All five Wave C tracks (C1..C5) are now done** — Wave D worker-shim can begin once the registry merges. No naming collisions: the 11 names exported by C5 (TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, COUNTIF, SUMIF, COUNTIFS, SUMIFS) are disjoint from the math / logical / lookup / text inventories.

---

### Handoff: E.E3 + E.E4 / 2026-05-26

Owner（交付方）: E3+E4 agent
Status: done

Touched files (whitelist enforced):
- `excel/excel-core-ts/src/types.ts` (edit — additive: added `readonly lambdaScope?: ReadonlyMap<string, Value>` to `EvalContext`; no existing field renamed / removed)
- `excel/excel-core-ts/src/eval/evaluate.ts` (edit — `'name'` arm reads `ctx.lambdaScope` before falling through to `resolveName`; LAMBDA binding without parens now returns `#VALUE!` with a diagnostic; `'call'` arm dispatches to `resolveName(...).kind === 'lambda'` between built-in lookup and host custom)
- `excel/excel-core-ts/test/lambda.test.ts` (new — 16 specs, all green)
- `excel/solid-excel/test/excel-core-ts-custom-formulas.test.ts` (new — 9 specs against `createWorkerRuntimeTs()`, all green)

Public types changed:
- `EvalContext.lambdaScope?: ReadonlyMap<string, Value>` — **purely additive**, no consumer needs to update. Default is `undefined` → existing call sites that don't construct lambdaScope keep their behavior. Documented inline in `types.ts §7`.

Atoms added/changed: **none**. LAMBDA dispatch reuses the existing `Workbook.defineName` name registry; the per-cell `formulaCellAtom` derive is the only atom involved and its shape is unchanged.

Engine dispatch order pinned by tests (`'call'` arm in `evaluate.ts`):
1. built-in registry (`getBuiltinFunction(name)`)
2. workbook LAMBDA (`ctx.resolveName(name).kind === 'lambda'`)
3. host custom formula (`ctx.callCustom`)
4. `#NAME?` with `function '<name>' is not registered`

This is the order documented in `excel/spreadsheet-ui-core/src/custom-formulas/README.md` and exercised end-to-end by `excel/solid-excel/test/excel-core-ts-custom-formulas.test.ts` "builtin name shadows" test.

Tests run:
- `npx jest excel/excel-core-ts/test/lambda excel/solid-excel/test/excel-core-ts-custom-formulas --no-coverage` → **25/25 pass** (16 lambda + 9 custom-formula).
- `npx jest --no-coverage` (full repo) → **2471/2471 pass** across 167 suites — no regressions.
- `npx tsc -b` → clean (no diagnostics).

### E3 (LAMBDA) coverage detail

16 specs cover:
- Direct `lambdaScope` injection on the EvalContext (param shadows defined name).
- NameExpr fallthrough when scoped entry missing.
- Bare-LAMBDA reference without parens → `#VALUE!` (we don't model `#CALC!`).
- Zero-arg LAMBDA (PI → 3.14).
- Single-arg LAMBDA (DOUBLE(x)=x*2 → DOUBLE(5)=10).
- Two-arg LAMBDA (ADD(a,b)=a+b → ADD(2,3)=5).
- LAMBDA body calling a built-in (SQUARE(x)=POWER(x,2) → SQUARE(4)=16).
- LAMBDA param shadows workbook defined name (ID(7) returns 7 even when X=100 is defined).
- Missing arg binds to BLANK in body (`=GETX()` returns blank when GETX(x)=x).
- Extra args silently dropped past declared params (PICK_FIRST(11,22,33) → 11).
- Nested LAMBDA — outer scope visible inside inner body (lexical closure-style, achieved via spread of `parent.lambdaScope` into the child scope Map).
- Recursive LAMBDA via IF — **NOT supported** (eager arg eval → JS stack overflow). Test pins the failure mode with `expect(...).toThrow(/Maximum call stack/)` and documents the Wave F escape hatch (lazy IF/IFS/SWITCH dispatcher).
- Non-recursive LAMBDA nesting — fine (SUMTWOARGS(SUMTWOARGS(1,2),SUMTWOARGS(3,4)) → 10).
- Cell self-recursion via LAMBDA — `=FOO()` where FOO body reads A1 hits the existing `#CIRCULAR!` cycle guard (proves the cell-level guard still fires even when the recursion is wrapped in a LAMBDA dispatch).
- LAMBDA body with cell-range refs (SUMTWO(A1, B1) where A1=10, B1=32 → 42).
- Unregistered name → `#NAME?` (regression guard so the new LAMBDA branch doesn't swallow misses).

### E4 (custom formulas) coverage detail

9 specs cover the worker-runtime-ts contract end-to-end via direct `runtime.handle(...)` RPC calls (no real Worker, jest-only):
- Scalar arg: `=MYTAX(100)` with source `'return Number(args[0]) * 0.2'` → 20 / type=number.
- Unregister: after `unregisterCustomFormula`, re-applying the same formula yields `#NAME?` (forced re-eval by re-issuing `setFormulaDetailed` since cell values are sheetAtom-snapshot-cached).
- **Range arg marshalling** (the critical e2e check requested in the brief): `=SUMSQ2(A1:A3)` with A1=1, A2=2, A3=3 → 14. The custom source flattens `args[0]` via `Array.isArray(args[0]) ? args[0].flat() : [args[0]]`. **Confirmed**: range args arrive at the JS callback as a 2-D JS array — `unwrapForCustom` in `worker-runtime-ts.ts` maps `Value[][]` → JS-primitive `[][]` row-major. No TODO needed.
- Re-registration replaces the prior callable (last-write-wins by uppercase key).
- Custom throws → surfaces as `#VALUE!` with the thrown message.
- Case-insensitive call: `=mytax(5)` hits the `MYTAX` registration (engine uppercases via `name.toUpperCase()`).
- **Builtin shadowing** — `registerCustomFormula('SUM', ...)` does NOT override built-in SUM (because the engine consults built-ins first; this also doubles as a regression guard for the new LAMBDA branch's ordering).
- String return → text cell type.
- Excel-error-token string return → `{kind:'error'}` (e.g. custom returning `'#N/A'` becomes that error code).

### Known limitations / TODOs deliberately punted

- **Recursive LAMBDA via IF**: requires a lazy-branch dispatcher for IF / IFS / SWITCH / IFERROR / AND / OR. Out of scope for E3; pinned by `lambda.test.ts` "recursive LAMBDA via IF is NOT supported" test with explicit Wave F handoff comment.
- **`#CALC!` error code**: Excel uses `#CALC!` for bare-LAMBDA-without-call. Our `ErrorCode` union does not include `#CALC!` so we use `#VALUE!` with a diagnostic message; if F3 prep wants Excel-exact parity it should be added to the `ERROR_CODES` array in `types.ts` and the evaluator's `'name'` arm switched over.
- **LAMBDA inside a custom formula**: the JS callback receives unwrapped primitive values; it has no way to invoke a LAMBDA back through the engine. This is consistent with the WASM bridge contract (Wave 8.1 re-entrancy guard) and was not requested. If Wave F wants closures-from-custom, the `EvalContext.callCustom` signature needs an extra "callback-for-callbacks" seam.
- **Worker-runtime test does not spin a real `Worker`**: same approach as `excel/solid-excel/test/excel-core-ts-runtime.test.ts` (which is the canonical Wave D smoke test). The MCP playwright walkthrough remains the right tool for full UI smoke; that's Wave F2's responsibility, not E3/E4's.

Next request:
- Wave E1 (spill arrays) and Wave E2 (cross-sheet refs) are independent of this handoff and can run in parallel.
- Wave F2 (e2e migration) is now unblocked for LAMBDA-using fixtures and `custom-formulas.spec.ts` against `?backend=ts`.

---

### Handoff: F.F1 / 2026-05-26

Owner（交付方）: F1 agent
Status: done

Touched files (whitelist enforced):
- `excel/excel-core-ts/src/eval/functions/info.ts` (new — 8 `FunctionImpl` exports: ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL, ISERROR, ISERR, ISNA, TYPE + `FUNCTIONS` record)
- `excel/excel-core-ts/src/eval/functions/financial.ts` (new — 10 exports: PV, FV, PMT, NPER, RATE, NPV, IRR, IPMT, PPMT, CUMIPMT + `FUNCTIONS` record)
- `excel/excel-core-ts/src/eval/functions/math.ts` (edit — append CEILING / FLOOR / TRUNC / SUMPRODUCT / PRODUCT and update `FUNCTIONS` record; no existing function semantics changed)
- `excel/excel-core-ts/src/eval/functions/text.ts` (edit — append SEARCH / FIND and update `FUNCTIONS` record; no existing function semantics changed)
- `excel/excel-core-ts/src/eval/functions/index.ts` (edit — import + spread `INFO_FUNCTIONS` and `FINANCIAL_FUNCTIONS` into the BUILTIN_FUNCTIONS map)
- `excel/excel-core-ts/test/info.test.ts` (new — 31 specs)
- `excel/excel-core-ts/test/financial.test.ts` (new — 37 specs)
- `excel/excel-core-ts/test/math.test.ts` (edit — append 24 new specs for CEILING/FLOOR/TRUNC/SUMPRODUCT/PRODUCT + update registry enumeration to all 20 names)
- `excel/excel-core-ts/test/text.test.ts` (edit — append 15 new specs for SEARCH/FIND)

Public types changed: **none**. Every new function consumes `Value` / `FunctionImpl` / `EvalContext` from `'../../types'` verbatim. No contract drift.

Atoms added/changed: **none** (all 25 new functions are pure value-in / value-out; ctx is never read).

Tests run:
- `npx jest excel/excel-core-ts --no-coverage` → **777/777 pass** across 16 suites (info 31 + financial 37 + math 112 [88 pre-existing + 24 new] + text 94 [79 pre-existing + 15 new] + logical 61 + lookup 56 + date 41 + stats 53 + parser 102 + refs 87 + workbook 20 + evaluate 21 + array 24 + lambda 16 + functions-registry 9 + types 7).
- `npx tsc -b excel/excel-core-ts` → **clean** (no diagnostics).
- `npx jest vanilla --no-coverage` → **1729/1729 pass** (no regression in `@einfach/core`, `@einfach/spreadsheet-ui-core`, etc.).

### Total built-in function count

**82 functions** across 8 files (math 20, logical 10, lookup 5, text 13, date 7, stats 4, array 5, info 8, financial 10 — note the merge accounts: 20+10+5+13+7+4+5+8+10 = 82, confirmed by inline registry size check).

### Functions delivered (25)

**Info (8)**:
- ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL, ISERROR, ISERR, ISNA, TYPE
- *Critical contract*: these are the ONLY built-ins that bypass `propagateError` — an `error` arg is just another shape to classify (TRUE for ISERROR, etc.).

**Financial (10)**:
- PV, FV, PMT, NPER, RATE, NPV, IRR, IPMT, PPMT, CUMIPMT
- Sign convention: positive = received, negative = paid out (Excel standard).
- RATE + IRR use Newton-Raphson with 50-iteration cap and 1e-7 tolerance. Convergence detected on `|step| < tol` (rate stopped changing) OR `|f| < tol` (residual is zero). Final-pass relaxation accepts `|f| < 1e-3` to handle shallow-derivative roots; non-convergent → `#NUM!`.

**Math (5 new, math file now 20 total)**:
- CEILING, FLOOR (CEILING.MATH semantics — significance=0 returns 0, magnitude-only direction)
- TRUNC (toward-zero with optional `digits`)
- SUMPRODUCT (strict-shape with 1×1 broadcast; non-numeric inside arrays treated as 0 per Excel quirk; errors propagate)
- PRODUCT (multiply numerics; empty product = 0 per Excel)

**Text (2 new, text file now 13 total)**:
- SEARCH (case-INsensitive, wildcards: `*` / `?` / `~` escape)
- FIND (case-sensitive, wildcards literal)
- Position is 1-based code-point index (matches the LEN/LEFT/MID Unicode discipline already in `text.ts`).

### Excel semantics pinned by test

- **IS* family does NOT propagate errors** — `ISNUMBER(#DIV/0!) === FALSE`, `ISERROR(#N/A) === TRUE`. Single test in `info.test.ts` per function pins this.
- **TYPE** returns 1/2/4/16/64/0 for number/text/logical/error/array/blank. Excel's TYPE(blank) is 1; we diverge to 0 for diagnostic clarity (documented `TODO(F1)`).
- **PMT rate=0** falls back to closed-form `-(pv+fv)/nper` (avoids div-by-zero in the general formula).
- **PMT type=1 (annuity due) < type=0 in magnitude** for an interest-bearing loan — pinned by a comparison test.
- **NPV starts discounting at period 1** (Excel convention); IRR's internal NPV starts at period 0 — they differ on purpose.
- **IRR requires both a positive and a negative cash flow** — all-positive or all-negative series → `#NUM!`.
- **CUMIPMT(1..3, 5%, 10yr, 10000)** equals IPMT(1) + IPMT(2) + IPMT(3) — pinned as the spec-derived consistency check.
- **CEILING/FLOOR significance=0 returns 0** (Excel CEILING.MATH behavior, not the legacy `#DIV/0!`).
- **SUMPRODUCT non-numeric-in-array → treated as 0** (Excel-documented quirk).
- **PRODUCT empty product → 0** (Excel quirk; deviates from math's "empty product = 1").
- **SEARCH wildcards: `~*` matches literal `*`**, `~?` literal `?`, `~~` literal `~`.
- **FIND wildcards are literal** (no expansion) — `=FIND("h*o", "h*o!")` returns 1, not 1 via expansion.

### Known limitations / TODOs deliberately punted

- **TYPE(blank) = 0** instead of Excel's 1. Documented inline. If an F2 e2e fixture demands strict parity, flip the switch case.
- **CEILING/FLOOR with negative significance**: we use `Math.abs(significance)` (CEILING.MATH default). Classic CEILING signals `#NUM!` when signs differ; we accept everything. Inline `TODO(F1)` if a fixture catches it.
- **CUMPRINC** (cumulative principal) — not in the task brief; would mirror CUMIPMT. Future batch.
- **RATE convergence on pathological series**: the final-pass relaxation accepts `|f| < 1e-3` to declare success when the rate stopped moving — this can be tightened if a fixture demands stricter parity with Excel's internal solver.
- **IRR multiple roots**: when a series has multiple real roots, our Newton-Raphson converges to whichever root the initial `guess` is closest to. Matches Excel behavior (also documented). The `guess` argument is the user's escape hatch.
- **`message` field on error returns**: SEARCH/FIND deliberately include a diagnostic `message` on their `#VALUE!` returns. Tests use `errCodeOf()` helper to compare code-only when needed. Downstream consumers that strictly match `{kind, code}` will not see the `message` unless they look — it's purely additive.

### Numerical-method discipline

For RATE and IRR:
- Numerical derivative (central difference) with scaled epsilon `max(1e-8, |rate|·1e-6)` keeps the step well-conditioned near both zero and large rates.
- 50-iteration cap (per task brief). Returns `#NUM!` if neither convergence criterion is met.
- Two convergence criteria: `|f| < 1e-7` (residual zero) OR `|step| < 1e-7` (rate stopped). Either is enough.
- Final-pass safety net: if iteration cap is hit but `|f| < 1e-3`, accept the rate (matches Excel's lenient behavior on shallow residual surfaces; tightens easily if F2 surfaces a strict-Excel-parity fixture).

Next request:
- Next F1 batch (per `docs/PLAN.md §6` phase 8 — "function fill-out to ~200"): 25 more functions, picking from the Rust `eval.rs` inventory. Suggested groupings: more math (LOG/LN/EXP/PI/RADIANS/DEGREES/trig family), more stats (MEDIAN/STDEV/VAR family + percentile basics), more lookup (CHOOSE/OFFSET/INDIRECT), more text (REPLACE/SUBSTITUTE/REPT/EXACT). Each batch under the same single-file pattern, no shared edits.
- F2 e2e migration unblocked further: most office-grade demo formulas now resolve against the TS worker.
- Codex review recommended before next 25-function batch lands — particularly the financial precision (IRR/RATE convergence behavior) and SUMPRODUCT shape semantics; per `memory/feedback_codex.md`, F1 is the kind of "real decision point" that benefits from a second pass.
- If a future agent extends `ErrorCode` to include `#CALC!`, also update the `'name'` arm in `evaluate.ts` (search for "we use `#VALUE!`" comment in the LAMBDA branch).

---

### Handoff: F.F2 / 2026-05-26

Owner（交付方）: F2 agent
Status: done (scope: single parity probe — full e2e migration intentionally not in this slice)

Touched files (whitelist enforced — exactly one file):
- `excel/solid-excel/e2e/vnext-worker-ts.spec.ts` (new — single side-by-side spec, 5 test entries: 3 active + 2 `test.fixme`)

Public types changed: none.
Atoms added/changed: none.

Tests run:
- `npx playwright test e2e/vnext-worker-ts.spec.ts --reporter=line --workers=1` (from `excel/solid-excel/`)
  → **3 passed, 2 skipped (fixme)** in ~1.6s against an already-running dev server (`http://localhost:5174`).
- Dev server: `npm run dev -- --port 5174 --strictPort` (started manually because playwright's `webServer` block didn't auto-fire on the first run; on a fresh checkout the `command` block prepends `build:wasm` which is unnecessary for TS-only probes but doesn't break anything).

Scenarios covered (per F2 task brief):
1. **Navigate via `getByTestId('nav-tab-vnext-worker-ts')`** + assert `vnext-worker-ts-grid` visible — PASS.
2. **`vnext-worker-ts-banner` is visible** — PASS.
3. **B5 = SUM(B2:B4) = 60** — PASS (Wave C/C1 math through real Worker postMessage).
4. **C2 = UPPER("North") = "NORTH"** — PASS (Wave C/C4 text registry hit).
5. **D2 = IF(10 > 15, "high", "low") = "low"** — PASS (Wave C/C2 logical short-circuit).
6. **Live edit: A6 = `=B5*2` → "120"** — PASS (sheetAtom invalidation + projection refresh end-to-end).
7. **Spill: A7 = `=SEQUENCE(2,2)` → A7..B8 = 1,2,3,4** — **`test.fixme`** (real regression — see below).
8. **LAMBDA round-trip** — `test.fixme` (no host UI surface — documented in spec docstring).
Plus one regression guard: `no console errors leak from the TS worker boot or formula edits` — PASS.

Regression found (NOT fixed per F2 scope): **Spill projection only fires through `readCells`, not `readSparseRange`.**
- `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts:434 readSparseRange` iterates `state.workbook.store.getter(target.sheetAtom)` — only existing cells. Spill target coords (B7, A8, B8 for `=SEQUENCE(2,2)` at A7) have no `input` of their own, so the visible-window projection never publishes them.
- `excel/solid-excel/src-vnext/adapter/worker-runtime-ts.ts:235 readCellValue` *does* call `getSpillProjectedValue` for empty cells — that's why the jest suite `excel/solid-excel/test/excel-core-ts-spill.test.ts` (which uses `readCells` RPC directly) is green while the UI grid is not.
- Repro: nav-tab vnext-worker-ts → scroll `.spreadsheet-grid-scroll-viewport` 48px → `=SEQUENCE(2,2)` at A7 → A7 displays "1" (anchor scalar collapse OK) but B7/A8/B8 display "" (visible-window publisher gap).
- Suggested fix (out of F2 scope): teach `readSparseRange` to walk requested bounds and consult `getSpillProjectedValue` for every empty (row, col) in the window, emitting synthetic `CellSnapshotWire`s for hits. Alternative: have anchors emit their full array footprint and let the backend fan-out (closer to WASM's derived-spill-atom pattern, PLAN.md §4.6).

Known limitations of this probe (deliberate):
- Only one demo viewport scenario tested. The full e2e migration (every spec under `excel/solid-excel/e2e/` re-pointed at `?backend=ts`) is the remaining F2 follow-up — explicitly scoped out of this slice per F2 brief.
- `webServer` auto-start in `excel/solid-excel/playwright.config.ts` was not exercised in this run (manually started). If a follow-up CI lane wires the suite, that path needs a separate validation.
- `test.fixme`'d LAMBDA scenario has an empty body — it documents intent only. To make it executable, either (a) extend `SpreadsheetNameManagerDialog` to accept a `kind: 'lambda'` refersTo, or (b) add a `defineName` debug RPC to `worker-runtime-ts` mirroring the WASM worker's debug client and call it from the test via `window.__einfachWorkbookDebugClient`.

### Verdict — TS backend "ready for default flip" per PLAN.md §10?

**Not yet — one blocker plus one parity gap.**

PLAN.md §10 success criteria:
- ❓ "All e2e suites in `excel/solid-excel/e2e/` pass against the TS worker." — Not exercised by this probe; full migration is the F2 follow-up. Current state is "the demo renders correctly for the seeded fixture and a live edit, but the spill path is broken in the projection layer."
- ❌ **Spill regression** (above) — would fail any e2e spec that relies on a spilled formula populating empty cells via the visible-window projection.
- ⬜ Not validated by F2: `million-demo` within 2× wasm time, `demo-budget` / `demo-grades` / `demo-sales` visual parity. Probe scope was minimal.
- ⬜ Not in scope: excel/rust/excel-core retirement (Phase 10).

Recommendation: ship the spill-projection fix (one ~30-line edit in `worker-runtime-ts.ts:readSparseRange`), then re-run this spec with the `test.fixme` flipped back to `test`. After that passes, the full F2 e2e migration can begin running the existing demo spec inventory through `?backend=ts` and triaging the failures.

Next request:
- Open a follow-up ticket for the `readSparseRange` spill-projection gap (see "Regression found" above). The fix is small and isolated; doing it before flipping the default keeps the cutover window quiet.
- Schedule the actual e2e migration as a separate F2-followup once the spill projection is repaired. The migration is mechanical (rename URL flags / nav-tab IDs, run, triage), but its size warrants its own kanban row.
- LAMBDA host-UI gap remains open as Wave F polish.
