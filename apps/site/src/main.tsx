import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider } from '@einfach/react'
import { App } from './App'
import './styles/base.css'
import './styles/async-demo.css'
import './styles/core-principles.css'
import './styles/ai-contract.css'
import './styles/demo.css'
import './styles/api.css'
import './styles/api-directory.css'
import './styles/responsive.css'

const siteStore = createStore()
const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Could not find the site root element.')
}

createRoot(rootElement).render(
  <StrictMode>
    <Provider store={siteStore}>
      <App />
    </Provider>
  </StrictMode>,
)
