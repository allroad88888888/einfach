import type { WritableAtom } from '../core';
import { atom, getDefaultStore, type AtomEntity } from '../core';
import { useAtomValue } from './useAtomValue';
import type { HookOption } from './type';
import type { NamePath } from 'einfach-utils';
import { easyGet, useInit } from 'einfach-utils';
import type { ReturnState } from '../core/typePromise';

const defaultStore = getDefaultStore();
export function selectAtom<Slice, State>(
  atomEntity: WritableAtom<State>,
  selectFn: ((current: ReturnState<State>, prev?: Slice) => Slice) | NamePath,
  equalityFn: (prev: Slice, next: Slice) => boolean = Object.is,
) {
  const Empty = Symbol('empty');
  const prevAtom = atom<Slice | symbol>(Empty);
  return atom((getter) => {
    const info = getter(atomEntity);
    const prev = defaultStore.getter(prevAtom) as Slice;
    let next: Slice;
    if (typeof selectFn === 'function') {
      next = selectFn(info, prev);
    } else {
      next = easyGet(info, selectFn) as Slice;
    }
    if (prev !== Empty && equalityFn(prev, next)) {
      return prev;
    }
    defaultStore.setter(prevAtom, next);
    return next;
  }) as AtomEntity<Slice>;
}

export function useSelectAtomValue<Slice, State>(
  atomEntity: WritableAtom<State>,
  selectFn: (prev: ReturnState<State>) => Slice,
  equalityFn: (prev: Slice, next: Slice) => boolean,
  option?: HookOption
): Slice;
export function useSelectAtomValue<Slice, State>(
  atomEntity: WritableAtom<State>,
  selectFn: ((prev: ReturnState<State>) => Slice) | NamePath,
  equalityFn: (prev: Slice, next: Slice) => boolean,
  option?: HookOption
): Slice;

export function useSelectAtomValue<Slice, State>(
  atomEntity: WritableAtom<State>,
  selectFn: ((prev: ReturnState<State>) => Slice) | NamePath,
  equalityFn: (prev: Slice, next: Slice) => boolean = Object.is,
  option: HookOption = {},
) {
  const selectAtomEntity = useInit(() => {
    return selectAtom<Slice, State>(atomEntity, selectFn, equalityFn);
  }, [atomEntity, selectFn, equalityFn]);

  return useAtomValue<Slice>(selectAtomEntity, option);
}
