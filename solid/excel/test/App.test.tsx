/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { App } from '../src/App'

afterEach(cleanup)

describe('App demos', () => {
  it('renders the formulas demo by default', () => {
    render(() => <App />)

    expect(screen.getByRole('heading', { name: 'Formula Showcase' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Formulas' })).toBeInTheDocument()
    expect(screen.getAllByText('#DIV/0!').length).toBeGreaterThan(0)
    expect(screen.getByText('410')).toBeInTheDocument()
  })

  it('switches to the blank demo', () => {
    render(() => <App />)

    fireEvent.click(screen.getByRole('button', { name: 'Blank' }))

    expect(screen.getByRole('heading', { name: 'Blank Spreadsheet' })).toBeInTheDocument()
    expect(screen.getByText(/Double-click any cell to edit/)).toBeInTheDocument()
  })

  it('switches to the budget demo and shows computed totals', () => {
    render(() => <App />)

    fireEvent.click(screen.getByRole('button', { name: 'Budget' }))

    expect(screen.getByRole('heading', { name: 'Monthly Budget' })).toBeInTheDocument()
    expect(screen.getByText('10000')).toBeInTheDocument()
    expect(screen.getByText('3500')).toBeInTheDocument()
  })

  it('switches to the grade calculator demo', () => {
    render(() => <App />)

    fireEvent.click(screen.getByRole('button', { name: 'Grade Calc' }))

    expect(screen.getByRole('heading', { name: 'Grade Calculator' })).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('--- Summary ---')).toBeInTheDocument()
  })

  it('switches to the sales dashboard demo and shows KPI values', () => {
    render(() => <App />)

    fireEvent.click(screen.getByRole('button', { name: 'Sales Dashboard' }))

    expect(screen.getAllByRole('heading', { name: 'Sales Dashboard' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('93200').length).toBeGreaterThan(0)
    expect(screen.getAllByText('45000').length).toBeGreaterThan(0)
  })

  it('opens the demo drawer from the menu button and closes it on overlay click', () => {
    render(() => <App />)

    expect(screen.queryByLabelText('Close demo navigation overlay')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Demos' }))

    expect(screen.getByLabelText('Close demo navigation overlay')).toBeInTheDocument()
    expect(screen.getByText('Choose a demo')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Close demo navigation overlay'))

    expect(screen.queryByLabelText('Close demo navigation overlay')).not.toBeInTheDocument()
  })

  it('closes the drawer after selecting a demo from the menu flow', () => {
    render(() => <App />)

    fireEvent.click(screen.getByRole('button', { name: 'Demos' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Budget' })[1])

    expect(screen.getByRole('heading', { name: 'Monthly Budget' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Close demo navigation overlay')).not.toBeInTheDocument()
  })
})
