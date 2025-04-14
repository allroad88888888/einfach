import { useRef } from 'react'

export function useOnce<T>(fn: () => T) {
  const { current } = useRef<{
    initialized: boolean
    obj: undefined | T
  }>({
    initialized: false,
    obj: undefined,
  })
  if (current.initialized === false) {
    current.obj = fn()
    current.initialized = true
  }
  return current.obj
}
