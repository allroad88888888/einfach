import type { ApiPackage } from '../api-reference'
import { Header } from './Header'

function packageAnchor(packageId: string) {
  return `package-${packageId}`
}

function sectionAnchor(packageId: string, sectionIndex: number) {
  return `${packageAnchor(packageId)}-section-${sectionIndex + 1}`
}

export function ApiPackageReferencePage({ apiPackage }: { apiPackage: ApiPackage }) {
  const apiCount = apiPackage.sections.reduce((sum, section) => sum + section.entries.length, 0)

  return (
    <div className="site-shell">
      <Header apiPackage />
      <main id="api-top" className="api-reference-main">
        <section className="api-reference-heading section" aria-labelledby="api-reference-title">
          <p className="eyebrow">EINFACH API / {apiPackage.label.toUpperCase()}</p>
          <h1 id="api-reference-title">{apiPackage.packageName}</h1>
          <p>{apiPackage.summary}</p>
        </section>

        <div className="api-reference-layout section">
          <aside className="api-reference-nav" aria-label={`${apiPackage.packageName} 导航`}>
            <p>PACKAGE</p>
            <nav>
              <div className="api-nav-package">
                <a className="api-nav-package-link" href={`#${packageAnchor(apiPackage.id)}`}>
                  <span>{apiPackage.label}</span>
                  <small>{apiCount}</small>
                </a>
                <div className="api-nav-sections">
                  {apiPackage.sections.map((section, sectionIndex) => (
                    <a
                      className="api-nav-section-link"
                      href={`#${sectionAnchor(apiPackage.id, sectionIndex)}`}
                      key={section.title}
                    >
                      {section.navLabel}
                    </a>
                  ))}
                </div>
              </div>
            </nav>
          </aside>

          <section
            id={packageAnchor(apiPackage.id)}
            className="api-package"
            aria-labelledby={`${apiPackage.id}-title`}
          >
            <div className="api-package-heading">
              <h2 id={`${apiPackage.id}-title`}>{apiPackage.packageName}</h2>
              <p>{apiPackage.summary}</p>
            </div>
            {apiPackage.reexportsCore ? (
              <p className="api-reexport-note">
                此包完整再导出 Core；Core API 请查阅 <a href="../core/">@einfach/core</a>。
              </p>
            ) : null}
            {apiPackage.sections.map((section, sectionIndex) => (
              <section
                id={sectionAnchor(apiPackage.id, sectionIndex)}
                className="api-section"
                key={section.title}
              >
                <div className="api-section-heading">
                  <div>
                    <p>MODULE</p>
                    <h2>{section.title}</h2>
                    <span>{section.description}</span>
                  </div>
                  <b>{section.entries.length} APIs</b>
                </div>
                <div className="api-entries">
                  {section.entries.map((entry) => (
                    <article className="api-entry" key={entry.name}>
                      <header className="api-entry-heading">
                        <span className="api-entry-meta">
                          <strong>{entry.name}</strong>
                          <span className="api-role">{entry.role}</span>
                          {entry.kind === 'type' ? <span className="api-kind">TYPE</span> : null}
                        </span>
                      </header>
                      <p className="api-entry-description">{entry.description}</p>
                      <pre>
                        <code>{entry.code}</code>
                      </pre>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </section>
        </div>
      </main>
      <footer className="site-footer">
        <span>Einfach / 一切复杂，归于原子。</span>
        <a href="https://github.com/allroad88888888/einfach">GitHub</a>
      </footer>
    </div>
  )
}
