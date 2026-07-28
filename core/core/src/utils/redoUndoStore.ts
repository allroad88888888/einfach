import type { Atom } from '../type'

type Listener = (atoms: Set<Atom<any>>) => void

const listeners = new Set<Listener>()

const cache = new Set<Atom<any>>()

function triggerListeners() {
  listeners.forEach((listener) => {
    listener(cache)
  })
}

/**
 * watch atom
 * @param atomEntity
 */
export function watchAtom<AtomType extends Atom<any>>(atomEntity: AtomType) {
  if (!cache.has(atomEntity)) {
    cache.add(atomEntity)
    triggerListeners()
  }
}

/**
 * 添加订阅方法
 * @param fn
 */
export function subscribe(fn: Listener) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

