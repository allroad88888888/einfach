export interface PubAndSub<T extends Array<any>> {
  eventMap: WeakMap<PubAndSubEntity, Set<(...arg: T) => void>>
  subscribe: (key: PubAndSubEntity, fn: (...arg: T) => void) => void
  publish: (key: PubAndSubEntity, ...arg: T) => void
  unSubscribe: (key: PubAndSubEntity, fn: (...arg: T) => void) => void
}

export class PubSub<T extends Array<any>> implements PubAndSub<T> {
  eventMap = new WeakMap<PubAndSubEntity, Set<(...arg: T) => void>>()

  subscribe(key: PubAndSubEntity, fn: (...arg: T) => void) {
    if (!this.eventMap.has(key)) {
      this.eventMap.set(key, new Set<any>())
    }
    this.eventMap.get(key)?.add(fn)
  }

  publish(key: PubAndSubEntity, ...arg: T) {
    this.eventMap.get(key)?.forEach((value) => {
      value(...arg)
    })
  }

  unSubscribe(key: PubAndSubEntity, fn?: (...arg: T) => void) {
    if (!this.eventMap.has(key)) {
      return
    }
    if (!fn) {
      this.eventMap.delete(key)
    } else {
      this.eventMap.get(key)?.delete(fn)
    }
  }
}

export interface PubAndSubEntity {
  toString: () => string
}

let key = 0
export function buildPubAndSubKey(): PubAndSubEntity {
  key += 0
  return {
    toString: () => {
      return `key:${key}`
    },
  }
}

export function buildPubAndSubGroup() {
  let cache = new WeakMap<PubAndSubEntity, PubAndSub<any>>()
  return {
    store: cache,
    get<T extends Array<any>>(entity: PubAndSubEntity) {
      if (!cache.has(entity)) {
        cache.set(entity, new PubSub())
      }
      return cache.get(entity) as PubAndSub<T>
    },
    destroy(entity?: PubAndSubEntity) {
      if (!entity) {
        cache = new WeakMap()
        return
      }
      cache.delete(entity)
    },
  }
}
