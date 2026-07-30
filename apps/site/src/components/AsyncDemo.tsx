import { useAtomValue, useSetAtom } from '@einfach/react'
import { profileSummaryViewAtom, runAsyncPreviewAtom } from '../siteAtoms'

function getAsyncMessage(result: { data?: { name: string; version: number }; error?: unknown }) {
  if (result.error instanceof Error) {
    return result.error.message
  }

  return result.data ? `已得到 Profile（revision ${result.data.version}）` : '异步衍生尚未完成'
}

export function AsyncDemo() {
  const result = useAtomValue(profileSummaryViewAtom)
  const runRequest = useSetAtom(runAsyncPreviewAtom)
  const isLoading = result.state === 'loading'
  const status = isLoading ? 'loading' : result.state === 'hasError' ? 'hasError' : 'hasData'

  return (
    <section id="async" className="async-demo section" aria-labelledby="async-demo-title">
      <div className="section-heading async-demo-heading">
        <p className="eyebrow">ASYNC DERIVED STATE</p>
        <h2 id="async-demo-title">异步衍生，就是读取 atom 后返回 Promise。</h2>
        <p>
          中间的 <code>atom(async (get) =&gt; ...)</code> 才是业务异步。它读取 source atom，返回
          Promise；<code>loadable</code> 只在最后把结果交给 UI 呈现。
        </p>
      </div>
      <div className="async-layout">
        <div className="async-explainer" aria-label="异步衍生关系">
          <p className="async-key">
            只需要记住：<code>profileSummaryAtom</code> 读取 <code>requestAtom</code>，它的 Promise
            就是异步衍生的结果。
          </p>
          <div className="async-flow">
            <article className="async-step">
              <span>01 / SOURCE</span>
              <strong>requestAtom</strong>
              <p>保存请求参数，是可写的事实。</p>
            </article>
            <div className="async-arrow" aria-hidden="true">
              <span>get(requestAtom)</span>→
            </div>
            <article className="async-step async-derived-step">
              <span>02 / ASYNC DERIVED</span>
              <strong>profileSummaryAtom</strong>
              <p>读取参数，返回 Promise&lt;Profile&gt;。</p>
              <b>真正的异步衍生</b>
            </article>
            <div className="async-arrow" aria-hidden="true">
              <span>UI only</span>→
            </div>
            <article className="async-step">
              <span>03 / VIEW ADAPTER</span>
              <strong>loadable(profileSummaryAtom)</strong>
              <p>只映射 loading / data / error。</p>
            </article>
          </div>
          <pre className="async-code">{`const profileSummaryAtom = atom(async (get) => {
  const request = get(requestAtom)
  return fetchProfile(request)
})

const profileViewAtom = loadable(profileSummaryAtom) // 仅 UI`}</pre>
        </div>
        <aside className="async-result" aria-live="polite">
          <div className="async-result-header">
            <p>交互验证</p>
            <span className={`status-${status}`}>{status}</span>
          </div>
          <p className="async-result-label">profileSummaryAtom 的当前结果</p>
          <strong>{getAsyncMessage(result)}</strong>
          <p className="async-result-note">点击会写入新的 requestAtom，异步衍生随即重新计算。</p>
          <div className="async-actions">
            <button type="button" disabled={isLoading} onClick={() => runRequest('success')}>
              重新请求
            </button>
            <button type="button" disabled={isLoading} onClick={() => runRequest('error')}>
              模拟错误
            </button>
          </div>
        </aside>
      </div>
    </section>
  )
}
