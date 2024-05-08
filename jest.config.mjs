import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(`${process.cwd()}/.swcrc`, 'utf-8'))

export default {
  transform: {
    '^.+\\.(t|j)sx?$': ['@swc/jest', { ...config }],
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
}
