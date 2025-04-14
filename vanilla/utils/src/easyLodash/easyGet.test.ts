import { describe, expect, it } from '@jest/globals'
import { easyGet } from './easyGet'

describe('easyGet', () => {
  const mockObj = {
    a: {
      'a-1': 'a-1',
      'b-1': 'b-1',
    },
    b: [
      {
        'b-1': 'b-1',
      },
      {
        'b-2': 'b-2',
      },
      'b-3',
    ] as [Record<string, string>, Record<string, string>, string],
    c: 'str',
    d: null,
  }

  it('normal', async () => {
    const temp1 = easyGet(mockObj, 'a.a-1')
    expect(temp1).toBe('a-1')
  })
  it('array', async () => {
    const temp1 = easyGet(mockObj, 'b.[0].b-1')
    expect(temp1).toBe('b-1')
    const temp2 = easyGet(mockObj, ['b', 0, 'b-1'])
    expect(temp2).toBe('b-1')
    const temp3 = easyGet(mockObj, ['b', 1, 'b-2'])
    expect(temp3).toBe('b-2')
  })

  it('没有这个属性', async () => {
    const temp3 = easyGet(mockObj, 'c.ss')
    expect(temp3).toBe(undefined)
  })
  it('没有这个属性-null', async () => {
    const temp3 = easyGet(mockObj, 'd.xx.xs')
    expect(temp3).toBe(undefined)
  })
})
