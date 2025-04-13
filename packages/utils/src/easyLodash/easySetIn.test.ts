import { describe, expect, it } from '@jest/globals'
import { easySetIn } from './easySetIn'

describe('easySetIn', () => {
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
  }

  it('setInObj', async () => {
    const temp1 = easySetIn(mockObj, 'a.a-1', 'c')
    expect(temp1.a['a-1']).toBe('c')
    expect(temp1.a).not.toBe(mockObj.a)
    expect(temp1.b).toBe(mockObj.b)
    expect(temp1.b[0]).toBe(mockObj.b[0])
    expect(temp1).toStrictEqual({
      a: {
        'a-1': 'c',
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
      ],
    })
  })
  it('setInArray-new', async () => {
    const temp1 = easySetIn(mockObj, 'b.[1].b-1', 'c')
    expect(temp1.b[1]['b-1']).toBe('c')
    expect(temp1.b[1]).not.toBe(mockObj.b[1])
    expect(temp1.a).toBe(mockObj.a)
    expect(temp1.b[0]).toBe(mockObj.b[0])
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
          'b-1': 'c',
          'b-2': 'b-2',
        },
        'b-3',
      ],
    })
  })
  it('setInArray-up', async () => {
    const temp1 = easySetIn(mockObj, 'b.[0].b-1', 'c')
    expect(temp1.b[0]['b-1']).toBe('c')
    expect(temp1.b[0]).not.toBe(mockObj.b[1])
    expect(temp1.a).toBe(mockObj.a)
    expect(temp1.b[1]).toBe(mockObj.b[1])
    expect(temp1).toStrictEqual({
      a: {
        'a-1': 'a-1',
        'b-1': 'b-1',
      },
      b: [
        {
          'b-1': 'c',
        },
        {
          'b-2': 'b-2',
        },
        'b-3',
      ],
    })
  })

  it('setMap', async () => {
    const map = new Map<string, Record<string, any>>([
      [
        'a',
        {
          a: '1',
        },
      ],
      ['b', { b: '1' }],
    ])

    const temp1 = easySetIn(map, 'a.a', 'c')

    expect(temp1).toEqual(
      new Map([
        [
          'a',
          {
            a: 'c',
          },
        ],
        ['b', { b: '1' }],
      ]),
    )
  })
  it('setSet', async () => {
    const temp = new Set([{ a: 'a' }, { b: 'b' }])

    const temp1 = easySetIn(temp, '[0].a', 'c')

    expect(temp1).toEqual(new Set([{ a: 'c' }, { b: 'b' }]))
  })
  it('empty obj', async () => {
    const temp = {}

    const temp1 = easySetIn(temp, 'a.b', 'c')

    expect(temp1).toEqual({
      a: {
        b: 'c',
      },
    })
  })
  it('empty array', async () => {
    const temp = {}

    const temp1 = easySetIn(temp, 'a[2].b', 'c')

    expect(temp1).toStrictEqual({ a: [, , { b: 'c' }] })
  })

  it('没有这个属性', async () => {
    const temp3 = easySetIn(
      {
        c: 'str',
      },
      'c.ss',
      {},
    )
    expect(temp3).toStrictEqual({ c: { ss: {} } })
  })
})
