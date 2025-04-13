import { useReRef } from './useReRef'

/**
 * 防抖 节流 用这玩意封装一下
 * @param fn
 * @param formatFn
 * @returns
 */
export function useDepAndFormateFn<T extends (...args: any) => any, T1 extends (param: T) => any>(
  fn: T,
  formatFn: T1,
) {
  const { current } = useReRef<{
    fnDep: T
    formatResFn: T
  }>({})
  if (current?.fnDep !== fn) {
    current.fnDep = fn
    current.formatResFn = formatFn(fn)
  }

  return current.formatResFn
}
