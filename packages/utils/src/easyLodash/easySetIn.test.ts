import { describe, expect, it } from '@jest/globals'
import { easySetIn } from './easySetIn'

describe('easySetIn', () => {
  const mockObj = {
    a: {
      'a-1': 'a-1',
      'b-1': 'b-1',
    },
    b: [{
      'b-1': 'b-1',
    }, {
      'b-2': 'b-2',
    }, 'b-3'],
  }

  it('setInObj', async () => {
    const temp1 = easySetIn(mockObj, 'a.a-1', 'c')
    expect(temp1.a['a-1']).toBe('c')
    expect(temp1.a).not.toBe(mockObj.a)
    expect(temp1.b).toBe(mockObj.b)
    expect(temp1.b[0]).toBe(mockObj.b[0])
    expect(temp1).toEqual({
      a: {
        'a-1': 'c',
        'b-1': 'b-1',
      },
      b: [{
        'b-1': 'b-1',
      }, {
        'b-2': 'b-2',
      }, 'b-3'],
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
      b: [{
        'b-1': 'b-1',
      }, {
        'b-1': 'c',
        'b-2': 'b-2',
      }, 'b-3'],
    })
  })
  it('setInArray-up', async () => {
    const temp1 = easySetIn(mockObj, 'b.[0].b-1', 'c')
    expect(temp1.b[0]['b-1']).toBe('c')
    expect(temp1.b[0]).not.toBe(mockObj.b[1])
    expect(temp1.a).toBe(mockObj.a)
    expect(temp1.b[1]).toBe(mockObj.b[1])
    expect(temp1).toEqual({
      a: {
        'a-1': 'a-1',
        'b-1': 'b-1',
      },
      b: [{
        'b-1': 'c',
      }, {
        'b-2': 'b-2',
      }, 'b-3'],
    })
  })
})
