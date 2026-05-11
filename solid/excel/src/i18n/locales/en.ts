/**
 * English catalog. Keys mirror the strings as they appear in the UI;
 * the catalog is the source of truth for the EN copy so the underlying
 * components stay free of literal text.
 *
 * Step 2 of the i18n rollout only seeds the smoke entries; Step 3 fills
 * in the per-demo title + description copy.
 */
export const messages: Record<string, string> = {
  // App chrome
  'app.title': 'Einfach Excel',
  'app.subtitle': 'Rust + WASM + SolidJS',
  'locale.en': 'EN',
  'locale.zh': '中',
}
