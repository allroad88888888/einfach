
import { createSignal, For, Show } from 'solid-js'
import type { Component } from 'solid-js'
import { DemoBlank } from './demos/DemoBlank'
import { DemoFormulas } from './demos/DemoFormulas'
import { DemoBudget } from './demos/DemoBudget'
import { DemoGrades } from './demos/DemoGrades'
import { DemoSales } from './demos/DemoSales'
import { MultiSheet } from './demos/MultiSheet'
import { DemoCrossSheetChain } from './demos/DemoCrossSheetChain'
import { DemoLarge } from './demos/DemoLarge'
import { DemoWorker } from './demos/DemoWorker'
import './styles.css'

interface DemoTab {
  id: string
  label: string
  component: Component
}

/** Tab bar grouping: keeps the 9 demos visually clustered by intent so
 *  visitors can find e.g. the worker / virtualized perf demos without
 *  scanning the whole row. Order inside a group is fixed; groups render
 *  separated by a thin `<span class="nav-group-sep">` divider. */
interface DemoGroup {
  id: string
  demos: DemoTab[]
}

const demoGroups: DemoGroup[] = [
  {
    id: 'basics',
    demos: [
      { id: 'blank',    label: 'Blank',           component: DemoBlank },
      { id: 'formulas', label: 'Formulas',        component: DemoFormulas },
    ],
  },
  {
    id: 'apps',
    demos: [
      { id: 'budget',   label: 'Budget',          component: DemoBudget },
      { id: 'grades',   label: 'Grade Calc',      component: DemoGrades },
      { id: 'sales',    label: 'Sales Dashboard', component: DemoSales },
    ],
  },
  {
    id: 'workbook',
    demos: [
      { id: 'multi',    label: 'Multi-Sheet',     component: MultiSheet },
      { id: 'cross',    label: '3-Sheet Chain',   component: DemoCrossSheetChain },
    ],
  },
  {
    id: 'perf',
    demos: [
      { id: 'large',    label: 'Large Grid',      component: DemoLarge },
      { id: 'worker',   label: 'Worker',          component: DemoWorker },
    ],
  },
]

const allDemos: DemoTab[] = demoGroups.flatMap((g) => g.demos)

export function App() {
  const [activeTab, setActiveTab] = createSignal('blank')

  const activeDemo = () => allDemos.find((d) => d.id === activeTab())

  return (
    <div class="app">
      <header class="app-header">
        <h1 class="app-title">Einfach Excel</h1>
        <span class="app-subtitle">Rust + WASM + SolidJS</span>
      </header>

      <nav class="tab-bar">
        <For each={demoGroups}>
          {(group, gIdx) => (
            <>
              <Show when={gIdx() > 0}>
                <span class="nav-group-sep" aria-hidden="true" />
              </Show>
              <For each={group.demos}>
                {(demo) => (
                  <button
                    class={`tab-btn ${activeTab() === demo.id ? 'tab-active' : ''}`}
                    onClick={() => setActiveTab(demo.id)}
                  >
                    {demo.label}
                  </button>
                )}
              </For>
            </>
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
