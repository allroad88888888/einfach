import type { AtomEntity, AtomState, Store } from '@einfach/core'
import { atom } from '@einfach/core'

/**
 * 前进回退开关
 */
export const openUndoRedoAtom = atom(false)

export function createUndoRedo(store: Store) {
  const historyIndexAtom = atom(0)
  const isRedoUndoAtom = atom(false)
  const isMergeAtom = atom(false)

  const cacheAtomEntitySet = new WeakSet<AtomEntity<any>>()
  const historyDataAtom = atom<WeakMap<AtomEntity<any>, any>[]>([])
  // Map to WeakMap
  const iteratorKey = Symbol('iteratorKey') as unknown as AtomEntity<any>

  function watchAtom<AtomType extends AtomEntity<any>>(atomEntity: AtomType) {
    if (cacheAtomEntitySet.has(atomEntity)) {
      return
    }
    cacheAtomEntitySet.add(atomEntity)
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
    /**
     * mergeState没有change 直接丢错误
     */
    if (!newDataMap) {
      return
    }
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

  function mergeState(fn: () => void) {
    try {
      store.setter(isMergeAtom, true)
      fn()
      store.setter(historyIndexAtom, (index) => {
        const currentHis = store.getter(historyDataAtom)
        if (currentHis.length === index + 1) {
          return index
        }
        return index + 1
      })
    } catch (error) {
      store.setter(historyIndexAtom, (index) => {
        return index + 1
      })
      store.setter(undoAtom)
      const currentIndex = store.getter(historyIndexAtom)
      const nextIndx = currentIndex + 1
      const hisState = [...store.getter(historyDataAtom)]
      hisState.splice(nextIndx, 1)
      store.setter(historyDataAtom, hisState)
      store.setter(isMergeAtom, false)
      throw error
    }
    store.setter(isMergeAtom, false)
  }

  /**
   * 将最新状态重置为初始状态
   */
  function resetByNow() {
    store.setter(isRedoUndoAtom, true)
    const historyData = store.getter(historyDataAtom)
    const todoAtomEntitySet = new Set()

    const newHisData: WeakMap<AtomEntity<any>, any> = new WeakMap()
    historyData.toReversed().forEach((data) => {
      if (!historyData) {
        return
      }
      const setKeys = new Set<AtomEntity<any>>(data.get(iteratorKey))

      setKeys.forEach((tempAtomEntity) => {
        if (!todoAtomEntitySet.has(tempAtomEntity)) {
          todoAtomEntitySet.add(tempAtomEntity)
          newHisData.set(tempAtomEntity, data.get(tempAtomEntity))
        }
      })
    })
    store.setter(historyDataAtom, [newHisData])
    store.setter(historyIndexAtom, 0)
    store.setter(isRedoUndoAtom, false)
  }

  return {
    resetByNow,
    watchAtom,
    undoAtom,
    redoAtom,
    undo() {
      store.setter(undoAtom)
    },
    redo() {
      store.setter(redoAtom)
    },
    mergeState,
  }
}
