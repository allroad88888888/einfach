import { describe, expect, it } from '@jest/globals'
import { easyClone } from './easyClone'

describe('easyClone', () => {
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
        'b-2': {
          'b2-1': 'b2-1',
        },
      },
      'b-3',
    ] as [Record<string, string>, Record<string, any>, string],
    c: new Set([{ a: 'a' }]),
    d: undefined,
    e: null,
  }

  it('easyClone', async () => {
    const temp1 = easyClone(mockObj)
    expect(temp1.a).not.toBe(mockObj.a)
    expect(temp1.b).not.toBe(mockObj.b)
    expect(temp1.a['a-1']).toBe(mockObj.a['a-1'])
    expect(temp1.a['b-1']).toBe(mockObj.a['b-1'])
    expect(temp1.b[0]).not.toBe(mockObj.b[0])
    expect(temp1.b[1]).not.toBe(mockObj.b[1])
    expect(temp1.b[1]['b-2']).not.toBe(mockObj.b[1]['b-2'])
    expect(temp1.b[2]).toBe(mockObj.b[2])
    expect(temp1.c).not.toBe(mockObj.c)
    expect(temp1).toEqual({
      a: {
        'a-1': 'a-1',
        'b-1': 'b-1',
      },
      b: [
        {
          'b-1': 'b-1',
        },
        {
          'b-2': {
            'b2-1': 'b2-1',
          },
        },
        'b-3',
      ],
      c: new Set([{ a: 'a' }]),
      d: undefined,
      e: null,
    })
  })
})
