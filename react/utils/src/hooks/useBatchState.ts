import type { ReactNode } from 'react'
import React, { useCallback, useLayoutEffect, useReducer, useRef } from 'react'
import { flushSync, createPortal } from 'react-dom'

export function useBatchState() {
  return flushSync
}

export const useBatchEffectState = () => {
  const [renderNum, doRender] = useReducer((val: number) => {
    return val + 1
  }, 0)
  const cbRef = useRef<() => void>()

  const batchState = useCallback((cb: () => void) => {
    cbRef.current = cb
    doRender()
  }, [])

  useLayoutEffect(() => {
    if (cbRef.current) {
      cbRef.current()
    }
  }, [renderNum])

  return batchState
}

interface Props {
  cb: (fn: () => void) => void
  fn: () => void
  click: () => void
  init: boolean
  vDom: HTMLDivElement | null
}

export function useBatchClickState() {
  const ref = useRef<HTMLDivElement>(null)
  const { current } = useRef<Props>({
    init: false,
  } as Props)
  if (!current.init) {
    current.init = true
    current.click = () => {
      if (current.fn) {
        current.fn()
      }
    }
    current.cb = (fn: () => void) => {
      current.fn = fn
      if (ref.current) {
        ref.current.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }
    }
  }

  return {
    cb: current.cb,
    vDom: createPortal(
      React.createElement('div', {
        ref,
        style: {
          visibility: 'hidden',
          position: 'absolute',
          bottom: '-100px',
        },
        onClick: current.click,
      }),
      document.body,
    ) as ReactNode,
  }
}
