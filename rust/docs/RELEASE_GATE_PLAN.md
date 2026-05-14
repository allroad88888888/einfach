# 发布门禁执行计划

> 日期：2026-05-14
>
> 当前基线：`0cf1ef3 feat(solid-excel): harden virtualized UX gates`
>
> 目标：在不 `git push`、不改 `.github/workflows/*` 的前提下，用本地命令和 MCP
> Playwright 记录确认在线电子表格 MVP 的发布状态。

## 当前约束

- 仓库没有统一 root Cargo workspace gate；Rust 必须按 crate manifest 或 crate 目录执行。
- `rust/excel-core` 的 clippy 存在历史 baseline；本轮作为 advisory，不作为 blocking。
- `solid/excel` 的 Playwright webServer 已自动执行 `build:wasm`，但它不能替代 Rust/Jest/TS
  门禁。
- 任何 UI/browser 行为相关改动都需要 Playwright CLI + MCP Playwright/Chrome 复核。
- 不改 `.github/workflows/*`；CI promotion 只在用户放开后处理。

## Blocking Gate

### JS / TS / Solid

```sh
cd /Volumes/work/self/einfach
npm run build
npm test
npx tsc -p solid/excel/tsconfig.json --noEmit
npm run build:wasm -w @einfach/solid-excel
npm run build -w @einfach/solid-excel
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
```

说明：

- `npm run build` 会跑 root TS build + rollup。
- `npm test` 是全量 Jest + coverage。
- `solid/excel` 单独 typecheck 防止 Vite build 漏掉类型问题。
- 全量 e2e 当前基线为 `23 spec / 163 active tests / 0 skip`。

### Rust / WASM

```sh
cd /Volumes/work/self/einfach
cargo test --manifest-path rust/core/Cargo.toml
cargo test --manifest-path rust/excel-core/Cargo.toml
cargo bench --manifest-path rust/excel-core/Cargo.toml --no-run
cargo test --manifest-path rust/wasm/Cargo.toml
cargo build --manifest-path rust/wasm/Cargo.toml
wasm-pack test --headless --chrome rust/wasm
```

说明：

- 改 Rust 时 `cargo bench --no-run` 仍是 blocking；它能捕获 bench harness 与引擎 API
  签名漂移。
- `wasm-pack test --headless --chrome rust/wasm` 是 WASM 浏览器行为的 blocking gate；
  Node 版只能作为 fallback。

## Advisory Gate

```sh
cd /Volumes/work/self/einfach
cargo clippy --manifest-path rust/excel-core/Cargo.toml --lib
wasm-pack test --node rust/wasm
npm run eslint
```

说明：

- `cargo clippy` 当前受历史 baseline 影响，不阻断本轮发布判断。
- `npm run eslint` 带 `--fix`，更像清理动作，不作为纯验证命令。

## MCP Playwright 验收

本地启动：

```sh
cd /Volumes/work/self/einfach/solid/excel
npm run dev -- --port 5174 --strictPort
```

MCP 需要覆盖：

- `1M Cells`：toolbar 可见；大选区点击 Bold 只触发 `set_format_range`；DOM cell 数保持
  viewport 级别。
- `1M Cells`：键盘从 `A1` 跨初始虚拟视口移动到远端 cell，目标 cell 可见且 selected。
- `Blank`：选中 `A1:B2`，在 range 内右键 `B1` 执行 Clear，四个 cell 均清空。
- `Multi-Sheet`：worker-backed 三 sheet、跨 sheet formula、add/rename/delete、lazy cache
  probe 正常。
- `Formulas` / `Multi-Sheet`：非法公式和循环公式展示 diagnostics，合法公式清理错误。
- console warning/error 为 0 或仅有明确 allowlist。

## 发布 Blocker 定义

以下任一项失败都应停止发布：

- 未读公式在 import / write 阶段被计算。
- 空 cell read/subscribe/reference 物化 primitive atom。
- 1M 视口滚动后 DOM 或 active subscriptions 随历史滚动累计增长。
- 大 range clear/format/copy/export 在主线程展开百万地址。
- worker-backed formula mutation 失败后 UI 永久显示成功。
- worker import cancel 后 session 泄漏。
- MCP Playwright 不能验证 UI 行为且没有明确失败原因和 CLI 兜底记录。

