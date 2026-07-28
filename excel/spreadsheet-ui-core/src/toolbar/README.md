# toolbar

Owns toolbar/ribbon UI state and command availability.

## State Decision Template

- Source atoms:
  - `toolbarUiStateAtom`: one active dropdown/palette surface.
  - `toolbarIntentAtom`: last toolbar surface or format intent.
- Derived atoms:
  - `toolbarActiveSurfaceAtom`
  - `toolbarCommandAvailabilityAtom`
- Commands:
  - `openToolbarDropdownAtom`
  - `openToolbarPaletteAtom`
  - `closeToolbarSurfaceAtom`
  - `dispatchToolbarFormatCommandAtom`
  - `clearToolbarIntentAtom`
- Scale bound: one active toolbar surface and one last intent. Availability stays compact and is
  derived from selection kind, sheet focus, and editing mode only.
- Backend reads: none in the core. Host adapters resolve the actual format write against the current
  sheet/selection and translate the intent into backend mutations. Do not mirror cell format facts
  into this layer.
- Per-cell/per-row/per-col atom risk: avoid it. This module must not store per-cell formatting
  caches, expanded cell maps, or workbook facts.
- Tests: `test/toolbar.test.ts`.
