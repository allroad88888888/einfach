export default {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: { node: 'current' },
        modules: 'commonjs',
      },
    ],
    '@babel/preset-typescript',
  ],
  plugins: [
    '@babel/plugin-transform-typescript',
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
}
