
import { createSignal, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { DemoBlank } from './demos/DemoBlank'
import { DemoFormulas } from './demos/DemoFormulas'
import { DemoBudget } from './demos/DemoBudget'
import { DemoGrades } from './demos/DemoGrades'
import { DemoSales } from './demos/DemoSales'
import './styles.css'

interface DemoTab {
  id: string
  label: string
  component: Component
}

const demos: DemoTab[] = [
  { id: 'blank',    label: 'Blank',          component: DemoBlank },
  { id: 'formulas', label: 'Formulas',       component: DemoFormulas },
  { id: 'budget',   label: 'Budget',         component: DemoBudget },
  { id: 'grades',   label: 'Grade Calc',     component: DemoGrades },
  { id: 'sales',    label: 'Sales Dashboard', component: DemoSales },
]

export function App() {
  const [activeTab, setActiveTab] = createSignal('formulas')

  const activeDemo = () => demos.find((d) => d.id === activeTab())

  return (
    <div class="app">
      <header class="app-header">
        <h1 class="app-title">Einfach Excel</h1>
        <span class="app-subtitle">Rust + WASM + SolidJS</span>
      </header>

      <nav class="tab-bar">
        <For each={demos}>
          {(demo) => (
            <button
              class={`tab-btn ${activeTab() === demo.id ? 'tab-active' : ''}`}
              onClick={() => setActiveTab(demo.id)}
            >
              {demo.label}
            </button>
          )}
        </For>
      </nav>

      <main class="app-main">
        <Show when={activeDemo()} keyed>
          {(demo) => {
            const Comp = demo.component
            return <Comp />
          }}
        </Show>
      </main>
    </div>
  )
}
