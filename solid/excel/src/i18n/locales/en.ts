/**
 * English catalog. Keys mirror the strings as they appear in the UI;
 * the catalog is the source of truth for the EN copy so the underlying
 * components stay free of literal text.
 *
 * Conventions:
 *   - `app.*`            : top-level app chrome (title, subtitle).
 *   - `locale.*`         : labels for the locale switcher itself.
 *   - `nav.<demoId>`     : tab-bar label, kept identical to the previous
 *                          literal so e2e `gotoDemo(page, '<name>')`
 *                          keeps working unchanged.
 *   - `demo.<id>.title`  : the `<h3>` heading inside `demo-header`.
 *   - `demo.<id>.desc`   : the prose description in `<p class="demo-desc">`.
 *                          Inline `<code>` / `<strong>` / `<kbd>` markup is
 *                          left in JSX (language-neutral); only the prose
 *                          flows through the catalog.
 */
export const messages: Record<string, string> = {
  // App chrome
  'app.title': 'Einfach Excel',
  'app.subtitle': 'Rust + WASM + SolidJS',
  'locale.en': 'EN',
  'locale.zh': '中',

  // Tab-bar labels — preserved verbatim to keep e2e literals stable.
  'nav.blank': 'Blank',
  'nav.formulas': 'Formulas',
  'nav.budget': 'Budget',
  'nav.grades': 'Grade Calc',
  'nav.sales': 'Sales Dashboard',
  'nav.multi': 'Multi-Sheet',
  'nav.cross': '3-Sheet Chain',
  'nav.large': 'Large Grid',
  'nav.worker': 'Worker',
  'nav.million': '1M Cells',

  // Demo headings + descriptions.
  'demo.blank.title': 'Blank Spreadsheet',
  'demo.blank.desc.beforeCode': 'Double-click any cell to edit. Type a number, text, or formula (start with',
  'demo.blank.desc.beforeEnter': '). Press',
  'demo.blank.desc.beforeEsc': 'to confirm,',
  'demo.blank.desc.afterEsc': 'to cancel.',

  'demo.formulas.title': 'Formula Showcase',
  'demo.formulas.desc.beforeDiv': 'Try changing the blue numbers — all formulas update automatically. Cell E4 shows',
  'demo.formulas.desc.afterDiv': '(division by zero). The chain F8→G8→H8→I8 propagates through 4 levels.',

  'demo.budget.title': 'Monthly Budget',
  'demo.budget.desc': 'Edit the Budget (B) and Actual (C) columns. The Diff column and summary rows update automatically. Positive diff = under budget, negative = over budget.',

  'demo.grades.title': 'Grade Calculator',
  'demo.grades.desc': "Edit any score — Average, Max, Min, and class statistics all recalculate instantly. Each student's row uses AVERAGE, MAX, MIN.",

  'demo.sales.title': 'Sales Dashboard',
  'demo.sales.desc.before': 'Quarterly sales report with automatic totals, averages, and KPI calculations. Edit any sales figure — the dashboard updates in real time. Growth rates are computed as',
  'demo.sales.desc.after': '.',

  'demo.multi.title': 'Multi-Sheet Workbook',
  'demo.multi.desc.beforePlus': 'Click a tab to switch sheets. Click',
  'demo.multi.desc.afterPlus': 'to add a new sheet. Right-click a tab for rename / delete. Each sheet has independent state, undo, and selection.',

  'demo.cross.title': '3-Sheet Dependency Chain',
  'demo.cross.desc.lazyProbe': 'Lazy probe:',
  'demo.cross.desc.cache': ', cache',

  'demo.large.title': 'Large Grid — Row Virtualization',
  'demo.large.desc': '1000 rows × 26 columns. Only the visible window plus a small overscan is in the DOM — scroll to see new rows hydrate on demand. Arrow-keys past the bottom of the viewport auto-scroll the focus cell back into view.',

  'demo.worker.title': 'Worker-backed Sheet',
  'demo.worker.desc': 'WASM runs in a Web Worker; the main thread only ferries diffs. Type into cells, create formulas — same Excel demo, just with the compute on a separate thread. Useful for very heavy recompute workloads (the UI stays responsive).',

  'demo.million.title': '1M-Cell Worker Demo',
  'demo.million.desc': '1000 × 1000 = 1,000,000 addressable cells over a Web Worker backend. Only a handful are seeded; the rest stay sparse. Two-dimensional virtualization renders just the viewport.',
}
