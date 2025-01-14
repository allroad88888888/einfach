import type { Atom, Store, AtomEntity } from '../core'
import { useEffect } from 'react'
import { createUndoRedo } from './createUndoRedo'

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

export function useRedoUndoCore(store: Store) {
  useEffect(() => {
    const { watchAtom: wAtom } = createUndoRedo(store)
    return subscribe((atomSet) => {
      atomSet.forEach((atomEntity) => {
        wAtom(atomEntity as AtomEntity<any>)
      })
    })
  }, [])
}
