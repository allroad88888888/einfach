// Jest moduleNameMapper target for CSS imports. Components co-locate styles
// next to their .tsx (e.g. `import './dialog.css'`) so they can ship as part
// of the Vite bundle; jest doesn't run Vite's CSS pipeline, so without this
// stub `import './foo.css'` would error at parse time. Returning an empty
// object lets `className.foo` lookups resolve to `undefined` rather than
// throw, which is what test code expects.
module.exports = {}
