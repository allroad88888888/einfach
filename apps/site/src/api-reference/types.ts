export type ApiPackageId =
  | 'core'
  | 'react'
  | 'solid'
  | 'react-form'
  | 'solid-form'
  | 'utils'
  | 'react-utils'

export type ApiEntry = {
  name: string
  role: string
  description: string
  code: string
  kind?: 'type'
}

export type ApiSection = {
  title: string
  navLabel: string
  description: string
  entries: readonly ApiEntry[]
}

export type ApiPackage = {
  id: ApiPackageId
  label: string
  packageName: string
  summary: string
  sections: readonly ApiSection[]
  reexportsCore?: boolean
}
