import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom, getDefaultStore } from '../core'
import { useAtom } from './useAtom'
import { useAtomValue } from './useAtomValue'
import { useSetAtom } from './useSetAtom'
import { useCallback } from 'react'

describe('useAtomValue', () => {
  it('easy', async () => {
    const baseAtom = atom(0)

    const infoAtom = atom<{ a?: string }>({})

    const bigInfoAtom = atom((getter) => {
      return getter(baseAtom) + 10
    })

    let renderANum = 0
    const { result } = renderHook(() => {
      const [info, setInfo] = useAtom(infoAtom)

      const bigInfo = useAtomValue(bigInfoAtom)
      if (bigInfo > 10) {
        console.log('error', bigInfo)
      }
      if ('a' in info) {
        console.log('right', info)
      }

      renderANum += 1

      const setBaseAtom = useSetAtom(baseAtom)
      return useCallback(() => {
        const store = getDefaultStore()
        store.setter(baseAtom, 12)
        store.setter(infoAtom, { a: 'ee' })
        setBaseAtom(12)
        setInfo({
          a: 'ds123f',
        })
      }, [])
    })

    act(() => {
      result.current()
    })

    expect(renderANum).toBe(2)
  })

  //     const mockData = {
  //       a: '1',
  //       b: {
  //         'b-1': {
  //           a: 'a',
  //         },
  //       },
  //     };
  //     const atomEntity = atom(mockData);
  //     const atomOtherEntity = atom({});

  //     const atomSelect = selectAtom(
  //       atomEntity,
  //       (obj) => {
  //         return obj.b;
  //       },
  //       (a, b) => {
  //         return Object.is(a, b);
  //       },
  //     );

  //     const scope = Date.now();

  //     let renderANum = 0;
  //     const base = renderHook(() => {
  //       renderANum += 1;
  //       return useAtom(atomEntity, scope);
  //     }).result;

  //     let otherNum = 0;
  //     renderHook(() => {
  //       otherNum += 1;
  //       return useAtom(atomOtherEntity, scope);
  //     });

  //     let renderNum = 0;
  //     const res: any[] = [];
  //     renderHook(() => {
  //       renderNum += 1;
  //       res.push(useAtomValue(atomSelect, scope));
  //     });

  //     base.current[1]({
  //       ...base.current[0],
  //     });

  //     expect(renderANum).toBe(3);

  //     expect(res[0]).toBe(res[1]);
  //     expect(res[0]).toBe(res[2]);
  //     expect(res[0]).toBe(mockData.b);
  //     expect(renderNum).toBe(3);
  //     expect(otherNum).toBe(2);
  //   });
})
