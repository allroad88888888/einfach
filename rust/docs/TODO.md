# TODO — 没做完的角落

> 截至 lazy formula 主体落地批次（HEAD 之上加了 review 修复 + lazy formula 实现）。
> `✅` = 完成；`⚠️` = 部分完成（限制写在条目里）；`□` = 未做。

## 0. 本批次（review 6 项 + lazy 规划）状态

| 项 | 状态 | 备注 |
|---|---|---|
| Workbook 跨 sheet eval 真正算出值 | ✅ | `WorkbookEvalProvider` 读路径递归求值；Workbook 读取会 bypass formula cache，保证跨 sheet 源值 live |
| 跨 sheet 链式 ref 缓存 | ✅ | A.A→B.A→A.B 这类链式读取已由 Workbook provider 覆盖；跨 sheet 订阅 / workbook-wide 反向依赖仍 deferred |
| 当前 sheet 限定引用 | ✅ | `Sheet1!A1` 在 Sheet1 内按普通 same-sheet ref 求值，自引用返回 `#CYCLE!` |
| Solid undo/redo snapshot 用值类型 | ✅ | `CellSnapshot` 改 tagged union；number / error / boolean 回归测试已加 |
| paste 公式按 (paste-copy) 偏移 | ✅ | `formula-shift.ts::shiftFormulaRefs`；3 条测试钉住 |
| selection 提到 SheetStore | ✅ | `store.selection / setSelection / selectionAddr`；Table + FormulaBar 的 prop 接口都已撤掉 |
| JS mock 行列编辑 ref retarget | ✅ | js-sheet 用同一组 `formula-shift.ts` helper；字符串 literal 不改写，多字母列搬迁已覆盖 |
| Lazy formula eval 主体 | ✅ | `set_formula` 只记录 AST/deps/cache，不再 `create_derived`，也不再为引用到的空 cell 创建 atom；`get_cell` 按需计算 |
| Lazy formula eval 规划 | ✅ | `LAZY_FORMULA_EVAL.md` 已更新为当前落地状态 + 后续路线 |

## 1. UI 接线（后端就位 / UI 未接）

### 1.1 ✅ FormulaBar 接到 Table — 已做
- 通过 `<Table formulaBar />` 渲染，FormulaBar 默认从 `store.selection` 读地址
- 仍在 deferred：5 个 demo 页 (`solid/excel/src/demos/*`) 没逐页加 `formulaBar` prop —— 用户得改 prop 调用方才看到

### 1.2 ✅ Ctrl+Z / Ctrl+Y 全局键盘 — 已做
- `Table.tsx::onKeyDown` 处理 `Cmd/Ctrl+Z` / `+Y` / `+Shift+Z`，调 `store.undo/redo`

### 1.2.1 □ Cell 编辑提交触发两次 commit（playwright 抓到的 bug，未修）
- **现象**：在单元格里输入并按 Enter 后，`Cell.commitEdit` 被调用两次：第一次来自 `<input>` 的 `onKeyDown`（Enter），第二次来自 `<Show>` 把 input 摘下来时触发的 `onBlur`
- **后果**：每次编辑产生两条 undo 条目（第二条 before==after，是空操作但占栈）；第一次按 Cmd/Ctrl+Z 看不到任何变化，第二次才真正撤销
- **重现**：`solid/excel/e2e/smoke.spec.ts` "Ctrl/Cmd+Z undoes" 测试目前要按两次 Meta+Z 才能回到空，已在测试里注释标注
- **修复路径**：`Cell.tsx::commitEdit` 加幂等守卫——`if (!editing()) return`——或者 commit 后才 `setEditing(false)`，以及把 `onBlur` 改成判断当前是否还在 editing
- **延后理由**：本次 PR 范围只是 e2e 套件落地，应用源代码改动须独立 commit + review

### 1.3 ✅ Ctrl+C / Ctrl+V 系统剪贴板 — 已做
- **代码**：`SheetStore.copy(addrs[][])` / `paste(originAddr, data)` 已有；paste 已做相对引用偏移
- **新增（本批次）**：
  - SheetStore 加 `selectionRange()` / `setSelectionAnchor()` / `extendSelection()` / `selectionAddrs()`；`selection()` / `setSelection()` 语义不变（focus cell；setSelection 折叠 range）
  - SheetStore 暴露 `serializeClipboardTSV` / `parseClipboardTSV` 两个 helper，供 Table.tsx 与测试共用
  - Table.tsx 处理 Shift+ArrowUp/Down/Left/Right → `extendSelection`；普通 Arrow / Tab 仍走 collapse
  - Table.tsx 处理 Cmd/Ctrl+C / V / X：写入 `navigator.clipboard.writeText` / 从 `readText` 读回；剪切 = 复制 + clearCell（一条 undo）
  - Cell.tsx 加 `inRange` prop + `cell-in-range` 类；styles.css 加浅蓝底色（`#f1f6ff`），focus cell 仍是 `cell-selected`（深蓝 + outline）
  - Shift+Click 在 Cell 上调 `onExtendSelect` → `extendSelection`
  - Delete/Backspace 现在清空整个 selection range（一条 undo），不再仅 focus cell
- **剪贴板序列化格式**（写入系统剪贴板）：
  ```
  # einfach-clipboard-origin: <topLeftAddr>\n
  cell\tcell\tcell\n
  cell\tcell\tcell
  ```
  marker 行让同一 app 再次粘贴时能恢复 origin → 触发相对引用偏移；marker 缺失（外部剪贴板）时 fallback 到 paste target，按字面 paste 不偏移
- **测试**：`solid/excel/test/sheet-store.test.ts` 加 12 个用例（selection range 5 + TSV helper 5 + copy/paste roundtrip 2）
- **未做 / 已知限制**：
  - jest 不走 `navigator.clipboard`（jsdom 不稳定）— 只测 helper；浏览器内手测靠 `npm run dev`
  - `navigator.clipboard` 需要 secure context（HTTPS 或 localhost）且需用户手势；非安全上下文下 Ctrl+C/V 静默失败
  - playwright clipboard e2e 需要权限授予（`context.grantPermissions(['clipboard-read', 'clipboard-write'])`），本批次未加（保持 7 个 smoke 测试不动）

### 1.4 ✅ Delete 键清空选中 — 已做
- `Table.tsx::onKeyDown` `case 'Delete'/'Backspace'` 调 `store.clearCell`，走 undo

### 1.5 ⚠️ 多 sheet UI（tab 栏 + 切换）— UI landed with JS-side mock; WasmWorkbook binding still deferred
- **代码**：`Workbook { sheets, names }` API 完整（add/rename/remove/sheet_by_name）；`get_cell` 真能跨 sheet 算
- **已落地**（JS-side mock）：
  - `solid/excel/src/workbook-store.ts` — `createWorkbookStore()` 镜像了 Rust `Workbook` 的 add/rename/remove/sheet/active 语义；每张 sheet 是 `createSheetStore(createJSSheet())`
  - `solid/excel/src/SheetTabs.tsx` — 底部 tab 栏，点击切换 / `+` 新增 / 右键 prompt 改名+删除
  - `solid/excel/src/demos/MultiSheet.tsx` — 用 `Show keyed` 在 active 切换时重挂 Table，3 张预填 sheet
  - 单元测试：`solid/excel/test/workbook-store.test.ts`（16 用例）
- **跨 sheet eval gap（重要）**：JS 侧的 `createJSSheet()` 是单 sheet 求值器，没有 workbook 上下文；`=Sheet2!A1` 在这套 mock 里**不会真算**，会按"未识别的 ref"落到 `#ERROR!` / `0`。Rust `Workbook::get_cell` 的 cross-sheet resolver 没有 JS 对应物。这条 gap 在 WasmWorkbook 绑定上线（见下）+ 1.7 把 demo 切到 wasm sheet 之后自然消失
- **仍缺**：
  - `rust/wasm/src/lib.rs` 暴露 `WasmWorkbook`（add_sheet / sheet_at / sheet_count / rename_sheet / remove_sheet / get_cell 跨 sheet）
  - JS 侧加 `createWasmWorkbookSheet(workbook, idx): ISheet` 工厂，让 `createWorkbookStore` 可选地切到 wasm 后端
  - 真做完之后：`MultiSheet` demo 增加跨 sheet 公式样例（e.g. Notes!A1 = `=Expenses!B5`），把 gap 消掉

### 1.6 □ 行列插入 / 删除 UI（右键菜单）
- **代码**：`Sheet::insert_row/delete_row/insert_col/delete_col` + 自动 ref 调整都已就位；JS mock 也对齐了；SheetStore 已暴露 `insertRow/deleteRow/insertCol/deleteCol` wrapper
- **缺**：
  - 右键菜单组件
  - 这几个 wrapper 还没走 undo（结构性编辑 snapshot 太大；见 TODO 1.6.1）

#### 1.6.1 □ 结构性编辑 undo
- **现状**：sheet-store 的 row/col API 直接转发，**不可 undo**
- **路径**：要么记录全 sheet 快照（贵），要么记录 reverse op（insert_row 的 reverse 是 delete_row + 把删的内容放回）
- **判断**：等 lazy formula 切换后，formula 不再持有 derived atom，sheet 的状态量级变小，全快照才可控

### 1.7 ✅ Solid demo 实际加载 WASM — DemoFormulas 已切
- **DemoFormulas**：已通过 `createWasmSheet()` 工厂加载 Rust WASM 后端，SUM / AVERAGE / COUNT / MIN / MAX / IF 在首屏渲染真实数值
- **plumbing**：`solid/excel/vite.config.ts` 加了 `vite-plugin-wasm` + `vite-plugin-top-level-await`；`solid/excel/src/wasm-sheet.ts` 包 wasm-pack 输出（`./wasm-pkg/`，`.gitignore` 已忽略）；`build:wasm` script 跑 `wasm-pack build --target web --out-dir ./wasm-pkg ../../rust/wasm`
- **其他 demo（Blank/Budget/Grades/Sales）**：仍用 `createJSSheet`（评估器子集足够）。切换是单行替换 `createSheetStore` 入参
- **构建前置**：`rustup target add wasm32-unknown-unknown` + `cargo install wasm-pack`；`Cargo.toml` 关掉了 `wasm-opt`（GitHub binaryen 下载在受限网络里挂；`opt-level = "s"` + lto 已经够）
- **测试影响**：jest 仍走 JS mock（339 用例不变），`createWasmSheet` 只在浏览器/dev server 跑

### 1.8 □ 格式化 UI
- **代码**：`CellFormat` + `apply_rules` + `ConditionalRule` 后端齐全
- **缺**：
  - SheetStore 没暴露 set_format / get_format
  - 工具栏 UI（粗体/斜体/对齐/颜色按钮）
  - 条件格式规则编辑器
- **最小步骤**：
  1. SheetStore 加 `format` Map 维护 per-cell 格式
  2. Cell 渲染时合并 base + 条件规则得到最终样式
  3. 工具栏组件分开做

## 2. 工具链 / 工程

### 2.1 ✅ tsconfig 治理 — 已做
- `solid/excel/tsconfig.json` extends base + 加进根 references，src .tsx 删除了 `@jsxImportSource` pragma

### 2.2 □ rollup 跳过 demo 应用更优雅
- **现状**：rollup.config.mjs 用 `fs.existsSync(p+'/src/index.ts')` filter
- **更好做法**：在每个 demo 应用的 package.json 加 `"private": true`，rollup 读 package.json 跳过 private（跟 npm 语义一致）

### 2.3 □ wasm-bindgen-test 端到端
- **现状**：`cargo test` 跑的是原生 target；wasm32 行为没验证
- **依赖**：`wasm-pack test --headless --chrome`
- **必须覆盖**：subscribe/unsubscribe 跨 JS↔Rust 边界、重入保护、JsCallbackListener panic 不挂 wasm 实例

### 2.4 ⚠️ playwright e2e 套件
- **现状**：`solid/excel/e2e/smoke.spec.ts` 落地，覆盖 cell 编辑提交 / 公式提交 / 依赖传播 / undo / redo / FormulaBar 公式源同步 / 键盘导航（Arrow+Tab+Shift+Tab），共 7 个测试。`@playwright/test` 已加入 devDependencies；`solid/excel` 下 `npm run e2e` 启动 vite dev server + 跑测试
- **缺**：CI 集成（仓库当前没 CI workflow）、render counter 验证精准订阅、fps benchmark；首次跑前需要 `npx playwright install chromium` 下载浏览器

### 2.5 □ benchmark harness
- **缺**：criterion 依赖 + benches/atom_bench.rs / sheet_bench.rs
- **要测的**：
  - 1 万 cell 写入
  - 100 公式链传播
  - SUM(A1:A10000)
  - destroy/create 1 万 atom 内存稳定
  - unsub 1 万订阅 < 1ms
  - lazy formula 上线后：100k 公式 import eval count == 0 的回归门禁

### 2.6 □ wasm panic 端到端
- **现状**：`console_error_panic_hook` 已装，但没确认浏览器里 panic 真的出现在 console
- **验证**：写一个 wasm-bindgen-test 故意 panic 看 console 输出

## 3. 后端漏的角落

### 3.1 ✅ Workbook 跨 sheet eval — 已按 lazy 读路径修
- **现状**：`Workbook::get_cell` 走 `WorkbookEvalProvider`，在读取公式时递归进入当前 sheet / 目标 sheet 的 lazy formula record。Workbook 读取会绕过 formula cache，因此 `Sheet1 -> Data -> Other` 这种跨 sheet 链能读到 live 值；普通 `Sheet::get_cell` 仍使用同 sheet dirty/cache。
- **回归门禁**：`cross_sheet_formula_evaluates` / `workbook_get_cell_walks_local_dep_chain_to_cross_sheet` / `workbook_get_cell_only_recomputes_formulas_on_target_dep_chain` / `workbook_get_cell_no_cross_sheet_chain_does_no_recompute`。derived recompute 计数现在应保持 0，因为公式不再由 core derived atom 承载。
- **仍缺**：跨 sheet 订阅 / workbook-wide 反向依赖图。写 `Data!A1` 不会主动通知 `Sheet1!B1` subscriber；读取 `Sheet1!B1` 是正确的。

### 3.2 □ TODAY/NOW 没 wasm32 实测
- **现状**：chrono `wasmbind` feature 已开，本机测试 OK
- **风险**：浏览器里 `Local::now()` 是否真返回当地时间没在浏览器实测；可能需要 `js-sys::Date` fallback

### 3.3 ✅ approximate-match VLOOKUP / HLOOKUP — 已做
- 第 4 个参数支持 TRUE/FALSE/数值，TRUE 走二分 approximate，FALSE 精确

### 3.4 □ TEXT(value, format)
- **现状**：未实现
- **缺**：format 字符串 mini parser（类似 `0.00`, `#,##0`, `yyyy-mm-dd`）— CellFormat 的 NumberFormat 是同类需求，可共享

### 3.5 □ 函数注册表重构
- **现状**：`eval_func` 是个 ~30-arm `match` 块（约 500 行）
- **建议**：当函数 ≥ 50 个时改成 `HashMap<&'static str, fn(...) -> Value>`

### 3.6 □ 排序 / 筛选
- **代码**：CellRange 已就位
- **缺**：排序是视图层逻辑（不改 atom），需要 SheetStore 维护 view 状态 + 渲染时按 view 顺序遍历

### 3.7 □ 行列宽度 / 冻结首行
- **缺**：纯 UI / SheetStore 状态，后端无关

### 3.8 □ JSON 导入导出 / 自动保存
- **代码**：CSV 已做
- **缺**：JSON 序列化整个 sheet（含公式）；localStorage 自动保存

### 3.9 □ 跨 sheet 环检测
- **现状**：`would_create_cycle` 只看本 sheet `formula_exprs`
- **缺**：workbook 范围反向依赖图
- **暂时兜底**：lazy formula 的 `Computing` runtime 状态会防栈溢出，错误显示为 `#CYCLE!`

### 3.10 □ primitive atom GC
- **现状**：`set_cell(addr, Value::Null)` 不释放 primitive atom
- **影响**：长期运行慢慢增长；不致命，单独 issue 跟踪

## 4. Lazy formula 路线（见 LAZY_FORMULA_EVAL.md）

### 4.1 ⚠️ Step 0 — debug 计数 / 探针 API
- `debug_primitive_atom_count` / `debug_formula_count` / `debug_formula_eval_count` / `debug_dirty_formula_count` / `debug_dependents_count(addr)` / `debug_cache_state(fid)`
- 配套 benchmark：100k import eval==0 / viewport read 100 / 公式引用空 cell atom==0 / 写空 cell 后 dirty

### 4.2 ⚠️ Step 1 — EvalProvider 抽出 + Workbook 接入
- 已加 `EvalProvider` / `eval_expr_with_provider`
- `Sheet` 默认 provider + `WorkbookEvalProvider` 已接入，Workbook 不再依赖 read-time derived 重算 bridge
- `with_cross_resolver` / TLS 仍保留为旧 `eval_expr(get, cell_map)` 兼容入口，后续可独立删除

### 4.3 ⚠️ Step 2 — lazy formula 主体
- 已上 `FormulaRecord` / `FormulaCache` / `cell_dependents`，无 feature flag，直接替换旧 derived formula 路径
- D1 契约已切换：formula subscriber 收 dirty 通知，不为保持精确值变化而提前计算
- 未做：`range_dependents` interval index、`BulkLoader`、更完整的 eval/debug 计数
- 验收硬门禁：跑 Solid demo 5 页 + DemoFormulas 无可见回归

### 4.4 □ Step 3 — bulk import API（CSV/JSON/xlsx 接入路径）
### 4.5 □ Step 4 — range streaming 改造
### 4.6 □ Step 5 — range dependency interval index
### 4.7 □ Step 6 — feature flag 拆除 + 旧路径删除
- grep 门禁：sheet 公式路径不再调用 `Store::create_derived` / `Store::propagate_force`；`formula_cells` 仍存在但 value 已是 `Rc<FormulaRecord>`，不是 `AtomId`

## 5. 7B / 7C 工程

### 5.1 □ 7B 虚拟滚动
- **依赖**：Solid 虚拟滚动组件（自写或选 `@solid-primitives/virtual`）
- **关键约束**：cell 进出视口时 subscribe/unsubscribe（精准订阅已就位）
- **门禁**：playwright + chrome devtools Performance.metrics 实测 fps
- **关联**：lazy formula 落地后，viewport 才真是计算边界

### 5.2 □ 7C Web Worker
- **依赖**：wasm-pack + worker bundling
- **关键约束**：JsCallbackListener 不能跨 worker；7C adapter 改成 `PostMessageListener`（trait 已抽好）
- **设计**：主线程发 `{ kind: 'set_number', addr, value }` postMessage；worker 内执行 + subscribe；worker 主动 postMessage `{ kind: 'cell_changed', addr, display }` 通知主线程

## 6. ISSUES.md 里"轻"级未做的

| Issue | 当前状态 |
|---|---|
| A.10 store.rs 1000+ 行单文件 | 未拆 |
| B.5 SUM/COUNT/AVERAGE 字面量 vs cell 引用区分 | 未修 |
| B.7 MIN/MAX 空集返回 0 | 未修 |
| B.9 parse error 信息丢失 | 未修；ParseError { pos, expected, got } 需要 |
| C.5 get 是 &mut self | 未修；需要 peek_cell(&self) 拆分 |
| C.7 batch_set 只支持 number | 未扩展（text / formula 版本） |
| C.9 value_to_display 阈值 | 未改 |
| D.2 createJSSheet 用 Function() | 短期保留；长期靠 1.7 wasm 后端切换消除 |
| D.5 sheet-store signal map 不清理 | 部分修：dispose() 已有，但没在组件 unmount 自动调 |
| D.6 raw 字段 @deprecated 但没删 | 未删；测试在用 |
| D.7 setTimeout focus | 未改 |
| D.8 cellValue() 重复调用 | 未改 |
| D.10 demo 函数体长串初始化 | 未改 |

## 7. 已修但需要回归保护的

每条都需要 wasm-bindgen-test 或 playwright e2e 加固，目前只在原生 cargo test / jest 验过：
- C.1 + C.2 subscribe propagation
- C.3 reentrancy（listener 内回调 set 的实际浏览器行为）
- C.10 panic hook 是否真把 panic 送到 console.error
- TODAY/NOW 浏览器时区行为
- Workbook 跨 sheet eval（本批次新修）

---

## 优先级建议

**最划算**（小改动 / 大用户感知）：1.3 Ctrl+C/V、1.6 右键菜单、1.7 WASM 加载（DemoFormulas 关键）

**为长期未来铺路**：4.x lazy formula 路线（按 Step 0/1/2 顺序）、5.1/5.2 7B/7C、2.3/2.4 e2e harness

**可以一直拖**：6 段轻级 issues、3.4/3.5/3.6/3.7/3.8 各种功能扩展
