import { createStore } from './store'

const defaultStore = createStore()

export function getDefaultStore() {
  return defaultStore
}
