/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  CellRange,
  ListNamedRangesRequest,
  NamedRange,
  NamedRangeBackendCapabilities,
  NamedRangeControllerPort,
  NamedRangeMutationOutcome,
  NamedRangeMutationResult,
  SetNamedRangeRequest,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  addSelectionRegionAtom,
  classifyNameBoxInput,
  nameBoxDisplayAtom,
  nameBoxErrorAtom,
  nameBoxFocusedAtom,
  nameBoxInputAtom,
  nameBoxModeAtom,
  nameBoxSessionIdAtom,
  nameRegistryCacheAtom,
  namedRangeCapabilitiesAtom,
  namedRangeMutationStateAtom,
  namedRangeRegistryStateAtom,
  primarySelectionRegionAtom,
  selectCellAtom,
  selectionRangeAtom,
  selectionSnapshotAtom,
  setSelectionAtom,
  setViewportMetricsAtom,
  setWorkspaceActiveSheetAtom,
  viewportMetricsAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetNameBox } from '../src-vnext/name-box'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { setLocale } from '../src/i18n'

afterEach(() => {
  cleanup()
  setLocale('zh')
})

const NAMED_RANGE_CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'static-session',
  scopes: Object.freeze(['workbook', 'sheet'] as const),
  bindings: Object.freeze({ range: true, constant: true, lambda: false }),
  delete: true,
  rangeSemantics: 'stored-definition',
  listAuthority: 'static-session-registry',
  definitionReadback: 'full',
  namesWitness: true,
  mutationAck: 'session-registry-accepted',
  durability: 'session-local',
})

type NamedRangeBackend = SpreadsheetBackend & NamedRangeControllerPort

function noopBackend(overrides: Partial<NamedRangeBackend> = {}): NamedRangeBackend {
  return {
    readVisibleProjection: async (request) => ({
      kind: 'visible-window',
      sheetId: request.sheetId,
      requestId: request.requestId,
      window: request.window,
      cells: [],
    }),
    readRangeProjection: async (request) => ({
      kind: 'range',
      sheetId: request.sheetId,
      requestId: request.requestId,
      range: request.range,
      cells: [],
    }),
    setCellInput: async (request) => ({ sheetId: request.sheetId }),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function strictNamedRangeBackend(
  options: {
    names?: readonly NamedRange[]
    capabilityResult?: Promise<NamedRangeBackendCapabilities>
    outcome?: NamedRangeMutationOutcome
  } = {},
) {
  let names = [...(options.names ?? [])]
  let revision = 0
  const readNamedRangeCapabilities = jest.fn(async () => {
    return options.capabilityResult ?? NAMED_RANGE_CAPABILITIES
  })
  const listNamedRanges = jest.fn(async (request: ListNamedRangesRequest) => ({
    requestId: request.requestId,
    revision: ++revision,
    names: names.slice(),
    authority: 'static-session-registry' as const,
    definitionReadback: 'full' as const,
  }))
  const setNamedRange = jest.fn(
    async (request: SetNamedRangeRequest): Promise<NamedRangeMutationResult> => {
      const outcome = options.outcome ?? 'w0-acknowledged'
      if (outcome === 'w0-acknowledged') {
        names = [
          ...names.filter(
            (entry) =>
              !(
                entry.name.toLowerCase() === request.name.toLowerCase() &&
                JSON.stringify(entry.scope) === JSON.stringify(request.scope)
              ),
          ),
          { name: request.name, scope: request.scope, refersTo: request.refersTo },
        ]
      }
      return {
        requestId: request.requestId,
        revision: ++revision,
        outcome,
      }
    },
  )
  return {
    backend: noopBackend({
      listNamedRanges,
      setNamedRange,
    }),
    namedRangeCapabilityPort: { readNamedRangeCapabilities },
    readNamedRangeCapabilities,
    listNamedRanges,
    setNamedRange,
  }
}

function pressKey(input: HTMLInputElement, key: string, code = key) {
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function setUpStore() {
  const store = createStore()
  store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
  return store
}

function setScrollableViewport(store: ReturnType<typeof createStore>) {
  store.setter(setViewportMetricsAtom, {
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 120,
    viewportWidth: 240,
    rowHeight: 24,
    colWidth: 80,
    rowCount: 200,
    colCount: 40,
    overscanRows: 0,
    overscanCols: 0,
  })
}

async function waitForNamedRangeBootstrap(store: ReturnType<typeof createStore>) {
  await waitFor(() => {
    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
  })
}

describe('classifyNameBoxInput (pure parser)', () => {
  const context = {
    sheetId: 'sheet-1',
    selectionRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } as CellRange,
  }

  it('parses A1 cell references', () => {
    const target = classifyNameBoxInput('B10', [], context)
    expect(target.kind).toBe('cell')
    if (target.kind === 'cell') {
      expect(target.coord).toEqual({ row: 9, col: 1 })
      expect(target.sheetId).toBe('sheet-1')
    }
  })

  it('parses A1 ranges', () => {
    const target = classifyNameBoxInput('B2:D5', [], context)
    expect(target.kind).toBe('range')
    if (target.kind === 'range') {
      expect(target.range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    }
  })

  it('resolves a registered named range', () => {
    const registry: NamedRange[] = [
      {
        name: 'MyRange',
        scope: 'workbook',
        refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:D4' },
      },
    ]
    const target = classifyNameBoxInput('MyRange', registry, context)
    expect(target.kind).toBe('named-range')
    if (target.kind === 'named-range') {
      expect(target.name).toBe('MyRange')
      expect(target.range).toEqual({ rowStart: 2, rowEnd: 3, colStart: 2, colEnd: 3 })
    }
  })

  it('proposes define-name for a valid new identifier', () => {
    const target = classifyNameBoxInput('NewName', [], context)
    expect(target.kind).toBe('define-name')
    if (target.kind === 'define-name') {
      expect(target.name).toBe('NewName')
      expect(target.range).toEqual(context.selectionRange)
    }
  })

  it('flags unrecognized input as invalid', () => {
    expect(classifyNameBoxInput('!!not a name', [], context).kind).toBe('invalid')
  })
})

describe('SpreadsheetNameBox display', () => {
  it('shows the A1 address for a single-cell selection', async () => {
    const store = setUpStore()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect((getByTestId('name-box-input') as HTMLInputElement).value).toBe('A1')
    })
    expect(store.getter(nameBoxDisplayAtom)).toBe('A1')
  })

  it('shows the matching defined name when selection equals it', async () => {
    const store = setUpStore()
    const named: NamedRange = {
      name: 'MyRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'B2:C3' },
    }
    store.setter(nameRegistryCacheAtom, [named])
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 2, col: 2 },
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect((getByTestId('name-box-input') as HTMLInputElement).value).toBe('MyRange')
    })
  })

  it('shows only the primary range address when multiple regions exist', async () => {
    const store = setUpStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 5, col: 5 },
        focus: { row: 6, col: 6 },
      },
      makePrimary: true,
    })

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect((getByTestId('name-box-input') as HTMLInputElement).value).toBe('F6:G7')
    })
    expect(store.getter(primarySelectionRegionAtom).kind).toBe('range')
  })
})

describe('SpreadsheetNameBox thin core binding', () => {
  it('navigates to cells, ranges, and registered names without mutation transport', async () => {
    const store = setUpStore()
    const named: NamedRange = {
      name: 'TaxRate',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'D4:E5' },
    }
    const harness = strictNamedRangeBackend({ names: [named] })
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <div class="demo-page">
          <div class="spreadsheet-grid" data-testid="grid" tabIndex={0} />
          <SpreadsheetNameBox />
        </div>
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'B10' } })
    pressKey(input, 'Enter')
    await waitFor(() => {
      expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
        sheetId: 'sheet-1',
        row: 9,
        col: 1,
      })
    })
    expect(document.activeElement).toBe(getByTestId('grid'))

    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'B2:D5' } })
    pressKey(input, 'Enter')
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 1,
      rowEnd: 4,
      colStart: 1,
      colEnd: 3,
    })

    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'TaxRate' } })
    pressKey(input, 'Enter')
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 3,
      rowEnd: 4,
      colStart: 3,
      colEnd: 4,
    })
    expect(harness.setNamedRange).not.toHaveBeenCalled()
  })

  it('switches the active sheet before scrolling to a cross-sheet named range', async () => {
    const store = setUpStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setScrollableViewport(store)
    const named: NamedRange = {
      name: 'RemoteRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'Z100:AA101' },
    }
    const harness = strictNamedRangeBackend({ names: [named] })
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const events: string[] = []
    const unsubscribeWorkspace = store.sub(workspaceSessionAtom, () => {
      events.push(`workspace:${store.getter(workspaceSessionAtom).activeSheetId}`)
    })
    const unsubscribeViewport = store.sub(viewportMetricsAtom, () => {
      events.push('viewport')
    })
    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'RemoteRange' } })
    pressKey(input, 'Enter')
    unsubscribeWorkspace()
    unsubscribeViewport()

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionSnapshotAtom).selection.sheetId).toBe('sheet-2')
    expect(store.getter(viewportMetricsAtom).scrollTop).toBeGreaterThan(0)
    expect(store.getter(viewportMetricsAtom).scrollLeft).toBeGreaterThan(0)
    const workspaceEventIndex = events.indexOf('workspace:sheet-2')
    expect(workspaceEventIndex).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('viewport')).toBeGreaterThan(workspaceEventIndex)
  })

  it('scrolls to a same-sheet named range without rewriting workspace state', async () => {
    const store = setUpStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setScrollableViewport(store)
    const named: NamedRange = {
      name: 'LocalRange',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'Z100:AA101' },
    }
    const harness = strictNamedRangeBackend({ names: [named] })
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)
    const workspaceBeforeCommit = store.getter(workspaceSessionAtom)

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'LocalRange' } })
    pressKey(input, 'Enter')

    expect(store.getter(workspaceSessionAtom)).toBe(workspaceBeforeCommit)
    expect(store.getter(selectionSnapshotAtom).selection.sheetId).toBe('sheet-1')
    expect(store.getter(viewportMetricsAtom).scrollTop).toBeGreaterThan(0)
    expect(store.getter(viewportMetricsAtom).scrollLeft).toBeGreaterThan(0)
  })

  it('defines once through the shared core lane when Enter is followed by blur', async () => {
    const store = setUpStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 2 },
      focus: { row: 4, col: 4 },
    })
    const harness = strictNamedRangeBackend()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'BrandNew' } })
    pressKey(input, 'Enter')
    fireEvent.blur(input)

    await waitFor(() => {
      expect(harness.setNamedRange).toHaveBeenCalledTimes(1)
      expect(store.getter(namedRangeMutationStateAtom).status).toBe('acknowledged')
      expect(harness.listNamedRanges).toHaveBeenCalledTimes(2)
    })
    const request = harness.setNamedRange.mock.calls[0][0]
    expect(request).toMatchObject({
      kind: 'set-named-range',
      name: 'BrandNew',
      scope: 'workbook',
      refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'C3:E5' },
    })
    expect(Number.isSafeInteger(request.requestId)).toBe(true)
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 4,
      colStart: 2,
      colEnd: 4,
    })
  })

  it('does not enter transport before named-range capability readiness', async () => {
    const store = setUpStore()
    const capability = deferred<NamedRangeBackendCapabilities>()
    const harness = strictNamedRangeBackend({ capabilityResult: capability.promise })
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => expect(harness.readNamedRangeCapabilities).toHaveBeenCalledTimes(1))

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'TooEarly' } })
    pressKey(input, 'Enter')
    fireEvent.blur(input)

    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('loading')
    expect(store.getter(namedRangeMutationStateAtom).status).toBe('blocked')
    expect(harness.setNamedRange).not.toHaveBeenCalled()
    expect(harness.listNamedRanges).not.toHaveBeenCalled()

    capability.resolve(NAMED_RANGE_CAPABILITIES)
    await waitForNamedRangeBootstrap(store)
    expect(harness.listNamedRanges).toHaveBeenCalledTimes(1)
    expect(harness.setNamedRange).not.toHaveBeenCalled()
  })

  it('rejects input and commit events from an older DOM edit session', async () => {
    const store = setUpStore()
    const harness = strictNamedRangeBackend()
    const { getAllByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox data-testid="first-name-box" />
        <SpreadsheetNameBox data-testid="second-name-box" />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const [first, second] = getAllByTestId('name-box-input') as HTMLInputElement[]
    fireEvent.focus(first)
    const firstSession = store.getter(nameBoxSessionIdAtom)
    fireEvent.input(first, { target: { value: 'FirstDraft' } })
    expect(store.getter(nameBoxInputAtom)).toBe('FirstDraft')

    fireEvent.focus(second)
    expect(store.getter(nameBoxSessionIdAtom)).toBe(firstSession + 1)
    expect(store.getter(nameBoxInputAtom)).toBe('A1')

    fireEvent.input(first, { target: { value: 'StaleName' } })
    pressKey(first, 'Enter')
    expect(store.getter(nameBoxInputAtom)).toBe('A1')
    expect(store.getter(nameBoxSessionIdAtom)).toBe(firstSession + 1)
    expect(store.getter(nameBoxFocusedAtom)).toBe(true)
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })
    expect(harness.setNamedRange).not.toHaveBeenCalled()
  })

  it('cleans up only the DOM edit session still witnessed by core', async () => {
    const store = setUpStore()
    const harness = strictNamedRangeBackend()
    const first = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    fireEvent.focus(first.getByTestId('name-box-input'))
    expect(store.getter(nameBoxFocusedAtom)).toBe(true)
    const sessionId = store.getter(nameBoxSessionIdAtom)
    first.unmount()

    expect(store.getter(nameBoxSessionIdAtom)).toBe(sessionId)
    expect(store.getter(nameBoxFocusedAtom)).toBe(false)
    expect(store.getter(nameBoxModeAtom)).toBe('idle')
  })

  it('reverts on Escape and handles unchanged, empty, and changed blur in core', async () => {
    const store = setUpStore()
    const harness = strictNamedRangeBackend()
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'Z99' } })
    pressKey(input, 'Escape')
    expect(store.getter(nameBoxInputAtom)).toBe('A1')
    expect(store.getter(nameBoxFocusedAtom)).toBe(false)
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })

    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(store.getter(nameBoxModeAtom)).toBe('idle')
    expect(store.getter(nameBoxInputAtom)).toBe('A1')

    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(store.getter(nameBoxInputAtom)).toBe('A1')

    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'C4' } })
    fireEvent.blur(input)
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 3,
      col: 2,
    })
    expect(harness.setNamedRange).not.toHaveBeenCalled()
  })

  it('lets the core settle a confirmed-not-applied definition result', async () => {
    const store = setUpStore()
    const harness = strictNamedRangeBackend({ outcome: 'confirmed-not-applied' })
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={harness.backend}
        namedRangeCapabilityPort={harness.namedRangeCapabilityPort}
        store={store}
      >
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))
    await waitForNamedRangeBootstrap(store)

    const input = getByTestId('name-box-input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: 'NotApplied' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(harness.setNamedRange).toHaveBeenCalledTimes(1)
      expect(store.getter(namedRangeMutationStateAtom).status).toBe('confirmed-not-applied')
    })
    expect(harness.listNamedRanges).toHaveBeenCalledTimes(1)
    expect(store.getter(nameBoxErrorAtom)).toBe(false)
  })

  it('reports invalid input without switching sheets or scrolling', async () => {
    setLocale('en')
    const store = setUpStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    setScrollableViewport(store)
    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={noopBackend()} store={store}>
        <SpreadsheetNameBox />
      </SpreadsheetUiProvider>
    ))

    const input = getByTestId('name-box-input') as HTMLInputElement
    const workspaceBeforeCommit = store.getter(workspaceSessionAtom)
    const viewportBeforeCommit = store.getter(viewportMetricsAtom)
    expect(input.getAttribute('aria-label')).toBe('Name box')
    fireEvent.focus(input)
    fireEvent.input(input, { target: { value: '!!nope' } })
    pressKey(input, 'Enter')

    await waitFor(() => expect(store.getter(nameBoxErrorAtom)).toBe(true))
    const errorMessage = getByTestId('name-box-error')
    expect(errorMessage.classList.contains('spreadsheet-name-box-error-message')).toBe(true)
    expect(errorMessage.getAttribute('role')).toBe('alert')
    expect(errorMessage.textContent).toBe('Enter a valid cell, range, or defined name.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(errorMessage.id)
    expect(store.getter(nameBoxInputAtom)).toBe('A1')
    expect(store.getter(workspaceSessionAtom)).toBe(workspaceBeforeCommit)
    expect(store.getter(viewportMetricsAtom)).toBe(viewportBeforeCommit)
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })

    setLocale('zh')
    await waitFor(() => {
      expect(input.getAttribute('aria-label')).toBe('名称框')
      expect(errorMessage.textContent).toBe('请输入有效的单元格、区域或已定义名称。')
    })
  })
})
