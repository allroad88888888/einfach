const principles = [
  {
    index: '01',
    title: '跨组件读取，不传状态 props',
    description:
      '同一 Provider 下，任何需要共享状态的组件都可直接订阅同一个 atom。props 留给组件配置，组件层级不再承担数据通道。',
    code: 'const profile = useAtomValue(profileAtom)\n// 任意需要它的组件直接读取',
  },
  {
    index: '02',
    title: '把写入收束为命令 atom',
    description:
      '推荐用命令 atom 收束跨状态操作：getter 可读取任意关联 atom，setter 可精确写入需要改变的 atom。',
    code: 'const saveAtom = atom(null, (getter, setter, draft) => {\n  const user = getter(userAtom)\n  setter(userAtom, { ...user, ...draft })\n})',
  },
  {
    index: '03',
    title: '状态颗粒度小，需求变更更好适应',
    description:
      '一个需求只影响少量 source 或 derived atom。新增或调整需求时，沿这条局部依赖链增改即可，无需扩张全局对象或碰无关组件。',
    code: "const planAtom = atom<'free' | 'pro'>('free')\nconst canExportAtom = atom((get) => get(planAtom) === 'pro')",
  },
] as const

export function CorePrinciples() {
  return (
    <section id="principles" className="core-principles section" aria-labelledby="principles-title">
      <div className="section-heading principles-heading">
        <p className="eyebrow">THE EINFACH MODEL</p>
        <h2 id="principles-title">不搬运状态，把变化收束在局部。</h2>
        <p>不传 props、命令 atom 与小颗粒状态组成同一套约束：人和 AI 都能沿短依赖链安全改动。</p>
      </div>
      <div className="principles-grid">
        {principles.map((principle) => (
          <article className="principle-card" key={principle.index}>
            <span>{principle.index}</span>
            <h3>{principle.title}</h3>
            <p>{principle.description}</p>
            <pre>{principle.code}</pre>
          </article>
        ))}
      </div>
    </section>
  )
}
