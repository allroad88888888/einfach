export function getLength(value: any): number {
  if (typeof value === 'string') {
    return value.length
  }
  if (typeof value === 'number') {
    return value.toString().length
  }
  if (typeof value === 'object') {
    const type = Object.prototype.toString.call(value)
    if (type === '[object Set]') {
      return (value as Set<any>).size
    }
    if (type === '[object Map]') {
      return (value as Map<any, any>).size
    }
    if (type === '[object Array]') {
      return (value as any[]).length
    }
  }
  return 0
}
