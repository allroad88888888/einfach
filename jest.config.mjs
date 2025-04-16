import fs from 'node:fs'
//  typescript转js配置（采用swc包转）
const config = JSON.parse(fs.readFileSync(`${process.cwd()}/.swcrc`, 'utf-8'))

// 引入一份ts类型，对标typescript开发体验
/** @type {import('jest').Config} */
const jestConfig = {
  // 转译配置
  transform: {
    // 为 Solid.js 的 TSX 文件使用特定的 Babel 配置
    'solid/.*\\.tsx$': ['babel-jest'],
    // 其他文件保持现有的 SWC 配置
    '^(?!solid/).*\\.(t|j)sx?$': ['@swc/jest', { ...config }],
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  /**
   * 运行每个测试文件之前-执行这个路径里面的内容。
   * 这里用来配置@testing-library/jest-dom，
   * 并加载其api-typescript类型补充
   */
  setupFilesAfterEnv: ['<rootDir>/rules/setup-jest.ts'],
  /**
   * 单测里面，如需要使用到dom，这里需设置为jsdom
   */
  testEnvironment: 'jsdom',

  /**
   * 模块名称映射，用于解析 @einfach/core 和 @einfach/react 包
   */
  moduleNameMapper: {
    '^@einfach/core$': '<rootDir>/vanilla/core/src',
    '^@einfach/utils$': '<rootDir>/vanilla/utils/src',
    '^@einfach/react$': '<rootDir>/react/react/src',
    '^@einfach/react-utils$': '<rootDir>/react/utils/src',
    '^@einfach/react-form$': '<rootDir>/react/form/src',
    '^@einfach/solid$': '<rootDir>/solid/solid/src',
    '^@einfach/solid-form$': '<rootDir>/solid/form/src',
  },
}
export default jestConfig
