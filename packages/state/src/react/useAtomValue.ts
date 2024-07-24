import { useLayoutEffect, useState } from 'react';
import type { Atom, AtomState } from '../core/type';
import type { HookOption } from './type';
import { useStore } from './useStore';
import { isPromiseLike } from '../core/promiseUtils';
import { use } from './use';
import type { StatesWithPromise } from '../core/typePromise';


export function useAtomValue<State>(atom: Atom<State>, options?: HookOption): State;
export function useAtomValue<AtomType extends Atom<unknown>>(
  atom: AtomType, options?: HookOption): AtomState<AtomType>;
export function useAtomValue<State>(atom: Atom<State>, options: HookOption = {}) {
  const realStore = useStore(options);
  const [state, setState] = useState(() => {
    return realStore.getter(atom);
  });

  useLayoutEffect(() => {
    // init useLayoutEffect有个过程 过程中值可能变了
    if (realStore.getter(atom) !== state) {
      setState(realStore.getter(atom));
    }
    return realStore.sub(atom, () => {
      setState(realStore.getter(atom));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realStore, atom]);

  if (isPromiseLike(state)) {
    return use(state as StatesWithPromise<State>);
  }
  return state;
}


