import { defineConfig } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import swc from '@rollup/plugin-swc'
import path, { dirname } from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import yaml from 'js-yaml'
import { babel } from '@rollup/plugin-babel'

const workspaceConfig = yaml.load(readFileSync('./pnpm-workspace.yaml', 'utf8'))
const topLevelDirs = workspaceConfig.packages.map((pattern) => pattern.replace('/**', ''))

// 获取所有子目录
const products = topLevelDirs.reduce((acc, dir) => {
  const subDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => `${dir}/${dirent.name}`)
  return [...acc, ...subDirs]
}, [])

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
    '@einfach/solid',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'solid-js',
    'solid-js/web',
    'solid-js/store',
  ],
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
    unknownGlobalSideEffects: false,
  },

  plugins: [],
})

/** @type {import('rollup').RollupOptions} */
export default products.map((dir) => {
  /** @type {import('rollup').RollupOptions} */
  const isSolidPackage = dir.includes('solid')

  // 为solid包使用babel，其他包使用swc
  const pluginsConfig = isSolidPackage
    ? [
        resolve({
          extensions: ['.ts', '.tsx'],
        }),
        babel({
          babelHelpers: 'bundled',
          extensions: ['.ts', '.jsx', '.tsx'],
          presets: [
            [
              '@babel/preset-env',
              {
                targets: { node: 'current' },
                modules: false,
              },
            ],
            ['@babel/preset-typescript', { isTsx: true, allowDeclareFields: true }],
          ],
          plugins: [
            [
              'babel-plugin-jsx-dom-expressions',
              {
                moduleName: 'solid-js/web',
                builtIns: ['createElement', 'spread', 'insert', 'createComponent'],
                contextToCustomElements: true,
                wrapConditionals: true,
              },
            ],
          ],
        }),
      ]
    : [
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
      ]

  return {
    ...config,
    input: `${dir}/src/index.ts`,
    // treeshake: false,
    plugins: pluginsConfig,
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
      },
      {
        format: 'es',
        dir: `${dir}/dist`,
        entryFileNames: '[name].mjs',
      },
    ],
  }
})
