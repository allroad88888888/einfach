import { Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  DEFAULT_PRINT_CONFIG,
  printConfigStateAtom,
  printPreviewOpenAtom,
  togglePageSetupDialogAtom,
  togglePrintPreviewAtom,
  workspaceSessionAtom,
  type PrintConfig,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetPrintPreviewOverlayProps {
  class?: string
  'data-testid'?: string
}

function scaleText(config: PrintConfig): string {
  const scale = config.scale
  if (scale.kind === 'percent') return `${scale.percent}%`
  const parts: string[] = []
  if (scale.pagesWide != null) parts.push(`${scale.pagesWide}W`)
  if (scale.pagesTall != null) parts.push(`${scale.pagesTall}T`)
  return parts.length > 0 ? `fit ${parts.join(' x ')}` : 'fit'
}

export function SpreadsheetPrintPreviewOverlay(props: SpreadsheetPrintPreviewOverlayProps) {
  const store = useSpreadsheetUiStore()
  const previewOpen = useAtomValue(printPreviewOpenAtom)
  const printConfigState = useAtomValue(printConfigStateAtom)
  const workspaceSession = useAtomValue(workspaceSessionAtom)

  const activeSheetId = () => workspaceSession().activeSheetId ?? ''

  const config = (): PrintConfig =>
    (activeSheetId() ? printConfigState()[activeSheetId()] : undefined) ?? DEFAULT_PRINT_CONFIG

  function closePreview() {
    store.setter(togglePrintPreviewAtom)
  }

  function openPageSetup() {
    store.setter(togglePageSetupDialogAtom)
  }

  return (
    <Show when={previewOpen()}>
      <div
        class={`print-preview-overlay spreadsheet-print-preview ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'print-preview-overlay'}
        data-sheet-id={activeSheetId()}
      >
        <div
          class="print-preview-orientation"
          data-testid="print-orientation-text"
        >
          {config().orientation}
        </div>
        <div
          class="print-preview-scale"
          data-testid="print-scale-text"
        >
          {scaleText(config())}
        </div>
        <div
          class="print-preview-page-breaks"
          data-testid="print-page-breaks-count"
        >
          {config().manualPageBreaks.length}
        </div>
        <Show when={config().header}>
          <div class="print-preview-header">
            <span class="print-header-left">{config().header?.left ?? ''}</span>
            <span class="print-header-center">{config().header?.center ?? ''}</span>
            <span class="print-header-right">{config().header?.right ?? ''}</span>
          </div>
        </Show>
        <Show when={config().footer}>
          <div class="print-preview-footer">
            <span class="print-footer-left">{config().footer?.left ?? ''}</span>
            <span class="print-footer-center">{config().footer?.center ?? ''}</span>
            <span class="print-footer-right">{config().footer?.right ?? ''}</span>
          </div>
        </Show>
        <button
          type="button"
          class="print-btn"
          data-testid="print-close-button"
          onClick={() => closePreview()}
        >
          Close preview
        </button>
        <button
          type="button"
          class="print-btn"
          data-testid="print-page-setup-button"
          onClick={() => openPageSetup()}
        >
          Page setup
        </button>
      </div>
    </Show>
  )
}
