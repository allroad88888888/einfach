const homeNavigation = [
  { href: '#async', label: '异步衍生' },
  { href: '#principles', label: '核心模型' },
  { href: '#ai', label: 'AI 可读模型' },
  { href: '#demo', label: '交互演示' },
]

type HeaderProps = {
  apiReference?: boolean
  apiPackage?: boolean
}

export function Header({ apiReference = false, apiPackage = false }: HeaderProps) {
  const isApiPage = apiReference || apiPackage
  const homePrefix = apiPackage ? '../..' : '..'
  const navigation = isApiPage
    ? [
        ...homeNavigation.map((item) => ({ ...item, href: `${homePrefix}${item.href}` })),
        apiPackage ? { href: '../', label: 'API 目录' } : { href: '#api-top', label: 'API 参考' },
      ]
    : [...homeNavigation, { href: './api/', label: 'API 参考' }]

  return (
    <header className="site-header">
      <a className="brand" href={isApiPage ? homePrefix : '#top'} aria-label="Einfach 首页">
        <span className="brand-mark">E</span>
        <span>einfach</span>
      </a>
      <nav aria-label="页面导航">
        {navigation.map((item) => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
      <a className="header-github" href="https://github.com/allroad88888888/einfach">
        GitHub ↗
      </a>
    </header>
  )
}
