import { useRef } from 'react'

export function useReRef<T extends Record<string, any>>(props: Partial<T>) {
  return useRef(props) as {
    current: T
  }
}
