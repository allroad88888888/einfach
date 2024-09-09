import type { NamePath } from '../type'

export function namePathToStr(namePath: NamePath) {
  return namePath
  // if (Array.isArray(namePath)) {
  //   return namePath
  //     .map((field) => {
  //       return typeof field === 'number' ? `[${field}]` : `.${field}`
  //     })
  //     .join('')
  // }
  // return namePath
}
