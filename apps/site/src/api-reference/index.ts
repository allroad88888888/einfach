import { coreRuntimeSections } from './coreRuntime'
import { coreTypeSections } from './coreTypes'
import { reactApiPackage } from './react'
import { reactFormApiPackage } from './reactForm'
import { reactUtilsApiPackage } from './reactUtils'
import { solidApiPackage } from './solid'
import { solidFormApiPackage } from './solidForm'
import type { ApiPackage } from './types'
import { utilsApiPackage } from './utils'

export type { ApiEntry, ApiPackage, ApiPackageId, ApiSection } from './types'

const coreApiPackage: ApiPackage = {
  id: 'core',
  label: 'Core',
  packageName: '@einfach/core',
  summary: '框架无关的 atom、store、异步衍生与组合工具。',
  sections: [...coreRuntimeSections, ...coreTypeSections],
}

export const apiPackages: readonly ApiPackage[] = [
  coreApiPackage,
  reactApiPackage,
  solidApiPackage,
  reactFormApiPackage,
  solidFormApiPackage,
  utilsApiPackage,
  reactUtilsApiPackage,
]
