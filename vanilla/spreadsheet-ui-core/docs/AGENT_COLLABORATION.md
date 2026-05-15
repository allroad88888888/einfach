# Spreadsheet UI Core Agent Collaboration

本文档是 CC 和 Codex 在 `@einfach/spreadsheet-ui-core` 上并行推进功能时的共享工作台。
目标是减少重复设计、文件冲突和半成品合入。

## 使用规则

- 开工前先读本文件、`ROADMAP.md` 和对应 feature doc。
- 开工前更新下面的 In-flight 看板；完成后更新状态、测试和遗留风险。
- 不要回退对方改动。看到非自己改的 dirty file，先把它当作对方正在工作。
- 一个 agent 同一时间只拥有明确文件边界；跨边界要先在本文件留言。
- `vanilla/spreadsheet-ui-core` 仍必须保持框架无关：不能依赖 Solid、React、DOM、worker、
  wasm、`navigator`、`window`。
- 状态只能用 Einfach atom/store。不能引入 Redux、Zustand、Jotai、MobX 等外部状态系统。
- 不允许引入 per-cell、per-row、per-column atom。大表能力必须以可视窗口、有限缓存或
  backend port 为边界。

## In-flight 看板

| 日期 | Owner | Feature | 状态 | 文件边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| 2026-05-15 | CC/Codex | multi-range-selection | done | `src/selection/*`, `src/keyboard/*`, `src/pointer/*`, `test/selection-multi-range.test.ts`, `test/pointer.test.ts` | 后续可扩 toolbar/context-menu 多 region 操作 |
| 2026-05-15 | Codex | multi-range UI integration | done | `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`, `solid/excel/test/vnext-grid.test.tsx` | Escape 已走 core intent；后续可接多 region command iteration |
| 2026-05-15 | Codex | collaboration protocol | done | `docs/AGENT_COLLABORATION.md` | 按本文档做后续 review / handoff |
| 2026-05-15 | CC | rich-types core | done | `src/rich-types/*`, `src/backend/types.ts`, `test/rich-types.test.ts` | Codex 已接 Solid vNext 投影渲染和静态 backend 端口 |
| 2026-05-15 | Codex | rich-types UI integration | done | `solid/excel/src-vnext/*`, `solid/excel/test/vnext-*`, `solid/excel/e2e/vnext-smoke.spec.ts` | 下一步可接 toolbar/context-menu 的 rich edit 入口 |

状态值：

- `planned`：只在文档里排队，未开始写代码。
- `in progress`：正在改文件，其他 agent 不要碰同一边界。
- `needs review`：实现完成，等待另一个 agent review。
- `blocked`：需要决策或上游实现。
- `done`：已测试、已集成或已 commit。

## 角色分工

CC 优先负责：

- `vanilla/spreadsheet-ui-core/src/*` 的 feature core 实现。
- 对应 `vanilla/spreadsheet-ui-core/test/*` 的核心单测。
- feature doc 与实现之间的契约同步。

Codex 优先负责：

- 架构 review、状态建模 review、跨 feature 冲突检查。
- `solid/excel/src-vnext/*` adapter / UI 接线。
- Playwright e2e 和 MCP Playwright 验收。
- package boundary、public surface、release gate。

共同责任：

- 每个 feature 的 backend port 必须可选。
- 每个新增 atom 必须写明 source / derived / command 类型和 `debugLabel`。
- 每个跨包类型变更必须检查 package boundary test。

## Feature 交接模板

每次把工作交给另一个 agent 时，在本文件或对应 feature doc 追加：

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

## 实现准入

从 doc 进入代码前必须确认：

- 是否属于 `ROADMAP.md` 的当前 wave，或者是否有明确理由插队。
- 是否需要扩展 `DisplayCell`、`SpreadsheetBackend`、keyboard intent、toolbar command、
  menu command 或 projection result。
- 是否保持可视窗口有界，不读取整张 sheet。
- 是否有明确 fallback：backend 不实现 optional port 时 UI core 如何隐藏或降级。
- 是否会影响 `solid/excel/src-vnext` adapter；如果会，先列出 adapter 后续任务。

## 测试门禁

文档-only：

```bash
git diff --check -- vanilla/spreadsheet-ui-core/docs
```

UI core 类型或 atom 改动：

```bash
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit --pretty false
npx jest vanilla/spreadsheet-ui-core/test/<feature>.test.ts --runInBand
npx jest vanilla/spreadsheet-ui-core/test/package-boundary.test.ts --runInBand
```

影响 `solid/excel/src-vnext` adapter 或 UI：

```bash
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
npx jest solid/excel/test/vnext-*.test.tsx solid/excel/test/vnext-adapter.test.ts --runInBand
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

视觉、交互、clipboard、worker 或 viewport 相关改动必须再做 MCP Playwright 验证，并记录：

- URL
- 操作路径
- 可视 cell 数
- console warning/error
- 与 Excel 交互一致性结论

## 冲突处理

如果发现同一文件被双方修改：

1. 不要自动整理或重写对方代码。
2. 在 In-flight 看板把 feature 标成 `blocked`。
3. 写清楚冲突文件、冲突类型、你需要对方保留的契约。
4. 只在自己拥有的文件边界内继续推进。

## Review 重点

Review 时先看风险，不先看风格：

- 状态来源是否唯一，是否复制了派生状态。
- 是否在 render / projection 循环里动态创建 atom。
- 是否引入全表扫描、全量 cell 数组、全量 row/column metadata。
- backend optional port 缺失时是否有降级路径。
- 类型导出是否破坏 package boundary。
- 是否需要 Solid adapter 或 e2e 补测试。

## 当前注意事项

- `multi-range-selection` 当前正在改 `selectionAtom` 的内部表示。后续 review 要确认公开的
  `selectionAtom` 是否仍保持单 primary region 兼容语义。
- `AllSelection` 是否允许出现在 `MultiRangeSelectionState.regions` 需要统一。现有 doc 说
  `SelectionRegion` 排除 `AllSelection`，实现必须跟 doc 对齐，或者同步改 doc。
- `selectionRegionsAtom` 是 bounded selection metadata，不是 per-cell atom，原则上可接受。
- 如果 multi-range 后续要影响 toolbar/context-menu/clipboard，先在 UI core 定义 primary-only
  默认行为，再让 adapter 做多 region 迭代。

## Review: multi-range-selection / 2026-05-15

Owner reviewed: CC

Reviewer: Codex

Status: needs follow-up before Solid vNext UI integration.

Tests run:

```bash
npx jest vanilla/spreadsheet-ui-core/test/selection-multi-range.test.ts \
  vanilla/spreadsheet-ui-core/test/selection.test.ts \
  vanilla/spreadsheet-ui-core/test/keyboard.test.ts \
  vanilla/spreadsheet-ui-core/test/package-boundary.test.ts --runInBand
```

Result: passed, 4 suites / 26 tests.

Findings:

- P1: Ctrl/Cmd multi-select is not reachable through the pointer contract yet.
  `multi-range-selection.md` defines Ctrl/Cmd-click and Ctrl/Cmd-drag as the user-facing
  entry point, but `PointerSelectionStartInput` only carries `kind/sheetId/anchor/focus/source`
  and has no modifier or append-mode field (`src/pointer/types.ts:27`). `solid/excel`
  still calls `selectCellAtom` on cell click, so Ctrl/Cmd-click currently replaces the selection
  instead of calling `addSelectionRegionAtom` (`solid/excel/src-vnext/grid/SpreadsheetGrid.tsx:1242`).
  Recommendation: either extend pointer intent with `append?: boolean` / modifier metadata, or
  explicitly document that host adapters must bypass pointer and call `addSelectionRegionAtom`
  for Ctrl/Cmd-click. Without this, the feature is only programmatic.

- P1: Escape collapse contract is documented but not wired. The feature doc says Escape with
  multiple regions collapses to the primary region. Current navigation-mode keyboard path only
  handles Escape in editing mode (`src/keyboard/index.ts:123`) and otherwise returns `none`
  after movement / F2 / Delete handling (`src/keyboard/index.ts:71`). Recommendation: add a
  keyboard intent for `selection.clearNonPrimary` or handle Escape in `dispatchKeyboardInputAtom`
  by calling `clearNonPrimaryRegionsAtom({ keepPrimary: true })` when region count > 1.

- P2: `selectionRegionsAtom` exposes the internal mutable `regions` array by reference
  (`src/selection/index.ts:254`). Any consumer can mutate the returned array outside a setter,
  bypassing atom notifications and corrupting selection state. Recommendation: make
  `MultiRangeSelectionState.regions` readonly and return a copied readonly array from
  `selectionRegionsAtom`, or introduce a read helper that snapshots the array.

- P2: `MultiRangeSelectionState.regions` is typed as `SelectionState[]`, so it can contain
  `AllSelection` (`src/selection/types.ts:53`). This matches current `selectAllAtom` behavior,
  but the feature doc still says `SelectionRegion` excludes `AllSelection` and the internal
  shape is `regions: SelectionRegion[]`. Recommendation: pick one contract. If `all` is a valid
  single-region state, update the doc and rename the type to make that explicit; otherwise keep
  `regions: SelectionRegion[]` and represent `all` outside the multi-region list.

Positive notes:

- The public `selectionAtom`, `activeCellAtom`, `selectionRangeAtom`, and
  `selectionSnapshotAtom` still read the primary region, so existing primary-only consumers are
  mostly preserved.
- `setPrimaryRegionAtom` lets keyboard movement update only the active region, which is the right
  direction for Excel-like multi-range behavior.
- No per-cell/per-row/per-column atom was introduced.

Suggested next tests:

- Ctrl/Cmd-click or append-mode pointer commit appends a region and sets it primary.
- Escape with 2+ regions collapses to the primary region.
- Mutating the value returned by `selectionRegionsAtom` cannot mutate store state.
- `Ctrl+A` after multiple regions follows the chosen `all` contract.

## Handoff: multi-range UI integration / 2026-05-15

Owner: Codex

Status: done for visible grid selection.

Touched files:

- `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`
- `solid/excel/test/vnext-grid.test.tsx`

Implemented:

- Ctrl/Cmd-click appends a disjoint cell selection by calling `addSelectionRegionAtom`.
- Ctrl/Cmd+Shift-click appends a range from the current active cell to the clicked cell.
- Ctrl/Cmd row/column header clicks append row/column regions.
- Visible grid selection rendering now reads `selectionRegionsAtom`, so all visible regions are
  highlighted while `selectionAtom` remains the primary region.
- Escape in the grid collapses disjoint selections to the primary region via
  `clearNonPrimaryRegionsAtom({ keepPrimary: true })`.
- Context menu targeting preserves the selected region range when right-clicking inside any
  visible region.

Tests run:

```bash
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
npx jest solid/excel/test/vnext-grid.test.tsx --runInBand
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

MCP Playwright:

- URL: `http://127.0.0.1:4173/?debug=1`
- Operation: click `A1`, Ctrl-click `C3`, then press Escape on `vnext-grid`.
- Result before Escape: `A1` selected, `C3` selected and active, visible cells `30`, `J20`
  not mounted.
- Result after Escape: `A1` no longer selected, `C3` remains selected and active, visible cells
  still `30`.
- Console: warning/error `0`.

Known risks:

- Toolbar/context-menu commands still operate on one target range. Multi-region command iteration
  can build on `selectionRegionsAtom` now that core returns a defensive readonly snapshot.

## Handoff: multi-range core follow-up / 2026-05-15

Owner: Codex

Status: done for review findings.

Touched files:

- `vanilla/spreadsheet-ui-core/src/selection/*`
- `vanilla/spreadsheet-ui-core/src/keyboard/*`
- `vanilla/spreadsheet-ui-core/src/pointer/*`
- `vanilla/spreadsheet-ui-core/test/selection-multi-range.test.ts`
- `vanilla/spreadsheet-ui-core/test/pointer.test.ts`
- `vanilla/spreadsheet-ui-core/docs/multi-range-selection.md`

Implemented:

- `selectionRegionsAtom` now returns a copied readonly snapshot and freezes nested cell/range
  coordinates, so consumers cannot mutate core state outside atom setters.
- Navigation Escape with multiple regions now emits `selection.clearNonPrimary` from keyboard
  core and dispatches `clearNonPrimaryRegionsAtom({ keepPrimary: true })`.
- Pointer drag-selection start/commit carries `append?: boolean` so Ctrl/Cmd drag can use a
  first-class core contract.
- Multi-range docs now align with the chosen `SelectionState[]` internal shape for single
  `all` replacement after Ctrl/Cmd+A.

Tests run:

```bash
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit --pretty false
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
npx jest vanilla/spreadsheet-ui-core/test/selection-multi-range.test.ts \
  vanilla/spreadsheet-ui-core/test/selection.test.ts \
  vanilla/spreadsheet-ui-core/test/keyboard.test.ts \
  vanilla/spreadsheet-ui-core/test/pointer.test.ts \
  vanilla/spreadsheet-ui-core/test/package-boundary.test.ts \
  solid/excel/test/vnext-grid.test.tsx --runInBand
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

MCP Playwright:

- URL: `http://127.0.0.1:4173/`
- Operation: click `A1`, Ctrl-click `C3`, press Escape on the vNext grid.
- Result before Escape: `A1` and `C3` selected, `C3` active, visible cells `30`, `J20`
  not mounted.
- Result after Escape: only `C3` remains selected/active, visible cells `30`, `J20` not mounted.
- Console: warning/error `0`.

Known risks:

- Multi-region toolbar/context-menu command iteration is still not implemented.
- `append?: boolean` is exposed in pointer core; Solid vNext currently handles Ctrl/Cmd-click
  directly and can wire Ctrl/Cmd-drag later.

## Handoff: rich-types UI integration / 2026-05-15

Owner: Codex

Status: done for projection display and static backend port.

Touched files:

- `solid/excel/src-vnext/adapter/static-backend.ts`
- `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`
- `solid/excel/src-vnext/demos/VNextSmokeDemo.tsx`
- `solid/excel/e2e/vnext-smoke.spec.ts`
- `solid/excel/test/vnext-adapter.test.ts`
- `solid/excel/test/vnext-grid.test.tsx`
- `solid/excel/src/styles.css`
- `vanilla/spreadsheet-ui-core/test/package-boundary.test.ts`

Implemented:

- Static backend now preserves cloned `DisplayCell.richValue` in projections.
- Static backend implements optional `setCellRichValue`, deriving plain `displayValue` from
  `getRichValueText`.
- Solid vNext Grid renders projected hyperlink and rich-text values from visible cells only.
- Demo seeds visible `E5` hyperlink and `D6` rich text cells.

Tests run:

```bash
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit --pretty false
npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false
npx jest vanilla/spreadsheet-ui-core/test/rich-types.test.ts \
  vanilla/spreadsheet-ui-core/test/package-boundary.test.ts \
  solid/excel/test/vnext-adapter.test.ts \
  solid/excel/test/vnext-grid.test.tsx --runInBand
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts
```

MCP Playwright:

- URL: `http://127.0.0.1:4173/`
- Result: visible cells `30`, `J20` not mounted, `E5` rendered as hyperlink `Docs`, `D6`
  rendered as rich text `Total 109`.
- Console: warning/error `0`.

Known risks:

- This does not add rich-text editing UI yet. Editing still commits plain string input via
  `setCellInput`, matching the current rich-types doc.
- Hyperlink display does not navigate on single click; this preserves spreadsheet selection
  semantics. A future command can add Ctrl/Cmd-click open behavior.
