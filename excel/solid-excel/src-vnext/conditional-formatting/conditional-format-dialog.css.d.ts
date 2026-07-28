// Side-effect CSS module — the dialog `.tsx` pulls this in for its styles.
// Declaration is co-located so tsc is happy when the runtime-guarded
// `import('./conditional-format-dialog.css')` is type-checked. The default
// export is `unknown` because nothing consumes the returned namespace; we
// only want the load side-effect.
declare const css: unknown
export default css
