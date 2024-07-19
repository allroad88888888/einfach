import tsEslint from 'typescript-eslint'
import reactHookEsLint from 'eslint-plugin-react-hooks'
import stylistic from "@stylistic/eslint-plugin"
// import importEslint from 'eslint-plugin-import'

export default [
  {

    files: ['**/*.ts', '**/*.tsx', '**/src/typing.d.ts'],
    ignores: ['**/*.d.ts', '**/node_modules/', '**/.git/', '**/*.js', '**/*.mjs', '**/*.jsx', '**/*.less', '**/*.scss', '**/*.css'],
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
      // tsEslint,
      'react-hooks': reactHookEsLint,
      // importEslint,
      "@stylistic": stylistic
    },
    // plugins: ["@stylistic"],
    rules: {
      "@stylistic/brace-style": [
        "error",
        "1tbs",
        {
          "allowSingleLine": true
        }
      ],
      "@stylistic/comma-dangle": [
        "error",
        {
          "arrays": "always-multiline",
          "objects": "always-multiline",
          "imports": "always-multiline",
          "exports": "always-multiline",
          "functions": "always-multiline",
          "enums": "always-multiline",
          "generics": "always-multiline",
          "tuples": "always-multiline"
        }
      ],
      "@stylistic/comma-spacing": [
        "error",
        {
          "before": false,
          "after": true
        }
      ],
      "@stylistic/function-call-spacing": [
        "error",
        "never"
      ],
      // "@stylistic/indent": [
      //   "error",
      //   2,
      //   {
      //     "SwitchCase": 1,
      //     "VariableDeclarator": 1,
      //     "outerIIFEBody": 1,
      //     "FunctionDeclaration": {
      //       "parameters": 1,
      //       "body": 1
      //     },
      //     "FunctionExpression": {
      //       "parameters": 1,
      //       "body": 1
      //     },
      //     "CallExpression": {
      //       "arguments": 1
      //     },
      //     "ArrayExpression": 1,
      //     "ObjectExpression": 1,
      //     "ImportDeclaration": 1,
      //     "flatTernaryExpressions": false,
      //     "ignoredNodes": [
      //       "JSXElement",
      //       "JSXElement > *",
      //       "JSXAttribute",
      //       "JSXIdentifier",
      //       "JSXNamespacedName",
      //       "JSXMemberExpression",
      //       "JSXSpreadAttribute",
      //       "JSXExpressionContainer",
      //       "JSXOpeningElement",
      //       "JSXClosingElement",
      //       "JSXFragment",
      //       "JSXOpeningFragment",
      //       "JSXClosingFragment",
      //       "JSXText",
      //       "JSXEmptyExpression",
      //       "JSXSpreadChild"
      //     ],
      //     "ignoreComments": false
      //   }
      // ],
      "@stylistic/keyword-spacing": [
        "error",
        {
          "before": true,
          "after": true,
          "overrides": {
            "return": {
              "after": true
            },
            "throw": {
              "after": true
            },
            "case": {
              "after": true
            }
          }
        }
      ],
      "@stylistic/lines-between-class-members": [
        "error",
        "always",
        {
          "exceptAfterSingleLine": false
        }
      ],
      "@stylistic/no-extra-parens": [
        "off",
        "all",
        {
          "conditionalAssign": true,
          "nestedBinaryExpressions": false,
          "returnAssign": false,
          "ignoreJSX": "all",
          "enforceForArrowConditionals": false
        }
      ],
      "@stylistic/no-extra-semi": "error",
      "@stylistic/space-before-blocks": "error",
      "@stylistic/quotes": [
        "error",
        "single",
        {
          "avoidEscape": true
        }
      ],
      "@stylistic/semi": [
        "error",
        "always"
      ],
      "@stylistic/space-before-function-paren": [
        "error",
        {
          "anonymous": "always",
          "named": "never",
          "asyncArrow": "always"
        }
      ],
      "@stylistic/space-infix-ops": "error",
      "@stylistic/object-curly-spacing": [
        "error",
        "always"
      ],
      "camelcase": "off",
      "@stylistic/naming-convention": [
        "error",
        {
          "selector": "variable",
          "format": [
            "camelCase",
            "PascalCase",
            "UPPER_CASE"
          ]
        },
        {
          "selector": "function",
          "format": [
            "camelCase",
            "PascalCase"
          ]
        },
        {
          "selector": "typeLike",
          "format": [
            "PascalCase"
          ]
        }
      ],
      "@stylistic/default-param-last": "error",
      // "@stylistic/dot-notation": [
      //   "error",
      //   {
      //     "allowKeywords": true
      //   }
      // ],
      "@stylistic/no-array-constructor": "error",
      "@stylistic/no-dupe-class-members": "error",
      "@stylistic/no-empty-function": [
        "error",
        {
          "allow": [
            "arrowFunctions",
            "functions",
            "methods"
          ]
        }
      ],
      "no-new-func": "off",
      // "@stylistic/no-implied-eval": "error",
      "@stylistic/no-loss-of-precision": "error",
      "@stylistic/no-loop-func": "error",
      "@stylistic/no-magic-numbers": [
        "off",
        {
          "ignore": [],
          "ignoreArrayIndexes": true,
          "enforceConst": true,
          "detectObjects": false
        }
      ],
      "@stylistic/no-redeclare": "error",
      "@stylistic/no-shadow": "error",
      // "@stylistic/no-throw-literal": "error",
      "@stylistic/no-unused-expressions": [
        "error",
        {
          "allowShortCircuit": false,
          "allowTernary": false,
          "allowTaggedTemplates": false
        }
      ],
      "@stylistic/no-unused-vars": [
        "error",
        {
          "vars": "all",
          "args": "after-used",
          "ignoreRestSiblings": true
        }
      ],
      "@stylistic/no-use-before-define": [
        "error",
        {
          "functions": false,
          "classes": true,
          "variables": true
        }
      ],
      "@stylistic/no-useless-constructor": "error",
      "@stylistic/require-await": "off",
      // "no-return-await": "off",
      "@stylistic/return-await": [
        "error",
        "in-try-catch"
      ],
      "@stylistic/max-len": [
        "error",
        {
          "code": 100,
          "ignoreUrls": true,
          "ignoreComments": true,
          "ignoreRegExpLiterals": true,
          "ignoreTrailingComments": true,
          "ignoreStrings": true,
          "ignoreTemplateLiterals": true,
        }
      ],
      // support any
      "@stylistic/no-explicit-any": "off",
      // support ts-ignore
      "@stylistic/ban-ts-comment": "off",
      // 
      "@stylistic/no-this-alias": "off",
      // type Function
      "@stylistic/ban-types": "off",
      "strict": [
        "error",
        "never"
      ],
      "max-len": [
        "error",
        {
          "code": 100,
        },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "max-lines-per-function": [
        2,
        {
          "max": 320,
          "skipComments": true,
          "skipBlankLines": true
        }
      ],
      "no-console": 2,
      "prefer-const": 2,
      //导出默认值
      "import/prefer-default-export": 0,
      "import/no-cycle": 0,
      "import/no-extraneous-dependencies": 1,
      "import/no-named-as-default": 0,
      "arrow-body-style": 0,
      "no-underscore-dangle": 0,
      "@stylistic/consistent-type-imports": [
        "error",
        {
          "prefer": "type-imports"
        }
      ],
      "@stylistic/no-non-null-asserted-optional-chain": "off",
      "react/no-children-prop": "off"
    },
  },
]
