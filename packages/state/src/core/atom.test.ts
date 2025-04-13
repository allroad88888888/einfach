import { describe, test, expect } from '@jest/globals'
import { atom } from './atom'
import { createStore } from './store'

describe('store', () => {
  test('easy', () => {
    const atom1 = atom(10)
    const atom2 = atom((getter) => {
      const state1 = getter(atom1)
      return state1 + 10
    })
    const atom3 = atom((getter) => {
      return getter(atom2) + 10
    })

    const atom4 = atom((getter) => {
      return getter(atom3) + 10
    })


    const store = createStore()
    let state4 = store.getter(atom4)
    store.sub(atom4, () => {
      state4 = store.getter(atom4)
    })
    expect(state4).toBe(40)
    store.setter(atom1, 20)
    expect(state4).toBe(50)
    store.setter(atom1, 30)
    expect(state4).toBe(60)
  })


  test('store-sub', () => {
    const atom1 = atom({ a: { b: 123 } })
    const atom2 = atom((get) => {
      const state1 = get(atom1)
      return state1.a
    })

    // const atom3 = atom((get) => {
    //   const state2 = get(atom2);
    //   return state2.b + 123;
    // });

    const store = createStore()
    let state2 = store.getter(atom2)
    // let state3 = store.getter(atom3);

    store.sub(atom2, () => {
      state2 = store.getter(atom2)
    })

    // store.sub(atom3, () => {
    //   state3 = store.getter(atom3);
    // });
    store.setter(atom1, {
      a: { b: 1 },
    })
    expect(state2).toStrictEqual({ b: 1 })
    // expect(state3 === 124).toBe(true);
  })

  // test('function', () => {
  //   const atom1 = atom(1);

  //   let runAtom = 0;
  //   const atom2 = atom((getter) => {
  //     runAtom += 1;
  //     return getter(atom1);
  //   });

  //   const store = createStore();

  //   store.getter(atom2);

  //   let renderAtom2 = 0;
  //   store.sub(atom2, () => {
  //     renderAtom2 += 1;
  //   });

  //   expect(runAtom).toBe(1);

  //   store.setter(atom1, 2);
  //   expect(runAtom).toBe(2);
  //   store.getter(atom2);
  //   expect(runAtom).toBe(2);
  //   const valAtom2 = store.getter(atom2);
  //   expect(renderAtom2).toBe(1);
  //   expect(runAtom).toBe(2);
  //   expect(valAtom2).toBe(2);
  // });
})
