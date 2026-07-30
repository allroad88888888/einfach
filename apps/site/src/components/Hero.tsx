const installation = 'pnpm add @einfach/react'

export function Hero() {
  return (
    <section id="top" className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">ATOM STATE / TYPESCRIPT FIRST</p>
        <h1 id="hero-title">
          异步衍生状态，
          <span>让需求变化保持局部。</span>
        </h1>
        <p className="hero-description">
          一个 atom 只表达一个事实或规则。跨组件直接读取，不传状态 props；异步读取、派生
          和写入也沿同一条可追踪的依赖链运行。
        </p>
        <ul className="hero-benefits" aria-label="Einfach 的核心收益">
          <li>异步衍生是一等模型，不是额外的副作用层</li>
          <li>组件直接读取 atom，状态不必穿过组件树</li>
          <li>状态颗粒度小，新增需求只扩展局部依赖链</li>
        </ul>
        <div className="hero-actions">
          <a className="button button-primary" href="#async">
            先看异步衍生
          </a>
          <code>{installation}</code>
        </div>
      </div>
      <div className="hero-terminal" aria-label="Einfach 代码示例">
        <div className="terminal-bar">
          <span />
          <span />
          <span />
          <p>profile.ts</p>
        </div>
        <pre>{`import { atom } from '@einfach/react'

const requestAtom = atom({ userId: '42' })

const profileAtom = atom(async (get) => {
  return fetchProfile(get(requestAtom))
})

const refreshAtom = atom(null, (get, set) => {
  set(requestAtom, { ...get(requestAtom) })
})`}</pre>
        <p className="terminal-result">✓ source、异步衍生与写入边界都在同一张状态图里。</p>
      </div>
    </section>
  )
}
