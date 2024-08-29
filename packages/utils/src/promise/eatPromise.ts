export function debouncePromise<Args extends unknown[], Res = unknown>(
  fn: (...param: Args) => Promise<Res>,
  waitTime: number = 300,
): (...param: Args) => Promise<Res> {
  let timeout: NodeJS.Timeout

  const promiseRevSet = new Set<(param: Res) => void>()

  return (...param: Args) => {
    if (timeout) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => {
      fn(...param).then((res) => {
        promiseRevSet.forEach((rev) => {
          rev(res)
        })
        promiseRevSet.clear()
      })
    }, waitTime)

    return new Promise((rev) => {
      promiseRevSet.add(rev)
    })
  }
}

export function eatPromise<Args extends unknown[], Res = unknown>(
  fn: (...param: Args) => Promise<Res>,
) {
  let abort: (msg: string) => void
  let isPending = false

  return (...param: Args) => {
    if (isPending === true) {
      abort('cancel')
    }
    const abortPromise = new Promise((resolve, reject) => (abort = reject))

    isPending = true
    const resPromise = fn(...param)
      .then((res) => {
        isPending = false
        return res
      })
      .finally(() => {
        isPending = false
      })
    return Promise.race([resPromise, abortPromise])
  }
}
