import { describe, test, expect } from '@jest/globals'

const REG_THOUSANDS = /(\d)(?=(\d{3})+(?!\d))/g

describe('async', () => {
  test('1', async () => {
    const dynamicFunction = new Function(
      'num',
      `
              return num.replace(${REG_THOUSANDS}, '$1,');
                `,
    )

    const x = dynamicFunction('12312312')
    expect(x).toBe('12,312,312')
  })
  test('22222', async () => {
    const dynamicFunction = new Function(
      'num',
      `
          return num.replace(/(\\d)(?=(\\d{3})+(?!\\d))/g, '$1,');
            `,
    )

    const x = dynamicFunction('12312312')
    expect(x).toBe('12,312,312')
  })

  test('111111', async () => {
    const dynamicFunction = new Function(
      'num',
      `
       return num.replace(new RegExp('(\\d)(?=(\\d{3})+(?!\\d))',"g"),"$1,")
        `,
    )
    const x = dynamicFunction('12312312')
    expect(x).toBe('12312312')

    expect('12312312'.replace(new RegExp('(\\d)(?=(\\d{3})+(?!\\d))', 'g'), '$1,')).toBe(
      '12,312,312',
    )
  })
  test('111111', async () => {
    const dynamicFunction = new Function(
      'num',
      `
       return num.replace(new RegExp('(\\\\d)(?=(\\\\d{3})+(?!\\\\d))',"g"),"$1,")
        `,
    )
    const x = dynamicFunction('12312312')
    expect(x).toBe('12,312,312')
  })

  test('replace', async () => {
    const str = 'return num.replace(new RegExp(\'(\\d)(?=(\\d{3})+(?!\\d))\',"g"),"$1,")'

    const newStr = str.replace('(\\d)(?=(\\d{3})+(?!\\d))', '(\\\\d)(?=(\\\\d{3})+(?!\\\\d))')
    expect(newStr).toBe(
      'return num.replace(new RegExp(\'(\\\\d)(?=(\\\\d{3})+(?!\\\\d))\',"g"),"$1,")',
    )
    const dynamicFunction = new Function('num', newStr)
    const x = dynamicFunction('12312312')
    expect(x).toBe('12,312,312')
  })

  // replace(/\(\)"/g, "()").replace(/\\n/g, "\n")
})
