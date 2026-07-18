# reviews/ — 双会话交叉代码评审

本目录承载两个执行会话（下称 **CC-A** 与 **CC-B**）之间的**交叉代码评审记录**。`/root` 是两会话之外的固定主设计 / MainReview / 串行集成角色，不属于任一实现 owner，也不能替代非作者第二签。计划级评审基线是上层的 [REVIEW-2026-07-14.md](../REVIEW-2026-07-14.md)（不可回写）；本目录只放**代码级**评审。

## 规则

1. **命名**：`YYYY-MM-DD-<reviewer>-<被审工作包>.md`。例：`2026-07-14-CC-A-w0-dialog-migration.md`。
2. **交叉原则**：谁写的代码谁不自审。CC-A 的实现先由非作者 CC-B reviewer 第二签；CC-B 的实现先由非作者 CC-A reviewer 第二签；两者随后都进入独立的 `/root MainReview`。任一第二签或主审给出 blocker，工作包都回到原 owner `Rework`；`/root` 不代写修复。
3. **每条发现的格式**：severity（blocker/major/minor）+ 文件:行号 + 依据 + 修复建议。禁止无行号的泛泛之谈；禁止只勾"已看过"。
4. **判定值**（与 WORK_SPLIT_PROPOSAL §6.1 对齐）：reviewer 只出 `ApproveForMainReview` / `ChangesRequested(最小修复集)` / `Blocked(等待上游)`；`Accepted` 是 `/root MainReview` 的专属词，交叉评审不使用。既有文件中的"维持 Rework"等价于 `ChangesRequested`。
5. **评审对象必须可复现**：写明被审的 commit range（或"工作树未提交态 + 基线 commit"）。被审方修复后在原文件追加"回应"小节，不新开文件。
6. 评审记录本身走汇聚文件之外的路径，不占集成 owner 的仲裁额度；但评审结论是合入门禁的输入。

## 索引

| 日期       | Reviewer | 被审对象                                                    | 判定   | 文件                                                                               |
| ---------- | -------- | ----------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| 2026-07-14 | CC-A     | CC-B 的 W0 对话框状态迁移（工作树未提交态，基线 `2feea48`） | 见文件 | [2026-07-14-CC-A-w0-dialog-migration.md](./2026-07-14-CC-A-w0-dialog-migration.md) |
| （待）     | CC-B     | CC-A 的异步公式弧 10 提交（`5447501..2feea48`）             | —      | 建议文件名 `2026-07-14-CC-B-async-custom-formulas.md`                              |
