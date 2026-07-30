import { useAtom, useAtomValue } from '@einfach/react'
import { counterAtom, doubledCounterAtom } from '../siteAtoms'

export function AtomDemo() {
  const [count, setCount] = useAtom(counterAtom)
  const doubledCount = useAtomValue(doubledCounterAtom)

  return (
    <section id="demo" className="demo section" aria-labelledby="demo-title">
      <div className="section-heading demo-heading">
        <p className="eyebrow">LIVE ATOM DEMO</p>
        <h2 id="demo-title">只改一个事实，所有依赖自动跟上。</h2>
        <p>
          这个面板本身由 @einfach/react 驱动：点击只写入 countAtom；任何读取
          doubledCounterAtom 的组件都会得到同一份自动重算的结果。
        </p>
      </div>
      <div className="demo-card">
        <div className="atom-node source-node">
          <span className="node-label">source atom</span>
          <strong>countAtom</strong>
          <output aria-live="polite">{count}</output>
          <div className="counter-actions">
            <button
              type="button"
              onClick={() => setCount((value) => value - 1)}
              aria-label="减少计数"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => setCount((value) => value + 1)}
              aria-label="增加计数"
            >
              +
            </button>
          </div>
        </div>
        <div className="atom-link" aria-hidden="true">
          <span>pure rule</span>
          <i />
        </div>
        <div className="atom-node derived-node">
          <span className="node-label">derived atom</span>
          <strong>doubledCounterAtom</strong>
          <output aria-live="polite">{doubledCount}</output>
          <p>count × 2</p>
        </div>
      </div>
      <pre className="demo-code">{`const countAtom = atom(3)
const doubledCounterAtom = atom((get) => get(countAtom) * 2)`}</pre>
    </section>
  )
}
