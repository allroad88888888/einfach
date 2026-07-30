import { apiPackages } from '../api-reference'

export function ApiReferenceLink() {
  return (
    <section id="api" className="api-reference-link section" aria-labelledby="api-link-title">
      <p className="eyebrow">COMPLETE API REFERENCE</p>
      <div className="api-reference-link-content">
        <div>
          <h2 id="api-link-title">准备写代码时，按包精确查 API。</h2>
          <p>独立 API 参考覆盖 {apiPackages.length} 个公开包：每个生态各自成页，按当前包的分组查阅。</p>
        </div>
        <a className="button-primary" href="./api/">
          打开 API 参考 →
        </a>
      </div>
    </section>
  )
}
