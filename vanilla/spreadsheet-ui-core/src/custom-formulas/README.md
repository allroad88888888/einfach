# custom-formulas

Owns the user-defined custom-formula registry (Wave 8). UI core stores
registrations as plain `{ name, source, description?, paramLabels? }`
records keyed by uppercase name; the Solid host diffs the registry atom
and forwards add/remove to the worker, which `new Function('args',
source)`s the body and hands the resulting callable to the WASM
`Workbook` via `registerCustomFormula`.

The source-string boundary deliberately rules out a `(args) => ...` JS
function travelling across `postMessage`: closures cannot be cloned, and
`fn.toString()` + regex parsing for the body silently drops captured
state. Asking the host for a body string is both cheaper and safer —
the only thing the worker can see is the explicit `args` array.

## State Decision Template

- Source atom:
  - `customFormulaRegistryAtom`: `ReadonlyMap<name, CustomFormulaRegistration>`.
    Bounded by the host; practical caps are in the hundreds for typical
    workbooks. ReadonlyMap value type prevents accidental in-place
    mutation by consumers.
- Derived atoms: none in core. The host defines a derived
  `customFormulasSupportedAtom` reading `backend.registerCustomFormula
  != null` and uses it to gate optional UI (none in MVP — registration
  is programmatic, not menu-driven).
- Commands:
  - `registerCustomFormulaAtom` — add or replace by name. Validates the
    name via `validateCustomFormulaName`; throws if invalid so hosts
    surface bad inputs at the call site rather than letting them leak
    into the worker.
  - `unregisterCustomFormulaAtom` — no-op if not registered.
- Helper:
  - `validateCustomFormulaName(name)` — returns
    `{ ok: true } | { ok: false; reason }` where `reason` is one of
    `'name-empty' | 'name-format' | 'name-shadows-builtin'`. Hosts that
    want a UI affordance can call this directly without round-tripping
    through the register atom.
- Scale bound: a single map; no per-name families.
- Backend reads: optional `registerCustomFormula(name, source)` /
  `unregisterCustomFormula(name)`. Host adapters that omit these
  methods make the registry atom inert (writes succeed but the host
  effect skips the worker call); this is the same degraded-feature
  shape every other Wave 7/8 optional port uses.
- Per-cell atom risk: none.
- Tests: `test/custom-formulas.test.ts` (core),
  `solid/excel/test/vnext-custom-formulas.test.tsx` (host).

## Name rules

- Regex: `/^[A-Z][A-Z0-9_.]*$/`.
- Must not shadow a name in `BUILTIN_FORMULA_NAMES` (built from the
  seed registry under `formula-functions/registry.ts`). The Rust engine
  ships many more built-ins than this list — shadowing one not in the
  list will succeed at register time and silently override on the WASM
  side, which is Excel-compatible (last registration wins).
- Re-registering an existing custom name silently replaces the previous
  source / metadata (Excel semantics).

## Source-string contract

The `source` field is the body of a function whose single parameter is
bound to `args` (Array). The worker constructs the live function via
`new Function('args', source)`. The body MUST be synchronous — async /
Promise returns are not supported in MVP and will surface a
`#ERROR!` cell with the worker-side exception.

Throwing inside the body produces `#ERROR!` with the thrown message.
Returning `undefined` is treated the same as returning `null`.

Plain-value contract (see `CustomFormulaArg` / `CustomFormulaReturn`):

| direction | shape                                                  |
| --------- | ------------------------------------------------------ |
| in        | `Array<number \| string \| boolean \| null>`           |
| out       | `number \| string \| boolean \| null \| undefined`     |

The Rust engine never passes a `Value::Array` into a JS callback; array
results from formulas collapse to their top-left scalar at the WASM
boundary, so this scalar-only union is exhaustive for MVP.
