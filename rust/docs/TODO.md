# TODO — 没做完的角落

> 截至 `2267c54` HEAD。`✓` = 后端 / 库已就位但需要接线 / 测试 / 工具链；
> `□` = 完全没做。每条都有线索：哪个文件、为什么 deferred、最小可行步骤。

## A. UI 接线（后端就位 / UI 未接）

### A.1 ✓ FormulaBar 没接到 App
- **代码**：`solid/excel/src/FormulaBar.tsx` 已写完，`solid/excel/src/index.tsx` 已 export
- **验证（playwright）**：`document.querySelector('.formula-bar')` 在所有 demo 页都返回 `null`
- **缺**：App.tsx / 5 个 demo 都直接 `createSheetStore(createJSSheet())` 且没共享 selection signal，FormulaBar 拿不到 `activeAddr`
- **最小步骤**：
  1. demo 重构成接受 store + selection 作为 props
  2. App.tsx 在每个 demo 外层维护 `[selected, setSelected]`，传给 Table（controlled）+ FormulaBar
  3. FormulaBar 渲染在 Table 上方
  4. e2e: 选 B1 → 公式栏显示 `=A1*2`、地址 `B1`

### A.2 □ Ctrl+Z / Ctrl+Y 没绑全局
- **代码**：`SheetStore.undo()` / `redo()` / `canUndo()` / `canRedo()` 已存在并测过（`solid/excel/test/sheet-store.test.ts`）
- **缺**：没全局 keydown 监听
- **最小步骤**：在 App.tsx 或每个 demo 包装层 onKeyDown 监听 `(Ctrl|Meta)+Z` / `Y` / `Shift+Z` 调 store API

### A.3 □ Ctrl+C / Ctrl+V 没绑全局
- **代码**：`SheetStore.copy(addrs[][])` / `paste(originAddr, data)` 已存在并测过
- **缺**：
  - 没监听键盘
  - selection 当前是单 cell，没 SelectionRange — 复制范围需要先实现 Shift+方向键扩展选区
  - 没接 `navigator.clipboard.writeText/readText` — 只能在应用内剪贴板，不能跟外部 Excel/Sheets 互通
- **最小步骤**：
  1. Selection 模型加 `range: { start, end }`
  2. Shift+方向键扩展 range
  3. Ctrl+C 序列化为 TSV 写入 navigator.clipboard
  4. Ctrl+V 读 navigator.clipboard，按 \t/\n 切分调 paste

### A.4 □ Delete 键清空选中
- **代码**：`ISheet.clear_cell(addr)` / `Sheet::clear_cell` / `WasmSheet.clear_cell` 都已暴露
- **缺**：Table 的 onKeyDown 没 case `'Delete'`
- **最小步骤**：单行 — `case 'Delete': store.raw.clear_cell(coordToAddr(selected())); break;`（先用 raw，等 sheet-store 加 wrapper）

### A.5 □ 多 sheet UI（tab 栏 + 切换）
- **代码**：`Workbook { sheets, names }` API 完整（add/rename/remove/sheet_by_name）
- **缺**：
  - WasmSheet 只暴露 Sheet，没暴露 Workbook
  - SheetStore 假设单 sheet
  - 没 tab UI
- **最小步骤**：
  1. WasmWorkbook 包 Workbook，暴露 add_sheet / current_sheet / switch_to
  2. 新建 SolidJS WorkbookStore 取代 SheetStore（或 SheetStore 接受 sheet index）
  3. 底部 tab 栏组件
  4. 因为 wasm 还没接（A.7），暂时只在 createJSSheet 端用，结构先搭

### A.6 □ 行列插入 / 删除 UI（右键菜单）
- **代码**：`Sheet::insert_row/delete_row/insert_col/delete_col` + 自动 ref 调整都已就位
- **缺**：
  - 右键菜单组件
  - SheetStore 没暴露这 4 个方法
- **最小步骤**：sheet-store 加 4 个 wrapper；右键菜单是单独组件

### A.7 □ Solid demo 实际加载 WASM
- **现状**：所有 demo 都 `createSheetStore(createJSSheet())`
- **后果**：DemoFormulas 首屏 SUM(A,B,C) / AVERAGE / COUNT / MIN / MAX / IF 全 `#ERROR!`（playwright 已验证）
- **依赖**：
  - `wasm-pack build --target web rust/wasm`
  - `vite-plugin-wasm` + `vite-plugin-top-level-await` 或 `?init` 内联
  - 写 `createWasmSheet()` 工厂返回 ISheet
- **最小步骤**：见 ROADMAP 1A step 10 deferred 块

### A.8 □ 格式化 UI
- **代码**：`CellFormat` + `apply_rules` + `ConditionalRule` 后端齐全
- **缺**：
  - SheetStore 没暴露 set_format / get_format
  - 工具栏 UI（粗体/斜体/对齐/颜色按钮）
  - 条件格式规则编辑器
- **最小步骤**：
  1. SheetStore 加 `format` Map 维护 per-cell 格式
  2. Cell 渲染时合并 base + 条件规则得到最终样式
  3. 工具栏组件分开做

## B. 工具链 / 工程

### B.1 ✓ tsconfig 治理（D.12 临时方案）
- **现状**：每个 src .tsx 顶部加 `/** @jsxImportSource solid-js */` pragma 解决 tsc build；vite 跑时也有 `cannot be set without ... automatic JSX transform` 警告
- **正确做法**：
  1. `solid/excel/tsconfig.json` extends `tsconfig.base.json` + `composite: true` + `jsxImportSource: solid-js`
  2. 根 `tsconfig.json` references 加 `./solid/excel/tsconfig.json`
  3. 删掉所有 src .tsx 顶部的 pragma
  4. 验证 `tsc -build` + `npm run dev` 都不报 warning

### B.2 □ rollup 跳过 demo 应用更优雅
- **现状**：rollup.config.mjs 用 `fs.existsSync(p+'/src/index.ts')` filter
- **更好做法**：在每个 demo 应用的 package.json 加 `"private": true`，rollup 读 package.json 跳过 private（跟 npm 语义一致）

### B.3 □ wasm-bindgen-test 端到端
- **现状**：`cargo test` 跑的是原生 target；wasm32 行为没验证
- **依赖**：`wasm-pack test --headless --chrome`
- **必须覆盖**：subscribe/unsubscribe 跨 JS↔Rust 边界、重入保护（C.3）、JsCallbackListener panic 不挂 wasm 实例

### B.4 □ playwright e2e 套件
- **现状**：本次手工 e2e 验证了双击编辑 / 公式 / 公式保留（D.11）/ 键盘导航 / Cell 选中
- **缺**：CI 化、render counter 验证精准订阅、fps benchmark
- **依赖**：`playwright` + `@playwright/test`（不在 deps）

### B.5 □ benchmark harness
- **缺**：criterion 依赖 + benches/atom_bench.rs / sheet_bench.rs
- **要测的**：
  - 1 万 cell 写入
  - 100 公式链传播
  - SUM(A1:A10000)
  - destroy/create 1 万 atom 内存稳定
  - unsub 1 万订阅 < 1ms

### B.6 □ wasm panic 端到端
- **现状**：`console_error_panic_hook` 已装，但没确认浏览器里 panic 真的出现在 console
- **验证**：写一个 wasm-bindgen-test 故意 panic 看 console 输出

## C. 后端漏的角落

### C.1 □ Workbook 跨 sheet eval 解析
- **现状**：parser 已识别 `Sheet1!A1` → `Expr::SheetRef`；eval 单 sheet 上下文返回 `#REF!`
- **缺**：WorkbookContext 类型，把 SheetRef 解析成另一个 sheet 的 atom
- **设计**：eval_expr 加 trait `RefResolver`：
  ```rust
  trait RefResolver { fn resolve(&self, sheet: &str, addr: CellAddress) -> Option<Value>; }
  ```
  WorkbookContext 实现这个 trait

### C.2 □ TODAY/NOW 没 wasm32 实测
- **现状**：chrono `wasmbind` feature 已开，本机测试 OK
- **风险**：浏览器里 `Local::now()` 是否真返回当地时间没在浏览器实测；可能需要 `js-sys::Date` fallback

### C.3 □ approximate-match VLOOKUP / HLOOKUP
- **现状**：第 4 个参数（exact/approximate）被解析后忽略，永远走精确匹配
- **缺**：approximate 模式（要求 range 第 1 列已升序，二分查找最大 ≤ value）

### C.4 □ TEXT(value, format)
- **现状**：未实现（Phase 2 deferred）
- **缺**：format 字符串 mini parser（类似 `0.00`, `#,##0`, `yyyy-mm-dd`）— CellFormat 的 NumberFormat 是同类需求，可共享

### C.5 □ 函数注册表重构
- **现状**：`eval_func` 是个 ~30-arm `match` 块（约 500 行）
- **建议**：当函数 ≥ 50 个时改成 `HashMap<&'static str, fn(&[Expr], &dyn Fn(...), ...) -> Value>`

### C.6 □ 排序 / 筛选
- **代码**：CellRange 已就位
- **缺**：排序是视图层逻辑（不改 atom），需要 SheetStore 维护 view 状态 + 渲染时按 view 顺序遍历

### C.7 □ 行列宽度 / 冻结首行
- **缺**：纯 UI / SheetStore 状态，后端无关

### C.8 □ JSON 导入导出 / 自动保存
- **代码**：CSV 已做
- **缺**：JSON 序列化整个 sheet（含公式）；localStorage 自动保存

## D. 7B / 7C 工程

### D.1 □ 7B 虚拟滚动
- **依赖**：Solid 虚拟滚动组件（自写或选 `@solid-primitives/virtual`）
- **关键约束**：cell 进出视口时 subscribe/unsubscribe（C.4 已就位）
- **门禁**：playwright + chrome devtools Performance.metrics 实测 fps

### D.2 □ 7C Web Worker
- **依赖**：wasm-pack + worker bundling
- **关键约束**：JsCallbackListener 不能跨 worker；7C adapter 改成 `PostMessageListener`（trait 已抽好，C.11 / 1A step 7）
- **设计**：主线程发 `{ kind: 'set_number', addr, value }` postMessage；worker 内执行 + subscribe；worker 主动 postMessage `{ kind: 'cell_changed', addr, display }` 通知主线程

## E. ISSUES.md 里"轻"级未做的

| Issue | 当前状态 |
|---|---|
| A.3 NaN 位级比较 | 未修；需要 `if a.is_nan() && b.is_nan()` 兜底 |
| A.7 拓扑排序 LIFO | 未修；需要 VecDeque::pop_front() 给 FIFO |
| A.9 自循环测试 hacky | 未修；可换"两个互引派生"的等价测试 |
| A.10 store.rs 1000+ 行单文件 | 未拆 |
| B.5 SUM/COUNT/AVERAGE 字面量 vs cell 引用区分 | 未修 |
| B.6 MIN/MAX 空集返回 0 | 未修 |
| B.8 thunk 多包一层 | 未修 |
| B.9 parse error 信息丢失 | 未修；ParseError { pos, expected, got } 需要 |
| B.11 Range 孤立用法 | 当前返回 #VALUE! 跟 Excel 一致 ✅ |
| C.5 get 是 &mut self | 未修；需要 peek_cell(&self) 拆分 |
| C.6 fire 不检查值变化 | C.1+C.2 修后自动消失 ✅ |
| C.7 batch_set 只支持 number | 未扩展（text / formula 版本） |
| C.9 value_to_display 阈值 | 未改 |
| D.2 createJSSheet 用 Function() | 短期保留；长期靠 A.7 wasm 后端切换消除 |
| D.5 sheet-store signal map 不清理 | 部分修：dispose() 已有，但没在组件 unmount 自动调 |
| D.6 raw 字段 @deprecated 但没删 | 未删；测试在用 |
| D.7 setTimeout focus | 未改 |
| D.8 cellValue() 重复调用 | 未改 |
| D.10 demo 函数体长串初始化 | 未改 |

## F. 已修但需要回归保护的

每条都需要 wasm-bindgen-test 或 playwright e2e 加固，目前只在原生 cargo test 验过：
- C.1 + C.2 subscribe propagation
- C.3 reentrancy（listener 内回调 set 的实际浏览器行为）
- C.10 panic hook 是否真把 panic 送到 console.error
- TODAY/NOW 浏览器时区行为

---

## 优先级建议

**最划算**（小改动 / 大用户感知）：A.1 (FormulaBar 接线)、A.2 (Ctrl+Z)、A.4 (Delete 清空)、B.1 (tsconfig 收尾)

**先做才能继续大改**：A.7 (WASM 加载) — 这条不解决，DemoFormulas 永远首屏 #ERROR!

**为长期未来铺路**：C.1 (Workbook eval)、D.1/D.2 (7B/7C)、B.3/B.4 (e2e harness)

**可以一直拖**：E 段轻级 issues、C.3/C.4/C.5/C.6/C.7/C.8 各种功能扩展
