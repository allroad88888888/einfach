import { describe, expect, it } from '@jest/globals'
import { atom, createStore, selectAtom } from '@einfach/core'

interface Pagination {
  pageSize: number
  currentPage: number
  total: number
}

describe('select', () => {
  it(
    'base',
    async () => {
      const paginationAtom = atom(
        {
          pageSize: 20,
          currentPage: 1,
          total: 0,
        },
        (getter, setter, nextPagination: Pagination) => {
          getter(paginationAtom)
          const { total, pageSize, currentPage } = nextPagination
          const maxPage = Math.ceil(total / pageSize) || 1
          const fixPage = currentPage < 1 ? 1 : currentPage > maxPage ? maxPage : currentPage
          setter(paginationAtom, {
            ...nextPagination,
            currentPage: fixPage,
          })
        },
      )
      const queryAtom = selectAtom(
        paginationAtom,
        (current) => {
          return {
            pageSize: current.pageSize,
            currentPage: current.currentPage,
          }
        },
        (prev, next) => {
          return prev.pageSize === next.pageSize && prev.currentPage === next.currentPage
        },
      )

      const store = createStore()
      const query = store.getter(queryAtom)

      store.setter(paginationAtom, {
        pageSize: 20,
        currentPage: 1,
        total: 100,
      })

      const query2 = store.getter(queryAtom)
      store.setter(paginationAtom, {
        pageSize: 20,
        currentPage: 100,
        total: 100,
      })

      const query3 = store.getter(queryAtom)
      expect(query).toBe(query2)
      expect(query3).toStrictEqual({
        currentPage: 5,
        pageSize: 20,
      })
    },
    1000 * 50 * 50,
  )
})
