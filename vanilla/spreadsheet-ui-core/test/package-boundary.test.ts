import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type {
  BackendMutationResult,
  SetRangeLockPort,
  SetRangeLockRequest,
  SpreadsheetBackend,
} from '../src'
import {
  clipboardStateAtom,
  commentEditorDraftAtom,
  commentSessionAtom,
  conditionalFormatEditorAtom,
  diagnosticsAtom,
  editingSessionAtom,
  fillSeriesLocaleAtom,
  filterDropdownAtom,
  filterSortCapabilityAtom,
  filterSortDraftAtom,
  filterSortErrorAtom,
  filterSortLifecycleAtom,
  filterSortSessionIdAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  findReplaceQueryAtom,
  focusFormulaBarAtom,
  formulaBarDraftAtom,
  formulaBarStateAtom,
  formulaReferenceCaretAtom,
  formulaReferenceSessionAtom,
  getDisplayCellText,
  historyStackAtom,
  isHyperlinkValue,
  keyboardModeAtom,
  menuStateAtom,
  nameRegistryCacheAtom,
  pointerSessionAtom,
  presenceStateAtom,
  primarySelectionRegionAtom,
  printConfigStateAtom,
  selectionAtom,
  selectionRegionsAtom,
  setCommentDraftAtom,
  setFormulaBarDiagnosticAtom,
  setFormulaBarErrorAtom,
  setFormulaReferenceCaretAtom,
  sheetProtectionAtom,
  syncFormulaBarAtom,
  toolbarUiStateAtom,
  toggleFormulaBarAtom,
  toggleGridlinesAtom,
  toggleHeadingsAtom,
  validationRuleEditorAtom,
  viewportFreezeAtom,
  viewportHiddenAtom,
  viewportMetricsAtom,
  viewportShowFormulaBarAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  workspaceSessionAtom,
} from '../src'

const SRC_ROOT = join(process.cwd(), 'vanilla/spreadsheet-ui-core/src')

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const FORMULA_BAR_PUBLIC_STATE_IS_READ_ONLY: AtomHasPublicWrite<
  typeof formulaBarStateAtom
> = false

const FORMULA_BAR_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof formulaBarDraftAtom>,
  AtomHasPublicWrite<typeof focusFormulaBarAtom>,
  AtomHasPublicWrite<typeof syncFormulaBarAtom>,
  AtomHasPublicWrite<typeof setFormulaBarDiagnosticAtom>,
  AtomHasPublicWrite<typeof setFormulaBarErrorAtom>,
] = [true, true, true, true, true]

const FILTER_SORT_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof filterSortStateAtom>,
  AtomHasPublicWrite<typeof filterDropdownAtom>,
  AtomHasPublicWrite<typeof filterSortErrorAtom>,
  AtomHasPublicWrite<typeof filterSortSyncTicketAtom>,
  AtomHasPublicWrite<typeof filterSortSessionIdAtom>,
  AtomHasPublicWrite<typeof filterSortCapabilityAtom>,
  AtomHasPublicWrite<typeof filterSortDraftAtom>,
  AtomHasPublicWrite<typeof filterSortLifecycleAtom>,
] = [false, false, false, false, false, false, false, false]

const FORMULA_REFERENCE_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof formulaReferenceSessionAtom>,
  AtomHasPublicWrite<typeof formulaReferenceCaretAtom>,
] = [false, false]

const FORMULA_REFERENCE_CARET_COMMAND_IS_WRITABLE: AtomHasPublicWrite<
  typeof setFormulaReferenceCaretAtom
> = true

const COMMENT_EDITOR_DRAFT_PUBLIC_STATE_IS_READ_ONLY: AtomHasPublicWrite<
  typeof commentEditorDraftAtom
> = false

const COMMENT_EDITOR_DRAFT_COMMAND_IS_WRITABLE: AtomHasPublicWrite<typeof setCommentDraftAtom> =
  true

const VIEWPORT_HIDDEN_PUBLIC_STATE_IS_READ_ONLY: AtomHasPublicWrite<
  typeof viewportHiddenAtom
> = false

const VIEWPORT_CHROME_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof viewportShowGridlinesAtom>,
  AtomHasPublicWrite<typeof viewportShowHeadingsAtom>,
  AtomHasPublicWrite<typeof viewportShowFormulaBarAtom>,
] = [false, false, false]

const VIEWPORT_CHROME_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof toggleGridlinesAtom>,
  AtomHasPublicWrite<typeof toggleHeadingsAtom>,
  AtomHasPublicWrite<typeof toggleFormulaBarAtom>,
] = [true, true, true]

function readSourceFiles(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)

    if (stat.isDirectory()) {
      return readSourceFiles(path)
    }

    if (!entry.endsWith('.ts')) {
      return []
    }

    return [
      {
        path,
        text: readFileSync(path, 'utf8'),
      },
    ]
  })
}

describe('package boundary', () => {
  test('exports the first wave of UI core modules from the package root', () => {
    expect(selectionAtom.debugLabel).toBe('spreadsheet.selection.state')
    expect(keyboardModeAtom.debugLabel).toBe('spreadsheet.keyboard.mode')
    expect(editingSessionAtom.debugLabel).toBe('spreadsheet.editing.session')
    expect(formulaBarStateAtom.debugLabel).toBe('spreadsheet.formulaBar.state')
    expect(clipboardStateAtom.debugLabel).toBe('spreadsheet.clipboard.state')
    expect(formulaReferenceSessionAtom.debugLabel).toBe('spreadsheet.formulaReference.session')
    expect(formulaReferenceCaretAtom.debugLabel).toBe('spreadsheet.formulaReference.caret')
    expect(setFormulaReferenceCaretAtom.debugLabel).toBe('spreadsheet.formulaReference.setCaret')
    expect(pointerSessionAtom.debugLabel).toBe('spreadsheet.pointer.session')
    expect(menuStateAtom.debugLabel).toBe('spreadsheet.menu.state')
    expect(toolbarUiStateAtom.debugLabel).toBe('spreadsheet.toolbar.ui')
    expect(diagnosticsAtom.debugLabel).toBe('spreadsheet.diagnostics.state')
    expect(viewportMetricsAtom.debugLabel).toBe('spreadsheet.viewport.metrics')
    expect(workspaceSessionAtom.debugLabel).toBe('spreadsheet.workspace.session')
    expect(historyStackAtom.debugLabel).toBe('spreadsheet.history.stack')
    expect(selectionRegionsAtom.debugLabel).toBe('spreadsheet.selection.regions')
    expect(primarySelectionRegionAtom.debugLabel).toBe('spreadsheet.selection.primaryRegion')
    expect(nameRegistryCacheAtom.debugLabel).toBe('spreadsheet.namedRanges.cache')
    expect(viewportFreezeAtom.debugLabel).toBe('spreadsheet.viewport.freeze')
    expect(viewportHiddenAtom.debugLabel).toBe('spreadsheet.viewport.hidden')
    expect(commentSessionAtom.debugLabel).toBe('spreadsheet.comments.session')
    expect(fillSeriesLocaleAtom.debugLabel).toBe('spreadsheet.autoFill.locale')
    expect(validationRuleEditorAtom.debugLabel).toBe('spreadsheet.validation.ruleEditor')
    expect(conditionalFormatEditorAtom.debugLabel).toBe('spreadsheet.conditionalFormat.editor')
    expect(typeof getDisplayCellText).toBe('function')
    expect(typeof isHyperlinkValue).toBe('function')
    expect(printConfigStateAtom.debugLabel).toBe('spreadsheet.print.config')
    expect(findReplaceQueryAtom.debugLabel).toBe('spreadsheet.findReplace.query')
    expect(presenceStateAtom.debugLabel).toBe('spreadsheet.presence.state')
    expect(filterSortStateAtom.debugLabel).toBe('spreadsheet.filterSort.state')
    expect(sheetProtectionAtom.debugLabel).toBe('spreadsheet.protection.state')
  })

  test('does not import UI frameworks, DOM runtime, workers, or wasm glue', () => {
    const forbiddenImport =
      /from ['"](?:solid-js|react|@einfach\/solid|@einfach\/react|.*worker.*|.*wasm.*)['"]/
    const forbiddenRuntime = /\b(?:document\.|window\.|new Worker\(|HTMLElement|HTMLDivElement)\b/
    const offenders = readSourceFiles(SRC_ROOT).flatMap(({ path, text }) => {
      const matches = []

      if (forbiddenImport.test(text)) {
        matches.push(`${path}: forbidden import`)
      }

      if (forbiddenRuntime.test(text)) {
        matches.push(`${path}: forbidden runtime reference`)
      }

      return matches
    })

    expect(offenders).toEqual([])
  })

  test('keeps filter and sort product state read-only at the package boundary', () => {
    const publicStateAtoms = [
      filterSortStateAtom,
      filterDropdownAtom,
      filterSortErrorAtom,
      filterSortSyncTicketAtom,
      filterSortSessionIdAtom,
      filterSortCapabilityAtom,
      filterSortDraftAtom,
      filterSortLifecycleAtom,
    ]
    expect(publicStateAtoms.map((stateAtom) => 'write' in stateAtom)).toEqual(
      FILTER_SORT_PUBLIC_STATE_IS_READ_ONLY,
    )

    const source = readFileSync(join(SRC_ROOT, 'filter-sort/index.ts'), 'utf8')
    const names = [
      'filterSortStateAtom',
      'filterDropdownAtom',
      'filterSortErrorAtom',
      'filterSortSyncTicketAtom',
      'filterSortSessionIdAtom',
      'filterSortCapabilityAtom',
      'filterSortDraftAtom',
      'filterSortLifecycleAtom',
    ]
    for (const name of names) {
      expect(source).toMatch(new RegExp(`export const ${name}: Atom<`))
      expect(source).not.toMatch(new RegExp(`set\\(${name}\\s*[,)]`))
    }
  })

  test('keeps formula-reference product state read-only at the package boundary', () => {
    const publicStateAtoms = [formulaReferenceSessionAtom, formulaReferenceCaretAtom]
    expect(publicStateAtoms.map((stateAtom) => 'write' in stateAtom)).toEqual(
      FORMULA_REFERENCE_PUBLIC_STATE_IS_READ_ONLY,
    )
    expect('write' in setFormulaReferenceCaretAtom).toBe(
      FORMULA_REFERENCE_CARET_COMMAND_IS_WRITABLE,
    )

    const store = createStore()
    expect(store.getter(setFormulaReferenceCaretAtom)).toBeNull()
    const before = publicStateAtoms.map((stateAtom) => store.getter(stateAtom))
    const attemptedValues = [
      {
        anchorCell: { row: 0, col: 0 },
        sheetId: 'sheet-1',
        insertionCaret: 1,
        tokenRange: null,
        dragging: false,
      },
      7,
    ]
    for (const [index, stateAtom] of publicStateAtoms.entries()) {
      expect(() =>
        Reflect.apply(store.setter, store, [stateAtom, attemptedValues[index]]),
      ).toThrow()
    }
    expect(publicStateAtoms.map((stateAtom) => store.getter(stateAtom))).toEqual(before)

    const source = readFileSync(join(SRC_ROOT, 'formula-reference/index.ts'), 'utf8')
    for (const name of ['formulaReferenceSessionAtom', 'formulaReferenceCaretAtom']) {
      expect(source).toMatch(new RegExp(`export const ${name}: Atom<`))
      expect(source).not.toMatch(new RegExp(`set\\(${name}\\s*[,)]`))
    }
  })

  test('keeps the comment editor draft read-only at the package boundary', () => {
    expect('write' in commentEditorDraftAtom).toBe(COMMENT_EDITOR_DRAFT_PUBLIC_STATE_IS_READ_ONLY)
    expect('write' in setCommentDraftAtom).toBe(COMMENT_EDITOR_DRAFT_COMMAND_IS_WRITABLE)

    const store = createStore()
    store.setter(setCommentDraftAtom, 'command-owned')
    const before = store.getter(commentEditorDraftAtom)
    expect(() => Reflect.apply(store.setter, store, [commentEditorDraftAtom, 'forged'])).toThrow()
    expect(store.getter(commentEditorDraftAtom)).toBe(before)

    const source = readFileSync(join(SRC_ROOT, 'comments/index.ts'), 'utf8')
    expect(source).toMatch(/export const commentEditorDraftAtom: Atom<string>/)
    expect(source).not.toMatch(/set\(commentEditorDraftAtom\s*[,)]/)
  })

  test('keeps formula-bar product state read-only at the package boundary', () => {
    expect('write' in formulaBarStateAtom).toBe(FORMULA_BAR_PUBLIC_STATE_IS_READ_ONLY)
    expect(
      [
        formulaBarDraftAtom,
        focusFormulaBarAtom,
        syncFormulaBarAtom,
        setFormulaBarDiagnosticAtom,
        setFormulaBarErrorAtom,
      ].map((commandAtom) => 'write' in commandAtom),
    ).toEqual(FORMULA_BAR_COMMANDS_ARE_WRITABLE)

    const source = readFileSync(join(SRC_ROOT, 'formula-bar/index.ts'), 'utf8')
    expect(source).toMatch(
      /export const formulaBarStateAtom: Atom<FormulaBarState>/,
    )
    expect(source).not.toMatch(/set\(formulaBarStateAtom\s*[,)]/)
  })

  test('keeps viewport hidden product state read-only at the package boundary', () => {
    expect('write' in viewportHiddenAtom).toBe(VIEWPORT_HIDDEN_PUBLIC_STATE_IS_READ_ONLY)

    const store = createStore()
    const before = store.getter(viewportHiddenAtom)
    expect(() =>
      Reflect.apply(store.setter, store, [
        viewportHiddenAtom,
        { rowsBySheet: { 'sheet-1': [1] }, colsBySheet: { 'sheet-1': [2] } },
      ]),
    ).toThrow()
    expect(store.getter(viewportHiddenAtom)).toBe(before)

    const source = readFileSync(join(SRC_ROOT, 'viewport/window.ts'), 'utf8')
    expect(source).toMatch(/export const viewportHiddenAtom: Atom<ViewportHiddenState>/)
    expect(source).not.toMatch(/set\(viewportHiddenAtom\s*[,)]/)
  })

  test('keeps viewport chrome product state read-only at the package boundary', () => {
    const publicStateAtoms = [
      viewportShowGridlinesAtom,
      viewportShowHeadingsAtom,
      viewportShowFormulaBarAtom,
    ]
    const commandAtoms = [toggleGridlinesAtom, toggleHeadingsAtom, toggleFormulaBarAtom]

    expect(publicStateAtoms.map((stateAtom) => 'write' in stateAtom)).toEqual(
      VIEWPORT_CHROME_PUBLIC_STATE_IS_READ_ONLY,
    )
    expect(commandAtoms.map((commandAtom) => 'write' in commandAtom)).toEqual(
      VIEWPORT_CHROME_COMMANDS_ARE_WRITABLE,
    )

    const source = readFileSync(join(SRC_ROOT, 'viewport/chrome.ts'), 'utf8')
    for (const name of [
      'viewportShowGridlinesAtom',
      'viewportShowHeadingsAtom',
      'viewportShowFormulaBarAtom',
    ]) {
      expect(source).toMatch(new RegExp(`export const ${name}: Atom<boolean>`))
      expect(source).not.toMatch(new RegExp(`set\\(${name}\\s*[,)]`))
    }
  })

  test('keeps a generic backend range-lock mutation assignable to the strict command port', async () => {
    const legacySetRangeLock = async (
      request: SetRangeLockRequest,
    ): Promise<BackendMutationResult> => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: 'legacy-revision',
      affectedRange: request.range,
    })
    const backend: Pick<SpreadsheetBackend, 'setRangeLock'> = {
      setRangeLock: legacySetRangeLock,
    }
    const commandPort: SetRangeLockPort = backend.setRangeLock!

    await expect(
      commandPort({
        kind: 'set-range-lock',
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        locked: false,
        requestId: 1,
      }),
    ).resolves.toMatchObject({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 'legacy-revision',
    })
  })
})
