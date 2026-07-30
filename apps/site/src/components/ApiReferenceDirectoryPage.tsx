import { apiPackages } from '../api-reference'
import { Header } from './Header'

function apiCount(sectionCount: (typeof apiPackages)[number]['sections']) {
  return sectionCount.reduce((sum, section) => sum + section.entries.length, 0)
}

export function ApiReferenceDirectoryPage() {
  return (
    <div className="site-shell">
      <Header apiReference />
      <main id="api-top" className="api-directory-main">
        <section className="api-directory-heading section" aria-labelledby="api-reference-title">
          <p className="eyebrow">EINFACH API REFERENCE</p>
          <h1 id="api-reference-title">API Reference</h1>
          <p>按包查阅全部公开导出。异步衍生优先从 Core 的 atom API 开始。</p>
        </section>

        <section className="api-directory section" aria-label="API 包目录">
          {apiPackages.map((apiPackage) => (
            <a className="api-directory-package" href={`./${apiPackage.id}/`} key={apiPackage.id}>
              <span className="api-directory-package-topline">
                <strong>{apiPackage.packageName}</strong>
                <small>{apiCount(apiPackage.sections)} 项</small>
              </span>
              <span>{apiPackage.summary}</span>
              <span className="api-directory-package-sections">
                {apiPackage.sections.map((section) => section.navLabel).join(' · ')}
              </span>
            </a>
          ))}
        </section>
      </main>
      <footer className="site-footer">
        <span>Einfach / 一切复杂，归于原子。</span>
        <a href="https://github.com/allroad88888888/einfach">GitHub</a>
      </footer>
    </div>
  )
}
