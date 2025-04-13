import { defineConfig } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import swc from '@rollup/plugin-swc'
import terser from '@rollup/plugin-terser'
import path, { dirname } from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const products = ['packages/core', 'packages/react', 'packages/utils', 'packages/form']

const filename = fileURLToPath(import.meta.url)
const dirName = dirname(filename)

const outputDirList = ['esm', 'cjs', 'dist']
products.forEach((pName) => {
  outputDirList.forEach((output) => {
    const outputDir = path.resolve(dirName, pName, output)
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })
})

/** @type {import('rollup').RollupOptions} */
const config = defineConfig({
  external: [
    '@swc/core',
    '@einfach/core',
    '@einfach/react',
    '@einfach/utils',
    'einfach-form',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@deepfos/hooks',
  ],

  plugins: [
    resolve({
      extensions: ['.ts', '.tsx'],
    }),
    swc({
      swc: {
        minify: false,
        jsc: {
          target: 'esnext',
          parser: {
            tsx: true,
            syntax: 'typescript',
          },
          transform: {
            react: {
              runtime: 'automatic',
            },
          },
        },
      },
    }),
  ],
})

/** @type {import('rollup').RollupOptions} */
export default products.map((dir) => {
  /** @type {import('rollup').RollupOptions} */
  return {
    ...config,
    input: `${dir}/src/index.ts`,
    // treeshake: false,
    output: [
      {
        format: 'commonjs',
        dir: `${dir}/cjs`,
        entryFileNames: '[name].cjs',
        preserveModules: true, // 保留模块结构
        preserveModulesRoot: 'src', // 去掉 src 的根路径
      },
      {
        format: 'es',
        dir: `${dir}/esm`,
        entryFileNames: '[name].mjs',
        preserveModules: true, // 保留模块结构
        preserveModulesRoot: 'src', // 去掉 src 的根路径
      },
      {
        format: 'commonjs',
        dir: `${dir}/dist`,
        entryFileNames: '[name].js',
        plugins: [terser()],
      },
    ],
  }
})
