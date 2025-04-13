import { test } from '@jest/globals'
import { createAtomFamilyStore } from '../../src/utils/createFamilyEasy'

// import { createStore } from '../core'

test('createFamilyEasy ', () => {
  // const store = createStore()\
  const { createAtomFamily } = createAtomFamilyStore()
  const getAtomById = createAtomFamily({
    debuggerKey: 'atom-options',
  })

  const start = performance.now()
  Array(10000 * 100)
    .fill(null)
    .map((temp, index) => {
      getAtomById(`${index}`, {})
    })

  // function create() { return {} }
  // Array(10000 * 100).fill(null).map((temp, index) => {
  //   return create()
  // })

  const end = performance.now()
  // eslint-disable-next-line no-console
  console.log('start - end', start - end)
})
