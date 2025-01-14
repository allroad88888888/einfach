import { describe, expect, it } from '@jest/globals'
import { act, renderHook } from '@testing-library/react'
import { atom } from '../core'
import { useAtom } from './useAtom'

describe('useAtomValue', () => {
  it('easy', async () => {
    const baseAtom = atom(0)

    let renderANum = 0
    const { result } = renderHook(() => {
      renderANum += 1
      return useAtom(baseAtom)
    })

    act(() => {
      result.current[1](9)
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
