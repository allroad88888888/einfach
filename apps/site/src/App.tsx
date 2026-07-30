import { apiPackages } from './api-reference'
import { ApiPackageReferencePage } from './components/ApiPackageReferencePage'
import { ApiReferenceDirectoryPage } from './components/ApiReferenceDirectoryPage'
import { HomePage } from './HomePage'

function isApiDirectoryPath(pathname: string) {
  return pathname.replace(/\/+$/, '').endsWith('/api')
}

function findApiPackage(pathname: string) {
  const match = pathname.replace(/\/+$/, '').match(/\/api\/([^/]+)$/)
  return match ? apiPackages.find((apiPackage) => apiPackage.id === match[1]) : undefined
}

export function App() {
  const apiPackage = findApiPackage(window.location.pathname)

  if (apiPackage) return <ApiPackageReferencePage apiPackage={apiPackage} />
  if (isApiDirectoryPath(window.location.pathname)) return <ApiReferenceDirectoryPage />

  return <HomePage />
}
