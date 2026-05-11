/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach, jest } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { ContextMenu, type ContextMenuItem } from '../src/ContextMenu'

afterEach(cleanup)

/**
 * Helper — find the portaled menu root anywhere in document.body. ContextMenu
 * uses solid-js/web `Portal`, so the menu lives outside `container`.
 */
function queryMenu(): HTMLElement | null {
  return document.body.querySelector('.context-menu')
}

describe('ContextMenu', () => {
  it('mounts and renders each non-divider item as a menuitem button', () => {
    const items: ContextMenuItem[] = [
      { label: 'Cut', onSelect: () => {} },
      { label: 'Copy', onSelect: () => {} },
      { divider: true },
      { label: 'Paste', onSelect: () => {} },
    ]
    render(() => (
      <ContextMenu items={items} x={10} y={20} onClose={() => {}} />
    ))

    const menu = queryMenu()
    expect(menu).not.toBeNull()
    const buttons = menu!.querySelectorAll('button[role="menuitem"]')
    expect(buttons.length).toBe(3)
    expect(buttons[0].textContent).toBe('Cut')
    expect(buttons[1].textContent).toBe('Copy')
    expect(buttons[2].textContent).toBe('Paste')
    // Divider renders as a real <hr>, not a button.
    expect(menu!.querySelectorAll('hr.context-menu-divider').length).toBe(1)
  })

  it('clicking an item calls its onSelect and then onClose', () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    const items: ContextMenuItem[] = [{ label: 'Do thing', onSelect }]
    render(() => (
      <ContextMenu items={items} x={0} y={0} onClose={onClose} />
    ))

    const button = queryMenu()!.querySelector('button[role="menuitem"]') as HTMLButtonElement
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pressing Escape on document calls onClose', () => {
    const onClose = jest.fn()
    const items: ContextMenuItem[] = [{ label: 'Anything', onSelect: () => {} }]
    render(() => (
      <ContextMenu items={items} x={0} y={0} onClose={onClose} />
    ))

    // Escape is bound at document-level (capture), so dispatch on document.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disabled items do not fire onSelect', () => {
    const onSelect = jest.fn()
    const onClose = jest.fn()
    const items: ContextMenuItem[] = [
      { label: 'Nope', onSelect, disabled: true },
    ]
    render(() => (
      <ContextMenu items={items} x={0} y={0} onClose={onClose} />
    ))

    const button = queryMenu()!.querySelector('button[role="menuitem"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking outside the menu calls onClose', () => {
    const onClose = jest.fn()
    const items: ContextMenuItem[] = [{ label: 'X', onSelect: () => {} }]
    render(() => (
      <ContextMenu items={items} x={0} y={0} onClose={onClose} />
    ))

    // mousedown on document.body (outside the menu) — handler is capture-phase.
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('positions the menu at the provided x/y', () => {
    render(() => (
      <ContextMenu
        items={[{ label: 'A', onSelect: () => {} }]}
        x={42}
        y={84}
        onClose={() => {}}
      />
    ))
    const menu = queryMenu() as HTMLElement
    expect(menu.style.left).toBe('42px')
    expect(menu.style.top).toBe('84px')
  })
})
