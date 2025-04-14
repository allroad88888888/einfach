export function isEmpty(value: any): boolean {
  if (value === undefined || value === '' || value === null) {
    return true
  }
  if (Array.isArray(value) && value.length === 0) {
    return true
  }
  if (Object.prototype.toString.call(value) === '[object Object]') {
    return isEmpty(Object.keys(value))
  }
  return false
}
