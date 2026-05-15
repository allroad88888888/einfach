# auto-fill

Owns series detection and locale configuration for fill-handle drag operations.

## State Decision Template

- Source atoms:
  - `fillSeriesLocaleAtom`: weekday names, month names, and custom list registry supplied by the host.
- Derived atoms: none; detection runs as a pure function (`detectFillSeries`) called by the pointer layer.
- Commands:
  - `setFillSeriesLocaleAtom`: replace the locale options at workbook init or locale change.
- Scale bound: single `FillSeriesLocaleOptions` object; no per-cell atoms.
- Backend reads: none; detector operates over `DisplayCell[]` from the existing projection cache.
- Per-cell/per-row/per-col atom risk: none; `detectFillSeries` is a pure function.
- Tests: `test/auto-fill-series.test.ts`.

## Deferred scope

Date-day, date-week, and date-month detection (`FillSeriesKind` variants `'date-day'`,
`'date-week'`, `'date-month'`) are defined in the type but not yet implemented by
`detectFillSeries`. A robust date parser is out of scope for this PR; date strings fall
back to `{ kind: 'copy' }`. Implement when a date-parsing utility is available in the
package.
