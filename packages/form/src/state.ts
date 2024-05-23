import { atom } from 'einfach-state'
import type { Obj } from 'einfach-utils'

export const valuesAtom = atom<Obj>({})

export const messageAtom = atom(new Set())
