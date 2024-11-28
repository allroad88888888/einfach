import { defineConfig } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import swc from '@rollup/plugin-swc'

const products = ['packages/state', 'packages/utils', 'packages/form']

/** @type {import('rollup').RollupOptions} */
const config = defineConfig({
  external: [
    '@swc/core',
    'einfach-state',
    'einfach-utils',
    'einfach-form',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
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
        entryFileNames: '[name].js',
        preserveModules: true, // 保留模块结构
        preserveModulesRoot: 'src', // 去掉 src 的根路径
      },
      {
        format: 'es',
        dir: `${dir}/esm`,
        entryFileNames: '[name].mjs',
        preserveModules: true, // 保留模块结构
        // preserveModulesRoot: 'src', // 去掉 src 的根路径
      },
    ],
  }
})
