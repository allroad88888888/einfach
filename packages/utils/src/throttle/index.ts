export function throttle<T>(
  fn: (...arg: any[]) => T,
  wait: number,
  options?: {
    leading: boolean
  },
) {
  let timer: any = null
  let isLeading = false
  const { leading = true } = options || {}

  return function (this: any, ...args: any[]) {
    if (!timer) {
      if (leading === true && isLeading === false) {
        fn.apply(this, args)
      }
      isLeading = true
      timer = setTimeout(() => {
        timer = null
        fn.apply(this, args)
        setTimeout(() => {
          isLeading = false
        })
      }, wait)
    }
  }
}
