import { render } from 'solid-js/web'
import { App } from './App'
import '../../../solid/excel/src/styles.css'
import './styles.css'

const root = document.getElementById('app')

if (!root) {
  throw new Error('Excel showcase mount point was not found')
}

render(() => <App />, root)
