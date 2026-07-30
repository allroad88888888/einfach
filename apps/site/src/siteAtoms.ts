import { atom, loadable } from '@einfach/react'
import type { ApiPackageId } from './api-reference'

export const selectedApiPackageAtom = atom<ApiPackageId>('react')
export const counterAtom = atom(3)
export const doubledCounterAtom = atom((get) => get(counterAtom) * 2)

export type AsyncDemoMode = 'success' | 'error'

type AsyncPreviewRequest = {
  mode: AsyncDemoMode
  version: number
}

export const asyncPreviewRequestAtom = atom<AsyncPreviewRequest>({
  mode: 'success',
  version: 0,
})

function waitForPreview(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const timeoutId = window.setTimeout(resolve, 800)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeoutId)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export const profileSummaryAtom = atom(async (getter, { signal }) => {
  const request = getter(asyncPreviewRequestAtom)
  await waitForPreview(signal)

  if (request.mode === 'error') {
    throw new Error('请求被服务端拒绝：请检查权限或重试。')
  }

  return {
    name: 'Derived state profile',
    version: request.version,
  }
})

export const profileSummaryViewAtom = loadable(profileSummaryAtom)

export const runAsyncPreviewAtom = atom(null, (getter, setter, mode: AsyncDemoMode) => {
  const current = getter(asyncPreviewRequestAtom)
  setter(asyncPreviewRequestAtom, {
    mode,
    version: current.version + 1,
  })
})
