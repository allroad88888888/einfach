import tsEslint from 'typescript-eslint'
import reactHookEsLint from 'eslint-plugin-react-hooks'
import importEslint from 'eslint-plugin-import'
// import react from 'eslint-plugin-react'

import stylistic from '@stylistic/eslint-plugin'

export default [
  ...tsEslint.configs.recommended.map((config) => {
    return {
      ...config,
      files: ['**/*.ts', '**/*.tsx'],
      ignores: ['**/*.d.ts'],
    }
  }),
  {
    ...stylistic.configs.customize({
      indent: 2,
      quotes: 'single',
      semi: false,
      jsx: true,
    }), files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    ignores: ['**/*.d.ts'],
  },
  {

    files: ['**/*.ts', '**/*.tsx', '**/src/typing.d.ts'],
    ignores: ['**/*.d.ts', '**/node_modules/', '**/.git/', '**/*.js', '**/*.mjs', '**/*.jsx', '**/*.less', '**/*.scss', '**/*.css'],
    // ignores: ['**/*.d.ts', '**/node_modules/', '.git/', '*.js', '*.mjs', '*.jsx', '*.less', '*.scss', '*.css'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'react-hooks': reactHookEsLint,
      importEslint,
    },
    rules: {
      'no-console': 'error',
      '@stylistic/indent': ['error', 2],
      '@stylistic/max-len': ['error', {
        code: 100,
        ignoreUrls: true,
        ignoreComments: true,
        ignoreRegExpLiterals: true,
        ignoreTrailingComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
      }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
]
