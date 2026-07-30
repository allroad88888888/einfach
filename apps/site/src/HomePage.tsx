import { AiContract } from './components/AiContract'
import { ApiReferenceLink } from './components/ApiReferenceLink'
import { AsyncDemo } from './components/AsyncDemo'
import { AtomDemo } from './components/AtomDemo'
import { CorePrinciples } from './components/CorePrinciples'
import { Header } from './components/Header'
import { Hero } from './components/Hero'

export function HomePage() {
  return (
    <div className="site-shell">
      <Header />
      <main>
        <Hero />
        <AsyncDemo />
        <CorePrinciples />
        <AiContract />
        <AtomDemo />
        <ApiReferenceLink />
      </main>
      <footer className="site-footer">
        <span>Einfach / 一切复杂，归于原子。</span>
        <a href="https://github.com/allroad88888888/einfach">GitHub</a>
      </footer>
    </div>
  )
}
