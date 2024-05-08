import type { AtomEntity, InterState } from '../core'
import type { HookOption } from './type'
import { useAtomValue } from './useAtomValue'
import { useSetAtom } from './useSetAtom'

export function useAtom<T extends InterState = InterState>(
  atomEntity: AtomEntity<T>, options: HookOption) {
  return [useAtomValue(atomEntity, options), useSetAtom(atomEntity, options)]
}
