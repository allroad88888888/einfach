/**
 * Chinese catalog. Same keyspace as en.ts; missing keys fall back to the
 * raw msgId via `@lingui/core` (matches the lingui default behavior).
 */
export const messages: Record<string, string> = {
  // App chrome
  'app.title': 'Einfach 表格',
  'app.subtitle': 'Rust + WASM + SolidJS',
  'locale.en': 'EN',
  'locale.zh': '中',
}
