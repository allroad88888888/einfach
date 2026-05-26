
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
import { DemoMillion } from './demos/DemoMillion'
import { VNextSmokeDemo, VNextWorkerDemo, VNextWorkerTsDemo, VNextWave5Demo } from '../src-vnext'
import { LocaleSwitcher } from './LocaleSwitcher'
import { useT } from './i18n'
import './styles.css'

interface DemoTab {
  id: string
  /** i18n key into the active catalog; resolves via `useT()`. */
  labelKey: string
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
      { id: 'blank',    labelKey: 'nav.blank',    component: DemoBlank },
      { id: 'formulas', labelKey: 'nav.formulas', component: DemoFormulas },
    ],
  },
  {
    id: 'apps',
    demos: [
      { id: 'budget',   labelKey: 'nav.budget',   component: DemoBudget },
      { id: 'grades',   labelKey: 'nav.grades',   component: DemoGrades },
      { id: 'sales',    labelKey: 'nav.sales',    component: DemoSales },
    ],
  },
  {
    id: 'workbook',
    demos: [
      { id: 'multi',    labelKey: 'nav.multi',    component: MultiSheet },
      { id: 'cross',    labelKey: 'nav.cross',    component: DemoCrossSheetChain },
    ],
  },
  {
    id: 'perf',
    demos: [
      { id: 'large',    labelKey: 'nav.large',    component: DemoLarge },
      { id: 'worker',   labelKey: 'nav.worker',   component: DemoWorker },
      { id: 'million',  labelKey: 'nav.million',  component: DemoMillion },
    ],
  },
  {
    id: 'vnext',
    demos: [
      { id: 'vnext', labelKey: 'nav.vnext', component: VNextSmokeDemo },
      { id: 'vnext-worker', labelKey: 'nav.vnextWorker', component: VNextWorkerDemo },
      { id: 'vnext-worker-ts', labelKey: 'nav.vnextWorkerTs', component: VNextWorkerTsDemo },
      { id: 'vnext-wave5', labelKey: 'nav.vnextWave5', component: VNextWave5Demo },
    ],
  },
]

const allDemos: DemoTab[] = demoGroups.flatMap((g) => g.demos)

export function App() {
  const [activeTab, setActiveTab] = createSignal('vnext-wave5')
  const t = useT()

  const activeDemo = () => allDemos.find((d) => d.id === activeTab())

  return (
    <div class="app">
      <header class="app-header">
        <h1 class="app-title">{t('app.title')}</h1>
        <span class="app-subtitle">{t('app.subtitle')}</span>
        <LocaleSwitcher />
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
                    data-testid={`nav-tab-${demo.id}`}
                    onClick={() => setActiveTab(demo.id)}
                  >
                    {t(demo.labelKey)}
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
