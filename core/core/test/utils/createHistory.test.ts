import { describe, test, expect, jest } from '@jest/globals'
import { atom, createStore, createHistory, isSourceAtom } from '../../src'
import type { HistoryEntry, HistoryPersistPort, HistoryStackState, Store } from '../../src'

/**
 * 事务日志式 history 的行为钉。
 *
 * 重点覆盖旧快照式实现做不到的三件事:有界截断后剩余条目仍可回滚、
 * 整个栈可 JSON 往返、一次事务只占一步 undo。
 */

interface Fixture {
  store: Store
  history: ReturnType<typeof createHistory>
  countAtom: ReturnType<typeof atom<number>>
  textAtom: ReturnType<typeof atom<string>>
  set: (target: 'count', next: number) => void
}

function setup(options: Parameters<typeof createHistory>[1] = {}): Fixture {
  const store = createStore()
  const history = createHistory(store, options)
  const countAtom = atom(0)
  const textAtom = atom('')
  history.registerAtomApplier('count', () => countAtom)
  history.registerAtomApplier('text', () => textAtom)

  function set(_target: 'count', next: number) {
    const before = store.getter(countAtom)
    store.setter(countAtom, next)
    history.record({ key: 'count', before, after: next })
  }

  return { store, history, countAtom, textAtom, set }
}

describe('createHistory — 事务与提交', () => {
  test('一次事务只产生一条 entry,哪怕改了多个 atom', () => {
    const { store, history, countAtom, textAtom } = setup()

    history.transaction('输入', () => {
      const beforeCount = store.getter(countAtom)
      store.setter(countAtom, 7)
      history.record({ key: 'count', before: beforeCount, after: 7 })

      const beforeText = store.getter(textAtom)
      store.setter(textAtom, 'hi')
      history.record({ key: 'text', before: beforeText, after: 'hi' })
    })

    const state = history.getState()
    expect(state.entries).toHaveLength(1)
    expect(state.cursor).toBe(1)
    expect(state.entries[0].label).toBe('输入')
    expect(state.entries[0].ops).toHaveLength(2)

    // 旧实现在这里会是 2 步 undo
    history.undo()
    expect(store.getter(countAtom)).toBe(0)
    expect(store.getter(textAtom)).toBe('')
    expect(history.getState().cursor).toBe(0)
  })

  test('空事务与等值变更都不占一步', () => {
    const { store, history, countAtom } = setup()

    history.transaction(() => {
      // 什么都不做
    })
    expect(history.getState().entries).toHaveLength(0)

    history.transaction(() => {
      store.setter(countAtom, 0)
      history.record({ key: 'count', before: 0, after: 0 })
    })
    expect(history.getState().entries).toHaveLength(0)
  })

  test('嵌套事务合并为一条,内层不单独提交', () => {
    const { history, set } = setup()

    history.transaction('外', () => {
      set('count', 1)
      history.transaction('内', () => {
        set('count', 2)
      })
      set('count', 3)
    })

    const state = history.getState()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].label).toBe('外')
    expect(state.entries[0].ops).toHaveLength(3)
  })

  test('transaction 透传返回值', () => {
    const { history } = setup()
    expect(history.transaction(() => 42)).toBe(42)
    expect(history.transaction('带标签', () => 'ok')).toBe('ok')
  })
})

describe('createHistory — 事务失败回滚', () => {
  test('事务内抛异常:状态回到事务开始处,不留 entry,异常原样上抛', () => {
    const { store, history, countAtom, set } = setup()
    store.setter(countAtom, 5)

    expect(() =>
      history.transaction(() => {
        set('count', 10)
        set('count', 20)
        throw new Error('boom')
      }),
    ).toThrow('boom')

    expect(store.getter(countAtom)).toBe(5)
    expect(history.getState().entries).toHaveLength(0)
  })

  test('内层事务抛错被外层捕获:只回退内层,外层照常提交', () => {
    const { store, history, countAtom, set } = setup()

    history.transaction('外', () => {
      set('count', 1)
      try {
        history.transaction('内', () => {
          set('count', 99)
          throw new Error('inner')
        })
      } catch {
        // 外层吞掉
      }
      set('count', 2)
    })

    expect(store.getter(countAtom)).toBe(2)
    const state = history.getState()
    expect(state.entries).toHaveLength(1)
    // 内层那条 op 已被退回并丢弃
    expect(state.entries[0].ops.map((op) => op.after)).toEqual([1, 2])
  })
})

describe('createHistory — undo / redo', () => {
  test('往返与分支覆盖', () => {
    const { store, history, countAtom, set } = setup()

    history.transaction(() => set('count', 1))
    history.transaction(() => set('count', 2))
    expect(store.getter(countAtom)).toBe(2)

    expect(history.undo()).toBe(true)
    expect(store.getter(countAtom)).toBe(1)
    expect(history.redo()).toBe(true)
    expect(store.getter(countAtom)).toBe(2)

    history.undo()
    // 在 cursor=1 处开新分支,redo 尾被丢弃
    history.transaction(() => set('count', 30))
    const state = history.getState()
    expect(state.entries).toHaveLength(2)
    expect(state.cursor).toBe(2)
    expect(history.redo()).toBe(false)
  })

  test('到底/到顶返回 false,不动游标', () => {
    const { history } = setup()
    expect(history.undo()).toBe(false)
    expect(history.redo()).toBe(false)
    expect(history.getState().cursor).toBe(0)
  })

  test('op 的 undo 逆序、redo 顺序', () => {
    const store = createStore()
    const history = createHistory(store)
    const order: string[] = []
    history.registerApplier('trace', (_get, _set, op, direction) => {
      order.push(`${direction}:${String(op.after)}`)
      return true
    })

    history.transaction(() => {
      history.record({ key: 'trace', before: 0, after: 1 })
      history.record({ key: 'trace', before: 0, after: 2 })
      history.record({ key: 'trace', before: 0, after: 3 })
    })

    history.undo()
    expect(order).toEqual(['undo:3', 'undo:2', 'undo:1'])
    order.length = 0
    history.redo()
    expect(order).toEqual(['redo:1', 'redo:2', 'redo:3'])
  })

  test('applier 中途失败:已生效的部分被退回,游标不动', () => {
    const store = createStore()
    const errors: Error[] = []
    const history = createHistory(store, { onError: (error) => errors.push(error) })
    const aAtom = atom(0)
    let failOnUndo = false

    history.registerAtomApplier('a', () => aAtom)
    history.registerApplier('boom', (_get, _set, _op, direction) => {
      return !(failOnUndo && direction === 'undo')
    })

    history.transaction(() => {
      history.record({ key: 'a', before: 0, after: 1 })
      history.record({ key: 'boom', before: 'x', after: 'y' })
    })
    store.setter(aAtom, 1)

    failOnUndo = true
    expect(history.undo()).toBe(false)
    // 'boom' 逆序先跑并失败,'a' 尚未被回退;若顺序反过来,'a' 会被退回后重做
    expect(store.getter(aAtom)).toBe(1)
    expect(history.getState().cursor).toBe(1)
    expect(errors).toHaveLength(0)
  })
})

describe('createHistory — 有界截断(旧实现做不到的核心改进)', () => {
  test('超过 cap 从最老一端丢弃,且剩余条目仍能独立回滚', () => {
    const { store, history, countAtom, set } = setup({ cap: 3 })

    for (let index = 1; index <= 6; index += 1) {
      history.transaction(() => set('count', index))
    }
    expect(store.getter(countAtom)).toBe(6)

    const state = history.getState()
    expect(state.entries).toHaveLength(3)
    expect(state.cursor).toBe(3)

    // 旧的回溯扫描式实现在截断后会 throw "can't find prev state"
    expect(history.undo()).toBe(true)
    expect(store.getter(countAtom)).toBe(5)
    expect(history.undo()).toBe(true)
    expect(store.getter(countAtom)).toBe(4)
    expect(history.undo()).toBe(true)
    expect(store.getter(countAtom)).toBe(3)
    // 只保留 3 条,再往前没有了
    expect(history.undo()).toBe(false)
  })
})

describe('createHistory — 注册与校验', () => {
  test('record 在事务外抛错', () => {
    const { history } = setup()
    expect(() => history.record({ key: 'count', before: 0, after: 1 })).toThrow('transaction()')
  })

  test('未注册的 key 在 record 时就炸,而不是拖到 undo 才炸', () => {
    const { history } = setup()
    expect(() =>
      history.transaction(() => {
        history.record({ key: 'nope', before: 0, after: 1 })
      }),
    ).toThrow('没有注册 applier')
  })

  test('重复注册同一 key 抛错', () => {
    const { history } = setup()
    expect(() => history.registerAtomApplier('count', () => atom(0))).toThrow('已注册')
  })

  test('派生 atom / 命令 atom 被 registerAtomApplier 拒绝', () => {
    const store = createStore()
    const errors: Error[] = []
    const history = createHistory(store, { onError: (error) => errors.push(error) })
    const sourceAtom = atom(1)
    const derivedAtom = atom((getter) => getter(sourceAtom) * 2)
    const commandAtom = atom(null, () => undefined)

    history.registerAtomApplier('derived', () => derivedAtom as never)
    history.registerAtomApplier('command', () => commandAtom as never)

    history.transaction(() => {
      history.record({ key: 'derived', before: 2, after: 4 })
    })
    expect(history.undo()).toBe(false)
    expect(errors[0].message).toContain('不是源子 atom')

    errors.length = 0
    history.transaction(() => {
      history.record({ key: 'command', before: 1, after: 2 })
    })
    expect(history.undo()).toBe(false)
    expect(errors[0].message).toContain('不是源子 atom')
  })

  test('回放期间开事务抛错、undo 重入返回 false', () => {
    const store = createStore()
    const history = createHistory(store)
    let reentrantTransaction: unknown
    let reentrantUndo: unknown

    history.registerApplier('probe', () => {
      try {
        history.transaction(() => undefined)
      } catch (error) {
        reentrantTransaction = error
      }
      reentrantUndo = history.undo()
      return true
    })

    history.transaction(() => {
      history.record({ key: 'probe', before: 0, after: 1 })
    })
    history.undo()

    expect((reentrantTransaction as Error).message).toContain('回放期间')
    expect(reentrantUndo).toBe(false)
  })
})

describe('createHistory — family scope', () => {
  test('同一个 applier 靠 scope 服务任意多实例', () => {
    const store = createStore()
    const history = createHistory(store)
    const rows = new Map<string, ReturnType<typeof atom<string>>>()
    const getRowAtom = (id: string) => {
      if (!rows.has(id)) {
        rows.set(id, atom(''))
      }
      return rows.get(id)!
    }

    history.registerAtomApplier('row', (scope) => getRowAtom(scope!))

    history.transaction('批量填充', () => {
      for (const id of ['1', '2', '3']) {
        const target = getRowAtom(id)
        const before = store.getter(target)
        store.setter(target, `v${id}`)
        history.record({ key: 'row', scope: id, before, after: `v${id}` })
      }
    })

    expect(store.getter(getRowAtom('2'))).toBe('v2')
    history.undo()
    expect(store.getter(getRowAtom('1'))).toBe('')
    expect(store.getter(getRowAtom('2'))).toBe('')
    expect(store.getter(getRowAtom('3'))).toBe('')
    history.redo()
    expect(store.getter(getRowAtom('3'))).toBe('v3')
  })
})

describe('createHistory — 函数值还原(合成 write 的 updater 陷阱)', () => {
  /**
   * einfach 的源子 atom 无法直接持有函数:`atom(fn)` 会被当成派生 atom 的
   * read(atom.ts:24),`setter(a, fn)` 会被合成 write 当成 updater 执行
   * (atom.ts:31)。函数值只能包一层 thunk 写入——applier 因此一律用 thunk,
   * 于是函数值与普通值走同一条还原路径。
   */
  test('before/after 是函数时也能原样写回,不会被当成 updater 执行', () => {
    const store = createStore()
    const history = createHistory(store)
    const fnA = () => 'A'
    const fnB = () => 'B'
    const handlerAtom = atom<(() => string) | null>(null)
    history.registerAtomApplier('handler', () => handlerAtom)

    store.setter(handlerAtom, () => fnA)
    history.transaction(() => {
      store.setter(handlerAtom, () => fnB)
      history.record({ key: 'handler', before: fnA, after: fnB })
    })
    expect(store.getter(handlerAtom)).toBe(fnB)

    history.undo()
    expect(store.getter(handlerAtom)).toBe(fnA)
    history.redo()
    expect(store.getter(handlerAtom)).toBe(fnB)
  })
})

describe('createHistory — 投影 atom', () => {
  test('canUndo / canRedo / stack 随提交与游标更新', () => {
    const { store, history, set } = setup()

    expect(store.getter(history.canUndoAtom)).toBe(false)
    expect(store.getter(history.canRedoAtom)).toBe(false)

    history.transaction(() => set('count', 1))
    expect(store.getter(history.canUndoAtom)).toBe(true)
    expect(store.getter(history.canRedoAtom)).toBe(false)

    history.undo()
    expect(store.getter(history.canUndoAtom)).toBe(false)
    expect(store.getter(history.canRedoAtom)).toBe(true)

    expect(store.getter(history.stackAtom).entries).toHaveLength(1)
  })

  test('订阅者每次事务提交只收到一次通知', () => {
    const { store, history, set } = setup()
    const listener = jest.fn()
    store.sub(history.stackAtom, listener)

    history.transaction(() => {
      set('count', 1)
      set('count', 2)
      set('count', 3)
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('clear 清空栈', () => {
    const { history, set } = setup()
    history.transaction(() => set('count', 1))
    expect(history.clear()).toBe(true)
    expect(history.getState().entries).toHaveLength(0)
    expect(history.getState().cursor).toBe(0)
  })
})

describe('createHistory — 序列化与持久化(旧实现完全做不到)', () => {
  test('整个栈 JSON 往返后仍可回滚', () => {
    const { store, history, countAtom, set } = setup()
    history.transaction('第一步', () => set('count', 1))
    history.transaction('第二步', () => set('count', 2))

    const wire = JSON.stringify(history.getState())
    const revived = JSON.parse(wire) as HistoryStackState

    // 模拟新会话:全新 store + 全新 history,只拿到反序列化的数据
    const nextStore = createStore()
    const nextHistory = createHistory(nextStore)
    const nextCountAtom = atom(2)
    nextHistory.registerAtomApplier('count', () => nextCountAtom)
    expect(nextHistory.hydrate(revived)).toBe(true)

    expect(nextHistory.getState().entries).toHaveLength(2)
    expect(nextHistory.getState().entries[0].label).toBe('第一步')
    expect(nextHistory.undo()).toBe(true)
    expect(nextStore.getter(nextCountAtom)).toBe(1)
    expect(nextHistory.undo()).toBe(true)
    expect(nextStore.getter(nextCountAtom)).toBe(0)

    // 原 store 不受影响
    expect(store.getter(countAtom)).toBe(2)
  })

  test('hydrate 丢弃结构非法的条目,合法的照收', () => {
    const store = createStore()
    const history = createHistory(store)
    history.registerAtomApplier('count', () => atom(0))

    const ok: HistoryEntry = { txId: 'tx-1', ops: [{ key: 'count', before: 0, after: 1 }] }
    history.hydrate({
      entries: [
        ok,
        { txId: '', ops: [{ key: 'count', before: 0, after: 1 }] } as HistoryEntry,
        { txId: 'tx-3', ops: [] } as HistoryEntry,
        { txId: 'tx-4', ops: [{ key: '', before: 0, after: 1 }] } as HistoryEntry,
        null as unknown as HistoryEntry,
      ],
      cursor: 99,
    })

    const state = history.getState()
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].txId).toBe('tx-1')
    // 越界游标被夹到栈长
    expect(state.cursor).toBe(1)
  })

  test('persist 端口按增量收到 append / dropAfter / dropOldest / setCursor', () => {
    const calls: string[] = []
    const port: HistoryPersistPort = {
      append: (entry) => {
        calls.push(`append:${entry.txId}`)
      },
      dropOldest: (count) => {
        calls.push(`dropOldest:${count}`)
      },
      dropAfter: (cursor) => {
        calls.push(`dropAfter:${cursor}`)
      },
      setCursor: (cursor) => {
        calls.push(`setCursor:${cursor}`)
      },
      load: async () => null,
    }
    const { history, set } = setup({ cap: 2, persist: port })

    history.transaction(() => set('count', 1))
    history.transaction(() => set('count', 2))
    history.transaction(() => set('count', 3))
    history.undo()
    history.transaction(() => set('count', 40))

    // 游标在每一次移动后落盘——包括提交,不只是 undo/redo
    expect(calls).toEqual([
      'append:tx-1',
      'setCursor:1',
      'append:tx-2',
      'setCursor:2',
      'append:tx-3',
      'dropOldest:1',
      'setCursor:2',
      'setCursor:1',
      'dropAfter:1',
      'append:tx-4',
      'setCursor:2',
    ])
  })

  test('持久化失败只上报,不回滚内存状态', async () => {
    const errors: Error[] = []
    const port: HistoryPersistPort = {
      append: () => Promise.reject(new Error('indexeddb down')),
      dropOldest: () => undefined,
      dropAfter: () => undefined,
      setCursor: () => undefined,
      load: async () => null,
    }
    const { store, history, countAtom, set } = setup({
      persist: port,
      onError: (error) => errors.push(error),
    })

    history.transaction(() => set('count', 1))
    await Promise.resolve()

    expect(store.getter(countAtom)).toBe(1)
    expect(history.getState().entries).toHaveLength(1)
    expect(errors.map((error) => error.message)).toEqual(['indexeddb down'])
  })

  test('hydrate 后默认 txId 不与已恢复的重号', () => {
    const store = createStore()
    const history = createHistory(store)
    const countAtom = atom(0)
    history.registerAtomApplier('count', () => countAtom)
    history.hydrate({
      entries: [{ txId: 'tx-7', ops: [{ key: 'count', before: 0, after: 1 }] }],
      cursor: 1,
    })

    history.transaction(() => {
      store.setter(countAtom, 2)
      history.record({ key: 'count', before: 1, after: 2 })
    })

    expect(history.getState().entries[1].txId).toBe('tx-8')
  })
})

/**
 * 异步镜像端口——按 IndexedDB 的形状:每个方法都是异步的,内部自己排队。
 * core 不 await、也不串行化,所以「保证调用顺序」是适配器的责任;这个 mock
 * 就是最小的正确实现骨架。
 */
function createAsyncMirrorPort() {
  let rows: HistoryEntry[] = []
  let savedCursor = 0
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (work: () => void): Promise<void> => {
    chain = chain.then(work)
    return chain
  }

  const port: HistoryPersistPort = {
    append: (entry) =>
      enqueue(() => {
        rows = [...rows, entry]
      }),
    dropOldest: (count) =>
      enqueue(() => {
        rows = rows.slice(count)
      }),
    dropAfter: (cursor) =>
      enqueue(() => {
        rows = rows.slice(0, cursor)
      }),
    setCursor: (cursor) =>
      enqueue(() => {
        savedCursor = cursor
      }),
    load: async () => {
      await chain
      return { entries: rows, cursor: savedCursor }
    },
  }

  return { port, settled: () => chain }
}

describe('createHistory — 异步端口端到端(IndexedDB 形状)', () => {
  test('镜像在一串提交/undo/分支覆盖/cap 溢出之后与内存栈完全一致', async () => {
    const { port, settled } = createAsyncMirrorPort()
    const { history, set } = setup({ cap: 3, persist: port })

    history.transaction(() => set('count', 1))
    history.transaction(() => set('count', 2))
    history.transaction(() => set('count', 3))
    history.transaction(() => set('count', 4)) // 触发 cap 溢出
    history.undo()
    history.transaction(() => set('count', 50)) // 覆盖 redo 尾

    await settled()
    const mirror = await port.load()
    expect(mirror).toEqual(history.getState())
  })

  test('load → hydrate 跨会话恢复,undo 沿着恢复的历史继续走', async () => {
    const { port, settled } = createAsyncMirrorPort()
    const first = setup({ persist: port })
    first.history.transaction('一', () => first.set('count', 1))
    first.history.transaction('二', () => first.set('count', 2))
    await settled()

    // 新会话:全新 store / history / atom,只靠端口恢复
    const nextStore = createStore()
    const nextHistory = createHistory(nextStore, { persist: port })
    const nextCountAtom = atom(2)
    nextHistory.registerAtomApplier('count', () => nextCountAtom)

    const persisted = await port.load()
    expect(nextHistory.hydrate(persisted!)).toBe(true)
    expect(nextHistory.getState().entries.map((entry) => entry.label)).toEqual(['一', '二'])

    expect(nextHistory.undo()).toBe(true)
    expect(nextStore.getter(nextCountAtom)).toBe(1)
    expect(nextHistory.undo()).toBe(true)
    expect(nextStore.getter(nextCountAtom)).toBe(0)
  })

  test('restore() 一步完成阻塞式启动', async () => {
    const { port, settled } = createAsyncMirrorPort()
    const first = setup({ persist: port })
    first.history.transaction('一', () => first.set('count', 1))
    await settled()

    const nextStore = createStore()
    const nextHistory = createHistory(nextStore, { persist: port })
    const nextCountAtom = atom(1)
    nextHistory.registerAtomApplier('count', () => nextCountAtom)

    expect(await nextHistory.restore()).toBe(true)
    expect(nextHistory.undo()).toBe(true)
    expect(nextStore.getter(nextCountAtom)).toBe(0)
  })

  test('restore() 在 load 抛错时返回 false 并上报,不抛', async () => {
    const errors: Error[] = []
    const port: HistoryPersistPort = {
      append: () => undefined,
      dropOldest: () => undefined,
      dropAfter: () => undefined,
      setCursor: () => undefined,
      load: () => Promise.reject(new Error('idb open failed')),
    }
    const { history } = setup({ persist: port, onError: (error) => errors.push(error) })
    expect(await history.restore()).toBe(false)
    expect(errors.map((error) => error.message)).toEqual(['idb open failed'])
  })

  test('栈非空时 hydrate 被拒,防止吃掉本会话已产生的编辑', async () => {
    const errors: Error[] = []
    const { history, set } = setup({ onError: (error) => errors.push(error) })
    history.transaction(() => set('count', 1))

    const foreign: HistoryStackState = {
      entries: [{ txId: 'tx-9', ops: [{ key: 'count', before: 0, after: 5 }] }],
      cursor: 1,
    }
    expect(history.hydrate(foreign)).toBe(false)
    expect(history.getState().entries[0].txId).toBe('tx-1')
    expect(errors[0].message).toContain('栈非空')

    // 有意换一份历史:先 clear
    expect(history.clear()).toBe(true)
    expect(history.hydrate(foreign)).toBe(true)
    expect(history.getState().entries[0].txId).toBe('tx-9')
  })

  test('新会话 cap 变小:hydrate 裁剪后把镜像重写回去,不留位置漂移', async () => {
    const { port, settled } = createAsyncMirrorPort()
    const first = setup({ cap: 5, persist: port })
    for (let index = 1; index <= 4; index += 1) {
      first.history.transaction(() => first.set('count', index))
    }
    await settled()
    expect((await port.load())!.entries).toHaveLength(4)

    // 新会话把 cap 收到 2,内存只留 2 条;镜像必须跟着裁到 2 条
    const nextStore = createStore()
    const nextHistory = createHistory(nextStore, { cap: 2, persist: port })
    nextHistory.registerAtomApplier('count', () => atom(0))
    nextHistory.hydrate((await port.load())!)

    await settled()
    expect(await port.load()).toEqual(nextHistory.getState())
    expect(nextHistory.getState().entries).toHaveLength(2)
  })
})

describe('isSourceAtom', () => {
  test('只认 atom(initialValue) 造出的源子 atom', () => {
    const sourceAtom = atom(0)
    const readOnlyDerived = atom((getter) => getter(sourceAtom) + 1)
    const writableDerived = atom(
      (getter) => getter(sourceAtom),
      (_getter, setter, next: number) => setter(sourceAtom, next),
    )
    const commandAtom = atom(null, () => undefined)

    expect(isSourceAtom(sourceAtom)).toBe(true)
    expect(isSourceAtom(readOnlyDerived)).toBe(false)
    expect(isSourceAtom(writableDerived)).toBe(false)
    expect(isSourceAtom(commandAtom)).toBe(false)
  })
})
