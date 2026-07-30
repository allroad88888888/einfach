import type { ApiPackage } from './types'

export const utilsApiPackage: ApiPackage = {
  id: 'utils',
  label: 'Utils',
  packageName: '@einfach/utils',
  summary: '路径读写、浅数据操作与函数记忆化工具。',
  sections: [
    {
      title: '对象与路径操作',
      navLabel: '对象路径',
      description: '对普通数据做读取、复制、比较和不可变路径写入；它们不承担业务状态管理。',
      entries: [
        {
          name: 'easyClone',
          role: '浅克隆',
          description: '克隆数组或对象。',
          code: 'const next = easyClone(profile)',
        },
        {
          name: 'buildNewObj',
          role: '构造容器',
          description: '按输入值构造新的对象或数组容器。',
          code: "const next = buildNewObj(profile, 'name')",
        },
        {
          name: 'easyEqual',
          role: '浅比较',
          description: '比较两个值的浅层相等性。',
          code: 'if (easyEqual(previous, next)) return previous',
        },
        {
          name: 'exprPath',
          role: '路径解析',
          description: '把 NamePath 解析为 string / number 路径段。',
          code: "const path = exprPath('profile.name')",
        },
        {
          name: 'easyGet',
          role: '路径读取',
          description: '从嵌套对象按 NamePath 读取值。',
          code: "const name = easyGet(profile, 'account.name')",
        },
        {
          name: 'easySetIn',
          role: '路径写入',
          description: '返回在指定路径写入值后的新对象或数组。',
          code: "const next = easySetIn(profile, 'account.name', 'Ada')",
        },
        {
          name: 'hasObjProp',
          role: '属性检查',
          description: '检查对象自身是否拥有指定属性。',
          code: "if (hasObjProp(profile, 'name')) { /* ... */ }",
        },
        {
          name: 'easyHas',
          role: '路径检查',
          description: '检查嵌套对象是否存在指定路径。',
          code: "if (easyHas(profile, 'account.name')) { /* ... */ }",
        },
      ],
    },
    {
      title: '函数缓存',
      navLabel: '函数缓存',
      description: '为纯函数或单参数函数提供显式缓存。',
      entries: [
        {
          name: 'memoizeFn',
          role: '参数记忆化',
          description: '缓存函数按参数组合的调用结果。',
          code: 'const format = memoizeFn((name: string) => name.toUpperCase())',
        },
        {
          name: 'memoizeOneArg',
          role: '单参数记忆化',
          description: '以 WeakKey 参数缓存函数结果。',
          code: 'const getLabel = memoizeOneArg((item: object) => atom(item))',
        },
      ],
    },
    {
      title: '数据类型',
      navLabel: '数据类型',
      description: '路径工具使用的公开类型。',
      entries: [
        {
          name: 'NamePath',
          role: '路径类型',
          description: 'string、number 或它们组成的路径数组。',
          code: "const path: NamePath = ['account', 'name']",
          kind: 'type',
        },
        {
          name: 'ObjectType',
          role: '对象类型',
          description: '通用对象类型联合。',
          code: 'const data: ObjectType = { enabled: true }',
          kind: 'type',
        },
        {
          name: 'Obj',
          role: '可嵌套值类型',
          description: 'easySetIn 等工具使用的可嵌套对象或数组类型。',
          code: "const values: Obj = { profile: { name: 'Ada' } }",
          kind: 'type',
        },
        {
          name: 'GetFieldType',
          role: '路径值推导',
          description: '从对象类型和字符串路径推导字段类型。',
          code: "type Name = GetFieldType<{ profile: { name: string } }, 'profile.name'>",
          kind: 'type',
        },
      ],
    },
  ],
}
