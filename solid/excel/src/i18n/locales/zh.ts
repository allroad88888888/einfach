/**
 * Chinese catalog. Same keyspace as en.ts; missing keys fall back to the
 * raw msgId via `@lingui/core` (matches the lingui default behavior).
 *
 * The `nav.*` labels are translated (空白 / 公式 / …) — only the EN
 * catalog keeps the original English literals. e2e specs still pass
 * because the default locale is `en` and the suite never flips it
 * before calling `gotoDemo(page, '<English name>')`. If a future
 * change defaults to `zh`, helpers will need to either translate their
 * `gotoDemo` argument or call `setLocale('en')` first.
 */
export const messages: Record<string, string> = {
  // App chrome
  'app.title': 'Einfach 表格',
  'app.subtitle': 'Rust + WASM + SolidJS',
  'locale.en': 'EN',
  'locale.zh': '中',

  // Tab-bar labels — Chinese translations for the visible navigation.
  'nav.blank': '空白',
  'nav.formulas': '公式',
  'nav.budget': '预算',
  'nav.grades': '成绩计算',
  'nav.sales': '销售看板',
  'nav.multi': '多 Sheet',
  'nav.cross': '三 Sheet 链',
  'nav.large': '大表格',
  'nav.worker': 'Worker',
  'nav.million': '百万格',
  'nav.vnext': 'vNext',

  // Demo headings + descriptions.
  'demo.blank.title': '空白表格',
  'demo.blank.desc.beforeCode': '双击任意单元格编辑。输入数字、文本或公式（以',
  'demo.blank.desc.beforeEnter': '开头）。按',
  'demo.blank.desc.beforeEsc': '确认，',
  'demo.blank.desc.afterEsc': '取消。',

  'demo.formulas.title': '公式示例',
  'demo.formulas.desc.beforeDiv': '试着修改蓝色数字 — 所有公式会自动更新。单元格 E4 显示',
  'demo.formulas.desc.afterDiv': '（除零错误）。F8→G8→H8→I8 链路会跨 4 层依赖传播。',

  'demo.budget.title': '月度预算',
  'demo.budget.desc': '编辑「预算」（B 列）和「实际」（C 列）。「差额」列和汇总行会自动更新。差额为正表示预算结余，为负表示超支。',

  'demo.grades.title': '成绩计算器',
  'demo.grades.desc': '修改任意成绩 — 平均分、最高、最低及全班统计立刻重算。每位学生行使用 AVERAGE / MAX / MIN。',

  'demo.sales.title': '销售看板',
  'demo.sales.desc.before': '季度销售报表，自动汇总、平均与 KPI 计算。修改任意销售数字 — 看板实时更新。增长率按',
  'demo.sales.desc.after': '计算。',

  'demo.multi.title': '多 Sheet 工作簿',
  'demo.multi.desc.beforePlus': '点击 tab 切换 sheet。点击',
  'demo.multi.desc.afterPlus': '新增 sheet。右键 tab 重命名 / 删除。每个 sheet 拥有独立的状态、撤销栈和选择。',

  'demo.cross.title': '三 Sheet 依赖链',
  'demo.cross.desc.lazyProbe': '懒读探针：',
  'demo.cross.desc.cache': '，缓存',

  'demo.large.title': '大表格 — 行虚拟化',
  'demo.large.desc': '1000 行 × 26 列。只有视口可见行（加少量 overscan）在 DOM 里 — 滚动可看到新行即时填充。方向键超出视口时，焦点格自动滚回视野。',

  'demo.worker.title': 'Worker 后端表格',
  'demo.worker.desc': 'WASM 运行在 Web Worker 里；主线程只负责传递 diff。在格子里输入、写公式 — 行为和其它 demo 一致，只是计算挪到了另一线程。对密集计算负载有用（UI 不卡）。',

  'demo.million.title': '百万格 Worker Demo',
  'demo.million.desc': '1000 × 1000 = 100 万个可寻址单元格，Web Worker 后端。只播种少量种子，其余保持稀疏。二维虚拟化只渲染视口范围。',
  'demo.million.import.choose': '导入 CSV/TSV',
  'demo.million.import.cancel': '取消',
  'demo.million.import.status.running': '导入中',
  'demo.million.import.status.committed': '导入完成',
  'demo.million.import.status.cancelled': '导入已取消',
  'demo.million.import.status.failed': '导入失败',
  'demo.million.import.stats': '{rows} 行，{cells} 个单元格，{chunks} 个分块，{errors} 个错误',
}
