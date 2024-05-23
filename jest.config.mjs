import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(`${process.cwd()}/.swcrc`, 'utf-8'))

/** @type {import('jest').Config} */
const jestConfig = {
  transform: {
    '^.+\\.(t|j)sx?$': ['@swc/jest', { ...config }],
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  setupFilesAfterEnv: ['<rootDir>/rules/setup-jest.ts'],
  testEnvironment: 'jsdom',
}
export default jestConfig
