import { useAtomValue } from '@einfach/react'
import { counterAtom, doubledCounterAtom } from '../siteAtoms'

const contractRows = [
  {
    label: '输入事实',
    value: 'countAtom: number',
    note: '唯一可写状态',
    tone: 'source',
  },
  {
    label: '派生规则',
    value: 'count × 2',
    note: '只读取 countAtom',
    tone: 'rule',
  },
  {
    label: '只读结果',
    value: 'doubledCounterAtom: number',
    note: '由规则自动计算',
    tone: 'derived',
  },
] as const

export function AiContract() {
  const count = useAtomValue(counterAtom)
  const doubledCount = useAtomValue(doubledCounterAtom)

  return (
    <section id="ai" className="ai-contract section" aria-labelledby="ai-contract-title">
      <div className="section-heading ai-contract-heading">
        <p className="eyebrow">AI-READABLE STATE MODEL</p>
        <h2 id="ai-contract-title">给 AI 的不是约定，是可执行的依赖图。</h2>
        <p>
          AI 不需要猜测状态藏在哪里、谁能改它。输入事实、派生规则和只读结果有明确名称与
          类型，改动可以沿依赖图验证。
        </p>
      </div>
      <div className="contract-layout">
        <div className="contract-rows" aria-label="count 状态契约">
          {contractRows.map((row, index) => (
            <article className={`contract-row contract-${row.tone}`} key={row.label}>
              <span className="contract-index">0{index + 1}</span>
              <div>
                <p>{row.label}</p>
                <strong>{row.value}</strong>
              </div>
              <small>{row.note}</small>
            </article>
          ))}
        </div>
        <aside className="contract-proof" aria-label="当前派生结果">
          <p>可校验的当前结果</p>
          <div className="proof-values">
            <span>{count}</span>
            <i aria-hidden="true">× 2</i>
            <strong>{doubledCount}</strong>
          </div>
          <pre>{`doubledCounterAtom =
  get(countAtom) * 2`}</pre>
          <p className="proof-note">写入 countAtom 后，结果必须始终等于 count × 2。</p>
        </aside>
      </div>
    </section>
  )
}
