import { createContinuablePromise } from './promise';
import { isContinuablePromise, isPromiseLike } from './promiseUtils';
import type { AtomAbstract, AtomEntity, Setter, Store, WritableAtom } from './type';
import type { ReturnState, StatesWithPromise } from './typePromise';



let keyCount = 0;
export function createStore(): Store {
  let atomStateMap = new WeakMap<AtomAbstract, unknown>();

  const listenersMap = new WeakMap<AtomAbstract, Set<() => void>>();
  // [atom1,[atom2 ,atom3]]
  const backDependenciesMap = new WeakMap<AtomAbstract, Set<AtomAbstract>>();
  // [atom2 ,[atom1]]  用来判断是否 强制读取数据
  const dependenciesUpdateMap = new WeakMap<AtomAbstract, true>();

  function readAtom<State, Entity extends AtomAbstract = AtomEntity<State>>(atomEntity: Entity)
    : ReturnState<State> {

    const force = dependenciesUpdateMap.has(atomEntity);
    if (force === false && atomStateMap.has(atomEntity)) {
      return atomStateMap.get(atomEntity) as ReturnState<State>;
    }

    let nextState = atomEntity.read;
    const controller = new AbortController();
    if (typeof nextState === 'function') {

      function getter<T, T2 extends AtomAbstract = AtomEntity<T>>(atom: T2) {
        if (!backDependenciesMap.has(atom)) {
          backDependenciesMap.set(atom, new Set());
        }
        backDependenciesMap.get(atom)!.add(atomEntity);
        return readAtom(atom);
      }

      nextState = (atomEntity).read(getter, controller);
    }
    dependenciesUpdateMap.delete(atomEntity);


    // return nextState
    return setAtomState(atomEntity, nextState, () => {
      return controller.abort();
    });
  }

  function setAtom<State, Args extends unknown[], Result>(this: AtomAbstract,
    atomEntity: WritableAtom<State, Args, Result>, ...arg: Args[]): Result {
    if (Object.is(this, atomEntity)) {
      setAtomState(atomEntity, arg[0]);
      return undefined as Result;
    }
    return atomEntity.write(readAtom, setAtom.bind(atomEntity) as Setter, ...arg as Args);
  }

  function setAtomState<State, Entity extends AtomAbstract = AtomEntity<State>>(
    this: any,
    atomEntity: Entity,
    state: State,
    abortPromise: () => void = () => { },
  ) {
    if (process.env.NODE_ENV !== 'production') {
      Object.freeze(state);
    }
    let nextState: StatesWithPromise<State> | State = state;

    const prevState = atomStateMap.get(atomEntity);
    if (isPromiseLike(nextState)) {
      nextState = createContinuablePromise(nextState, abortPromise, () => {
        triggerSubScriptionAndDependency.call(atomEntity, atomEntity);
      });
      if (isContinuablePromise(prevState)) {
        prevState.CONTINUE_PROMISE?.(nextState as StatesWithPromise<State>, abortPromise);
      }
    }

    atomStateMap.set(atomEntity, nextState);
    triggerSubScriptionAndDependency.call(this, atomEntity);
    return nextState;
  }


  function triggerSubScriptionAndDependency<Entity extends AtomAbstract>(this: Entity,
    atomEntity: Entity) {
    /**
     * 触发订阅atom状态的方法
     */
    publishAtom(atomEntity);
    function iteratorPush(backAtomEntity: AtomAbstract) {
      const backEntitySet = backDependenciesMap.get(backAtomEntity)! || [];
      backEntitySet.forEach((backEntity) => {
        dependenciesUpdateMap.set(backEntity, true);
        publishAtom(backEntity);
      });

      backEntitySet.forEach((backEntity) => {
        iteratorPush(backEntity);
      });
    }
    /**
     * 触发衍生态的atom订阅方法
     */
    iteratorPush(atomEntity);
  }


  function publishAtom<State, Entity extends AtomAbstract = AtomEntity<State>>(atomEntity: Entity) {
    const listenerSet = listenersMap.get(atomEntity);
    if (listenerSet) {
      listenerSet.forEach((listener) => {
        listener();
      });
    }
  }

  function subscribeAtom<State, Entity extends AtomAbstract = AtomEntity<State>>(
    atomEntity: Entity, listener: () => void) {

    if (!listenersMap.has(atomEntity)) {
      listenersMap.set(atomEntity, new Set());
    }
    (listenersMap.get(atomEntity)!).add(listener);

    return () => {
      (listenersMap.get(atomEntity)!).delete(listener);
    };
  }
  const key = `store${++keyCount}`;

  function resetAtom<State, Entity extends AtomAbstract = AtomEntity<State>>(atomEntity?: Entity) {
    if (atomEntity) {
      atomStateMap.delete(atomEntity);
    } else {
      atomStateMap = new WeakMap();
    }
  }
  return {
    sub: subscribeAtom,
    getter: readAtom,
    setter: setAtom as Setter,
    toString: () => key,
    resetAtom,
  };
}
