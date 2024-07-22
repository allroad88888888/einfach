import type { AtomEntity } from '../core';
import type { HookOption } from './type';
import { useAtomValue } from './useAtomValue';
import type { SetAtomMethod } from './useSetAtom';
import { useSetAtom } from './useSetAtom';

export function useAtom<T>(
  atomEntity: AtomEntity<T>, options: HookOption = {}) {
  return [useAtomValue(atomEntity, options),
    useSetAtom(atomEntity, options)] as [T, SetAtomMethod<T>];
}
