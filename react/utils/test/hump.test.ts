import { describe, test, expect } from '@jest/globals'
import { htmlToHump } from '../src/react/hump'

describe('react', () => {
  test('hump', async () => {
    const x = htmlToHump('<ghj-dsf="dsf"  fill-rule="evenodd"')

    expect(x).toBe('<ghjDsf="dsf"  fillRule="evenodd"')
  })
})
