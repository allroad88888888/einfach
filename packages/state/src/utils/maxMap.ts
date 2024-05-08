export class MaxMap<K, V> {
  private list: Map<K, V>[] = []
  private maxSize: number = 5000
  private currentIndex: number = 0
  private currentSize: number = 0

  constructor({ maxSize = 5000 }: { maxSize: number } = { maxSize: 5000 }) {
    this.maxSize = maxSize
    this.clear()
  }

  set(key: K, value: V) {
    ++this.currentSize
    if (this.currentSize > this.maxSize) {
      this.currentSize = 0
      this.list.push(new Map())
      ++this.currentIndex
    }
    const weakMap = this.list[this.currentIndex]
    return weakMap.set(key, value)
  }

  private getIndex(key: K) {
    return this.list.findIndex((map) => {
      return map.has(key)
    })
  }

  has(key: K) {
    const index = this.getIndex(key)
    return index !== -1
  }

  get(key: K) {
    const index = this.getIndex(key)
    if (index === -1) {
      return undefined
    }
    return this.list[index].get(key)
  }

  delete(key: K) {
    const index = this.list.findIndex((weakMap) => {
      return weakMap.has(key)
    })
    if (index > -1) {
      this.list[index].delete(key)
    }
  }

  size() {
    let size: number = 0
    this.list.forEach((map) => {
      size += map.size
    })
    return size
  }

  clear() {
    this.list = [new Map()]
    this.currentIndex = 0
    this.currentSize = 0
  }
}
