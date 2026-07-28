# CC-A 审 CC-B：W0 对话框状态迁移

- **Reviewer**: CC-A ｜ **被审对象**: 工作树未提交态（基线 `2feea48`，19 个文件：5 个 Solid 对话框 + 5 组 core index/types + 4 个 core test + i18n）
- **性质**: 独立第二审（主审已判 `MainReview → Rework`，见 MULTI_AGENT_EXECUTION.md:145）
- **判定**: **维持 `Rework`**——主审四类阻断经独立核实全部属实并补齐硬证据，另有 2 项主审未列的新发现。迁移方向正确（边沿重置下沉 core、debugLabel 全合规、无 per-cell family、name-box 自洽），不必推倒。

## 阻断项（与主审重合，补硬证据）

1. **BLOCKER｜DV 双草稿源有真实消费者读陈旧侧**：`data-validation/index.ts:171-178` `validationStatusAtom` 仍读 `editor.draft`，而对话框只写新的 `validationRuleFormAtom`、从不回写 draft → 内联校验预览用打开时的旧规则，可复现漂移。且 `setValidationDraftAtom`（:99）仍是公开第二写入口。
2. **BLOCKER｜DV 保存/清除晚回执无条件关后开的编辑器**：`SpreadsheetDataValidationDialog.tsx` `handleSave/handleClear` await 后直接 `closeEditor()`，无 session ticket；A 会话迟到回执会关闭 B 会话。
3. **BLOCKER｜Find/Replace backend 调用留在 Solid、结果/选区无 ticket**：`runSearch` await 后 `setMatches` + `focusMatch`（移动选区），新查询/重开后旧结果仍会覆盖 cursor 并跳选区；replace 同理。
4. **BLOCKER｜Protection close 不清密码、不作废 ticket**：`protection/index.ts:220-222` `closeProtectionUnlockAtom` 只复位 state；明文密码驻留 atom 至下次打开边沿才清；ticket 作废只写在组件 `handleClose`，其它关闭路径绕过。
5. **BLOCKER｜retarget（open-while-open）不重置、不换 ticket**：`openProtectionUnlockAtom` / `openValidationRuleEditorAtom` 仅在 closed→open 分支清理；target A→B 时密码/表单保留、在飞回执判不出 stale。**DV 测试 `opening an already-open editor preserves the in-progress form` 把该污染固化为预期语义，需一并修订。**

## 新发现（主审未列）

6. **MAJOR｜条件格式同类晚回执缺口无人认领**：CF 迁移质量最高（单一源 + begin/settle 生命周期 + pending 防重复），但 `handleSave` 仍无 ticket——await 期间关旧开新，迟到 `settle/close` 作用到新 editor。主审阻断表未列 CF。
7. **minor｜i18n 迁进了独立第二 store**：`excel/solid-excel/src/i18n/index.ts:46` `createStore()` 私有实例，`localeAtom` 脱离主 store（devtools/状态巡检不可见）。非阻断，建议收敛进主 store 或文档标注隔离边界。
8. **minor｜新增 atom 未回写 feature README 的 source/derived/command 分类**（CLAUDE.md 惯例）：`validationRuleFormAtom`、`findReplaceFormAtom`、`protectionUnlockPasswordAtom`、`nameBoxFocusedAtom` 等。

## 正向确认

- name-box 现为 212 行、结构闭合无残片，signal→atom 迁移干净（原 signal 删净、读写侧对齐）——**通过**。
- debugLabel 命名、无 per-cell family、bounded cap、测试无既有断言被削弱（除上述 1 处固化 bug 语义）——**通过**。

## Rework 最小修复集

1. DV 收敛单一草稿源（删 form atom 直编 draft，或 status/保存全走 form 并移除第二写入口）。
2. DV / Find-Replace / CF 统一 session ticket 进 core：回执按 ticket 校验，晚回执不得关闭或覆盖新会话。
3. Protection 的 close/open/retarget 命令在 core 内清密码 + 递增 ticket，作废约束搬出组件。
4. retarget 分支重置表单/密码并换 ticket；修订 DV 那条固化污染语义的测试。
5. 补三条竞态测试：关闭重开为 B / 未完成再发请求 B / target A→B。

次要随修：i18n store 收敛或加注、README 分类回写。若时间紧可分两步：先以 core ticket 关掉竞态血流，backend 生命周期整体迁 core 作为跟进项。

---

_CC-B 修复后请在本文件追加"回应"小节（规则见 reviews/README.md #5）。_
