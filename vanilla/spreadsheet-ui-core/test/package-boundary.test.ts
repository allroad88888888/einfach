import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from '@jest/globals'
import {
  clipboardStateAtom,
  diagnosticsAtom,
  editingSessionAtom,
  formulaBarStateAtom,
  historyStackAtom,
  keyboardModeAtom,
  menuStateAtom,
  pointerSessionAtom,
  primarySelectionRegionAtom,
  selectionAtom,
  selectionRegionsAtom,
  toolbarUiStateAtom,
  viewportMetricsAtom,
  workspaceSessionAtom,
} from '../src'

const SRC_ROOT = join(process.cwd(), 'vanilla/spreadsheet-ui-core/src')

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
    expect(pointerSessionAtom.debugLabel).toBe('spreadsheet.pointer.session')
    expect(menuStateAtom.debugLabel).toBe('spreadsheet.menu.state')
    expect(toolbarUiStateAtom.debugLabel).toBe('spreadsheet.toolbar.ui')
    expect(diagnosticsAtom.debugLabel).toBe('spreadsheet.diagnostics.state')
    expect(viewportMetricsAtom.debugLabel).toBe('spreadsheet.viewport.metrics')
    expect(workspaceSessionAtom.debugLabel).toBe('spreadsheet.workspace.session')
    expect(historyStackAtom.debugLabel).toBe('spreadsheet.history.stack')
    expect(selectionRegionsAtom.debugLabel).toBe('spreadsheet.selection.regions')
    expect(primarySelectionRegionAtom.debugLabel).toBe('spreadsheet.selection.primaryRegion')
  })

  test('does not import UI frameworks, DOM runtime, workers, or wasm glue', () => {
    const forbiddenImport = /from ['"](?:solid-js|react|@einfach\/solid|@einfach\/react|.*worker.*|.*wasm.*)['"]/
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
})
