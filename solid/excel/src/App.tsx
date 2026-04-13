/** @jsxImportSource solid-js */
import { createSignal, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { DemoBlank } from './demos/DemoBlank'
import { DemoFormulas } from './demos/DemoFormulas'
import { DemoBudget } from './demos/DemoBudget'
import { DemoGrades } from './demos/DemoGrades'
import { DemoSales } from './demos/DemoSales'

interface DemoTab {
  id: string
  label: string
  description: string
  component: Component
}

const demos: DemoTab[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Start with an empty grid for free-form experiments.',
    component: DemoBlank,
  },
  {
    id: 'formulas',
    label: 'Formulas',
    description: 'Arithmetic, functions, chains, and error handling in one sheet.',
    component: DemoFormulas,
  },
  {
    id: 'budget',
    label: 'Budget',
    description: 'Monthly planning with totals, diffs, and summary stats.',
    component: DemoBudget,
  },
  {
    id: 'grades',
    label: 'Grade Calc',
    description: 'Student score calculations with row and class aggregates.',
    component: DemoGrades,
  },
  {
    id: 'sales',
    label: 'Sales Dashboard',
    description: 'Quarter totals, KPI highlights, and growth calculations.',
    component: DemoSales,
  },
]

export function App() {
  const [activeTab, setActiveTab] = createSignal('formulas')
  const [sidebarOpen, setSidebarOpen] = createSignal(false)

  const activeDemo = () => demos.find((d) => d.id === activeTab())
  const activeDemoMeta = () => activeDemo() ?? demos[0]

  function selectDemo(id: string) {
    setActiveTab(id)
    setSidebarOpen(false)
  }

  function renderNavItems() {
    return (
      <For each={demos}>
        {(demo) => (
          <button
            aria-label={demo.label}
            class={`nav-item ${activeTab() === demo.id ? 'nav-item-active' : ''}`}
            onClick={() => selectDemo(demo.id)}
            type="button"
          >
            <span class="nav-item-label">{demo.label}</span>
            <span class="nav-item-desc">{demo.description}</span>
          </button>
        )}
      </For>
    )
  }

  function renderNav(title: string, extraClass = '') {
    return (
      <aside class={`sidebar ${extraClass}`.trim()}>
        <div class="sidebar-header">
          <p class="sidebar-eyebrow">Demo Library</p>
          <h2 class="sidebar-title">{title}</h2>
          <p class="sidebar-copy">
            Pick a spreadsheet scenario on the left and explore it on the right.
          </p>
        </div>
        <nav aria-label="Demo navigation" class="demo-nav">
          {renderNavItems()}
        </nav>
      </aside>
    )
  }

  return (
    <div class="app-shell">
      <header class="app-header">
        <div class="app-brand">
          <p class="app-kicker">Rust + WASM + SolidJS</p>
          <div>
            <h1 class="app-title">Einfach Excel</h1>
            <p class="app-subtitle">
              Explore spreadsheet demos in a workspace-style shell.
            </p>
          </div>
        </div>
        <button
          aria-controls="demo-drawer"
          aria-expanded={sidebarOpen()}
          class="menu-toggle"
          onClick={() => setSidebarOpen((open) => !open)}
          type="button"
        >
          Demos
        </button>
      </header>

      <div class="app-body">
        {renderNav('Browse demos', 'sidebar-desktop')}

        <main class="app-main">
          <section class="content-header">
            <div>
              <p class="content-eyebrow">Active Demo</p>
              <h2 class="content-title">{activeDemoMeta().label}</h2>
            </div>
            <p class="content-copy">{activeDemoMeta().description}</p>
          </section>

          <Show when={activeDemo()} keyed>
            {(demo) => {
              const Comp = demo.component
              return <Comp />
            }}
          </Show>
        </main>
      </div>

      <Show when={sidebarOpen()}>
        <>
          <button
            aria-label="Close demo navigation overlay"
            class="drawer-backdrop"
            onClick={() => setSidebarOpen(false)}
            type="button"
          />
          <div class="drawer-shell">
            {(() => {
              const drawer = renderNav('Choose a demo', 'sidebar-drawer')
              return (
                <div id="demo-drawer">
                  {drawer}
                </div>
              )
            })()}
          </div>
        </>
      </Show>
    </div>
  )
}
