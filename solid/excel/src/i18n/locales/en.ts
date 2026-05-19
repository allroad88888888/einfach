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
  'nav.vnext': 'vNext',
  'nav.vnextWorker': 'vNext Worker',
  'nav.vnextWave5': 'vNext Wave 5',

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
  'demo.million.import.choose': 'Import CSV/TSV',
  'demo.million.import.cancel': 'Cancel',
  'demo.million.import.status.running': 'Importing',
  'demo.million.import.status.committed': 'Import complete',
  'demo.million.import.status.cancelled': 'Import cancelled',
  'demo.million.import.status.failed': 'Import failed',
  'demo.million.import.stats': '{rows} rows, {cells} cells, {chunks} chunks, {errors} errors',

  // === Wave 5 chrome — menu bar / toolbar / status bar ===
  // Menu bar — top level
  'menuBar.file': 'File',
  'menuBar.edit': 'Edit',
  'menuBar.insert': 'Insert',
  'menuBar.format': 'Format',
  'menuBar.data': 'Data',
  'menuBar.view': 'View',
  'menuBar.help': 'Help',
  // Menu bar — File
  'menuBar.file.new': 'New',
  'menuBar.file.open': 'Open…',
  'menuBar.file.save': 'Save',
  'menuBar.file.printPreview': 'Print Preview',
  'menuBar.file.close': 'Close',
  // Menu bar — Edit
  'menuBar.edit.undo': 'Undo',
  'menuBar.edit.redo': 'Redo',
  'menuBar.edit.cut': 'Cut',
  'menuBar.edit.copy': 'Copy',
  'menuBar.edit.paste': 'Paste',
  'menuBar.edit.pasteSpecial': 'Paste Special…',
  'menuBar.edit.find': 'Find…',
  'menuBar.edit.replace': 'Replace…',
  'menuBar.edit.goTo': 'Go To…',
  'menuBar.edit.delete': 'Delete Cells',
  'menuBar.edit.selectAll': 'Select All',
  // Menu bar — Insert
  'menuBar.insert.rowAbove': 'Insert Row Above',
  'menuBar.insert.rowBelow': 'Insert Row Below',
  'menuBar.insert.colLeft': 'Insert Column Left',
  'menuBar.insert.colRight': 'Insert Column Right',
  'menuBar.insert.sheet': 'Insert Sheet',
  'menuBar.insert.hyperlink': 'Hyperlink…',
  'menuBar.insert.comment': 'Comment',
  'menuBar.insert.nameManager': 'Name Manager…',
  // Menu bar — Format
  'menuBar.format.cells': 'Format Cells…',
  'menuBar.format.fillColor': 'Cell Color',
  'menuBar.format.textColor': 'Text Color',
  'menuBar.format.bold': 'Bold',
  'menuBar.format.italic': 'Italic',
  'menuBar.format.underline': 'Underline',
  'menuBar.format.conditional': 'Conditional Formatting…',
  'menuBar.format.validation': 'Data Validation…',
  'menuBar.format.hideRow': 'Hide Row',
  'menuBar.format.hideCol': 'Hide Column',
  'menuBar.format.freezePanes': 'Freeze Panes',
  // Menu bar — Data
  'menuBar.data.sortAsc': 'Sort Ascending',
  'menuBar.data.sortDesc': 'Sort Descending',
  'menuBar.data.filter': 'Filter…',
  'menuBar.data.textToColumns': 'Text to Columns…',
  'menuBar.data.removeDuplicates': 'Remove Duplicates…',
  'menuBar.data.validation': 'Data Validation…',
  // Menu bar — View
  'menuBar.view.zoomIn': 'Zoom In',
  'menuBar.view.zoomOut': 'Zoom Out',
  'menuBar.view.zoomReset': 'Zoom to 100%',
  'menuBar.view.formulaBar': 'Show Formula Bar',
  'menuBar.view.gridlines': 'Show Gridlines',
  'menuBar.view.headings': 'Show Headings',
  'menuBar.view.freeze': 'Freeze Panes',
  'menuBar.view.unfreeze': 'Unfreeze Panes',
  'menuBar.view.fullScreen': 'Full Screen',
  // Menu bar — Help
  'menuBar.help.shortcuts': 'Keyboard Shortcuts',
  'menuBar.help.about': 'About',
  // Menu bar — placeholder tooltips
  'menuBar.placeholder.comingSoon': 'Coming soon',
  'menuBar.placeholder.wave6': 'Coming in Wave 6',
  'menuBar.placeholder.wave7': 'Coming in Wave 7',
  'menuBar.placeholder.wave8': 'Coming in Wave 8',
  'menuBar.placeholder.newWorkbook': 'New workbook is not wired yet',
  'menuBar.placeholder.openFile': 'Open is not wired yet',
  'menuBar.placeholder.saveFile': 'Save is not wired yet',
  'menuBar.placeholder.closeFile': 'Close is not wired yet',
  'menuBar.placeholder.hyperlink': 'Hyperlink editor not wired yet',

  // Toolbar buttons
  'toolbar.bold': 'B',
  'toolbar.bold.title': 'Bold',
  'toolbar.italic': 'I',
  'toolbar.italic.title': 'Italic',
  'toolbar.fillColor': 'Fill',
  'toolbar.fillColor.title': 'Fill color',
  'toolbar.textColor': 'Text',
  'toolbar.textColor.title': 'Text color',
  'toolbar.numberFormat': 'Num',
  'toolbar.numberFormat.title': 'Number format',
  'toolbar.merge': 'Merge',
  'toolbar.merge.title': 'Merge cells',
  'toolbar.unmerge': 'Unmerge',
  'toolbar.unmerge.title': 'Unmerge cells',
  'toolbar.find': 'Find',
  'toolbar.find.title': 'Find',
  'toolbar.printPreview': 'Print preview',
  'toolbar.printPreview.title': 'Print preview',
  'toolbar.painter': 'Painter',
  'toolbar.painter.title':
    'Format painter (single click to copy format; double click for sticky)',
  'toolbar.painter.title.sticky':
    'Format painter (sticky — click button or Esc to exit)',

  // Status bar
  'status.aggregate.sum': 'Sum',
  'status.aggregate.average': 'Avg',
  'status.aggregate.count': 'Count',
  'status.aggregate.numericCount': 'Numeric Count',
  'status.aggregate.min': 'Min',
  'status.aggregate.max': 'Max',
  'status.viewMode.normal': 'Normal',
  'status.viewMode.pageBreak': 'Page Break Preview',
  'status.viewMode.pageLayout': 'Page Layout',
  'status.inputMode.ready': 'Ready',
  'status.inputMode.edit': 'Edit',
  'status.inputMode.enter': 'Enter',
  'status.inputMode.point': 'Point',
}
