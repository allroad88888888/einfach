import { useAtomValue } from '@einfach/solid'
import {
  dispatchToolbarFormatCommandAtom,
  toolbarCommandAvailabilityAtom,
  type ToolbarFormatCommandInput,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetUiStore } from '../provider'
import type { SpreadsheetToolbarProps, SpreadsheetToolbarCommand } from './types'

const toolbarCommands: SpreadsheetToolbarCommand[] = [
  {
    command: 'bold',
    label: 'B',
    title: 'Bold',
    testId: 'toolbar-btn-bold',
    isEnabled: (availability) => availability.bold,
  },
  {
    command: 'italic',
    label: 'I',
    title: 'Italic',
    testId: 'toolbar-btn-italic',
    isEnabled: (availability) => availability.italic,
  },
  {
    command: 'fill-color',
    label: 'Fill',
    title: 'Fill color',
    testId: 'toolbar-btn-fill-color',
    value: '#ffd966',
    isEnabled: (availability) => availability.fillColor,
  },
  {
    command: 'text-color',
    label: 'Text',
    title: 'Text color',
    testId: 'toolbar-btn-text-color',
    value: '#000000',
    isEnabled: (availability) => availability.textColor,
  },
  {
    command: 'number-format',
    label: 'Num',
    title: 'Number format',
    testId: 'toolbar-btn-number-format',
    value: 'General',
    isEnabled: (availability) => availability.numberFormat,
  },
]

export function SpreadsheetToolbar(props: SpreadsheetToolbarProps) {
  const store = useSpreadsheetUiStore()
  const availability = useAtomValue(toolbarCommandAvailabilityAtom)

  function dispatchCommand(input: ToolbarFormatCommandInput) {
    store.setter(dispatchToolbarFormatCommandAtom, input)
  }

  return (
    <div
      class={`format-toolbar spreadsheet-toolbar ${props.class ?? ''}`.trim()}
      role="toolbar"
      data-testid={props['data-testid'] ?? 'spreadsheet-toolbar'}
    >
      {toolbarCommands.map((command) => {
        const enabled = command.isEnabled(availability())
        const commandValue = { command: command.command, value: command.value }

        return (
          <button
            type="button"
            class="fmt-btn spreadsheet-toolbar-button"
            data-testid={command.testId}
            title={command.title}
            aria-label={command.title}
            disabled={!enabled}
            onClick={() => {
              dispatchCommand(commandValue)
            }}
          >
            {command.label}
          </button>
        )
      })}
    </div>
  )
}
