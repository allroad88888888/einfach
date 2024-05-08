module.exports = {
  extends: [
    'stylelint-config-standard',
    'stylelint-config-css-modules',
    'stylelint-config-rational-order',
  ],
  plugins: ['stylelint-declaration-block-no-ignored-properties'],
  customSyntax: 'postcss-less',
  ignoreFiles: ['**/*.js', '**/*.jsx', '**/*.tsx', '**/*.ts'],
  rules: {
    'declaration-colon-newline-after': null,
    'string-quotes': 'single',
    'selector-class-pattern': '^[A-Za-z0-9-]+$',
    'no-descending-specificity': null,
    'function-url-quotes': 'always',
    'selector-attribute-quotes': 'always',
    'font-family-no-missing-generic-family-keyword': null, // iconfont
    'plugin/declaration-block-no-ignored-properties': true,
    'unit-no-unknown': [true, { ignoreUnits: ['rpx'] }],
    // webcomponent
    'selector-type-no-unknown': null,
    'function-no-unknown': null,
    'value-keyword-case': ['lower', { ignoreProperties: ['composes'] }],
  },
}
