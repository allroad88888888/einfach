import { useReducer } from 'react'

export function useDoRender() {
  const [, doRender] = useReducer((val: number) => {
    return val + 1
  }, 0)
  return doRender
}
