import type { AtomEntity, AtomState, Store } from '../core'
import { atom } from '../core'

/**
 * 前进回退开关
 */
export const openUndoRedoAtom = atom(false)

export function createUndoRedo(store: Store) {
  const historyIndexAtom = atom(0)
  const isRedoUndoAtom = atom(false)
  const isMergeAtom = atom(false)

  const historyDataAtom = atom<WeakMap<AtomEntity<any>, any>[]>([])
  // Map to WeakMap
  const iteratorKey = Symbol('iteratorKey') as unknown as AtomEntity<any>

  function watchAtom<AtomType extends AtomEntity<any>>(atomEntity: AtomType) {
    function subAtom(isInit: boolean = false) {
      const isRedoUndo = store.getter(isRedoUndoAtom)
      if (isRedoUndo) {
        return
      }
      const currentIndex = store.getter(historyIndexAtom)
      const isMerge = store.getter(isMergeAtom)
      const nextIndx = isInit ? 0 : currentIndex + 1
      const hisState = [...store.getter(historyDataAtom)]

      const dataWeakMap = hisState[nextIndx] || new WeakMap<AtomType, AtomState<AtomType>>()
      dataWeakMap.set(atomEntity, store.getter(atomEntity) as AtomState<AtomType>)
      hisState.splice(nextIndx, 1, dataWeakMap)
      if (!dataWeakMap.has(iteratorKey)) {
        dataWeakMap.set(iteratorKey, [])
      }
      dataWeakMap.get(iteratorKey).push(atomEntity)

      store.setter(historyDataAtom, hisState)
      if (isInit || isMerge) {
        return
      }
      store.setter(historyIndexAtom, (index) => {
        return index + 1
      })
    }
    subAtom(true)
    store.sub(atomEntity, subAtom)
  }

  function undoData() {
    const historyIndex = store.getter(historyIndexAtom)
    const historyData = store.getter(historyDataAtom)

    const newIndex = historyIndex + 1
    const newDataMap = historyData[newIndex]
    const setKeys = new Set<AtomEntity<any>>(newDataMap.get(iteratorKey))

    for (let i = historyIndex, j = 0; i >= j; i -= 1) {
      const itDataMap = historyData[i]
      setKeys.forEach((key) => {
        if (itDataMap.has(key)) {
          store.setter(key, itDataMap.get(key))
          setKeys.delete(key)
        }
      })
      if (setKeys.size === 0) {
        break
      }
    }
    if (setKeys.size > 0) {
      throw "can't find prev state "
    }

    if (!newDataMap) {
      throw 'exceeds the length of history '
    }
  }

  function redoData() {
    const historyIndex = store.getter(historyIndexAtom)
    const historyData = store.getter(historyDataAtom)
    const tempDataMap = historyData[historyIndex]
    if (!tempDataMap) {
      throw 'exceeds the length of history '
    }

    const setKeys = new Set<AtomEntity<any>>(tempDataMap.get(iteratorKey))

    setKeys.forEach((tempAtomEntity) => {
      store.setter(tempAtomEntity, tempDataMap.get(tempAtomEntity))
    })
  }

  const undoAtom = atom(
    (_getter) => {
      return _getter(historyIndexAtom) > 0
    },
    (_getter, _setter) => {
      _setter(isRedoUndoAtom, true)
      store.setter(historyIndexAtom, (index) => {
        return index - 1
      })
      undoData()
      _setter(isRedoUndoAtom, false)
    },
  )

  const redoAtom = atom(
    (_getter) => {
      return _getter(historyIndexAtom) < _getter(historyDataAtom).length - 1
    },
    (_getter, _setter) => {
      _setter(isRedoUndoAtom, true)

      store.setter(historyIndexAtom, (index) => {
        return index + 1
      })
      redoData()
      _setter(isRedoUndoAtom, false)
    },
  )

  return {
    watchAtom,
    undoAtom,
    redoAtom,
    undo() {
      store.setter(undoAtom)
    },
    redo() {
      store.setter(redoAtom)
    },
    historyTransactionStart() {
      store.setter(isMergeAtom, true)
    },
    historyTransactionEnd() {
      store.setter(historyIndexAtom, (index) => {
        return index + 1
      })
    },
  }
}