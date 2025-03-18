import { defineConfig } from 'rollup'
import resolve from '@rollup/plugin-node-resolve'
import swc from '@rollup/plugin-swc'
import terser from '@rollup/plugin-terser'
import commonjs from '@rollup/plugin-commonjs'

/** @type {import('rollup').RollupOptions} */
const config = defineConfig({
  input: './src/index.ts',
  plugins: [
    resolve({
      extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
    }),
    commonjs(),
    // terser(),
    swc({
      swc: {
        minify: true,
        jsc: {
          target: 'es2019',
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
  external: ['react', 'react-dom', 'lodash', '@deepfos/hooks'],
  output: [
    {
      format: 'esm',
      file: './dist/index.mjs',
    },
    {
      format: 'commonjs',
      file: './dist/index.cjs',
    },
  ],
})

export default config
