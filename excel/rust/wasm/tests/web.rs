//! wasm-bindgen-test suite for `einfach-wasm`.
//!
//! These tests exercise wasm32-specific paths that native `cargo test`
//! cannot reach — chiefly `JsCallbackListener::on_change`'s microtask
//! defer (queueMicrotask -> setTimeout(0) -> sync fallback) and the
//! `__debugPanicNextCallback` knob that validates `console_error_panic_hook`
//! plus wasm-instance survival (C.10).
//!
//! Run with:
//! ```bash
//! wasm-pack test --headless --chrome excel/rust/wasm
//! # or, if you don't have chrome handy:
//! wasm-pack test --node excel/rust/wasm
//! ```
//!
//! Native `cargo test` skips this file because it is gated on
//! `target_arch = "wasm32"`.

#![cfg(target_arch = "wasm32")]

use std::cell::Cell;
use std::rc::Rc;

use einfach_wasm::{WasmSheet, WasmWorkbook};
use js_sys::Promise;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;

// Tests target a real browser by default (`run_in_browser`) so we exercise
// the production `queueMicrotask` path under realistic event-loop semantics.
// Node also implements `queueMicrotask`, so `wasm-pack test --node` works as
// a fallback when no chromedriver/chrome combination is available locally —
// just comment out the configure macro below to drop back to node.
wasm_bindgen_test_configure!(run_in_browser);

/// Yield to JS so any queued microtasks (the path `JsCallbackListener::on_change`
/// uses) get a chance to fire before we observe state.
async fn drain_microtask() {
    let promise = Promise::resolve(&JsValue::undefined());
    let _ = JsFuture::from(promise).await;
}

/// True when running under Node (no `window` global), false when running in a
/// browser. We use this to gate the panic-inject test — Node has no
/// "uncaught microtask exception" trap that mirrors the browser's
/// `console.error` + survive behavior, so an injected panic kills the Node
/// process before we can assert survival. In a browser the panic is logged
/// and execution continues, which is the C.10 contract we want to pin.
fn is_node() -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("window"))
        .map(|w| w.is_undefined())
        .unwrap_or(true)
}

/// Build a `js_sys::Function` from a Rust closure that captures and increments
/// the supplied counter. The closure is leaked so that the returned `Function`
/// stays valid for the lifetime of the test — wasm-bindgen-test scopes each
/// test to its own future, so the leak is bounded and acceptable for a unit
/// suite.
fn counting_callback(counter: Rc<Cell<u32>>) -> js_sys::Function {
    let closure = Closure::wrap(Box::new(move || {
        counter.set(counter.get() + 1);
    }) as Box<dyn FnMut()>);
    let func: js_sys::Function = closure.as_ref().unchecked_ref::<js_sys::Function>().clone();
    // Leak — see comment above. Avoids the closure being dropped while JS
    // still holds the reference inside the microtask queue.
    closure.forget();
    func
}

/// set_number + subscribe + verify the callback fires after a microtask drain.
/// Pins the `queueMicrotask` happy path: production code defers to a
/// microtask so Solid can re-read the sheet after the &mut WasmSheet borrow
/// returns.
#[wasm_bindgen_test]
async fn wasm_sheet_subscribe_fires_callback_async() {
    let mut sheet = WasmSheet::new();
    let counter = Rc::new(Cell::new(0u32));
    let _token = sheet.subscribe("A1", counting_callback(counter.clone()));

    sheet.set_number("A1", 42.0);

    // Drain microtasks. The on_change microtask should fire here.
    drain_microtask().await;

    assert_eq!(counter.get(), 1, "callback should have fired exactly once");
}

/// Sister test of the previous — assert the callback does NOT fire
/// synchronously inside `set_number`. This is the bug the microtask defer
/// fixed: firing during the &mut borrow lets reactive subscribers re-enter
/// and drop the notification on the floor.
#[wasm_bindgen_test]
async fn wasm_sheet_subscribe_does_not_fire_synchronously() {
    let mut sheet = WasmSheet::new();
    let counter = Rc::new(Cell::new(0u32));
    let _token = sheet.subscribe("A1", counting_callback(counter.clone()));

    sheet.set_number("A1", 7.0);

    // Synchronous frame: callback must not have fired yet.
    assert_eq!(
        counter.get(),
        0,
        "callback must not fire inside the synchronous set_number frame"
    );

    drain_microtask().await;

    assert_eq!(
        counter.get(),
        1,
        "callback should have fired after microtask drain"
    );
}

/// Arm the panic-inject knob, trigger a callback, and then assert that
/// subsequent set/get on the wasm instance still work. This is the unit-level
/// pin of the C.10 contract: panics surface to console.error via
/// console_error_panic_hook AND the wasm instance survives the panic.
///
/// We cannot observe console.error from inside the test directly, but we
/// *can* observe the survival half: if the wasm instance had aborted,
/// subsequent calls on `sheet` would trap. The fact that we keep calling
/// get_display / set_number after the injected panic — and the assertions
/// hold — is the proof.
#[wasm_bindgen_test]
async fn wasm_sheet_panic_inject_surfaces_and_survives() {
    // Node's microtask exception handling kills the process on unhandled
    // panic, so the "instance survives" half of the assertion can only be
    // observed in a browser. Skip cleanly under `wasm-pack test --node`.
    if is_node() {
        return;
    }

    let mut sheet = WasmSheet::new();
    let counter = Rc::new(Cell::new(0u32));
    let _token = sheet.subscribe("A1", counting_callback(counter.clone()));

    // Arm the one-shot panic knob, then trigger a callback. The panic fires
    // inside the microtask, AFTER the &mut WasmSheet borrow has released.
    // `js_name = "__debugPanicNextCallback"` only affects the JS-facing name;
    // from Rust the method is still `debug_panic_next_callback`.
    sheet.debug_panic_next_callback();
    sheet.set_number("A1", 1.0);

    // Let the panicking microtask run.
    drain_microtask().await;

    // The counter should be 0 because the panic short-circuited the callback
    // before it could increment. The one-shot flag is now cleared.
    assert_eq!(
        counter.get(),
        0,
        "panicking microtask should not have incremented the counter"
    );

    // Wasm instance survival: subsequent calls keep working.
    sheet.set_number("A1", 99.0);
    assert_eq!(sheet.get_display("A1"), "99");
    assert_eq!(sheet.get_number("A1"), 99.0);

    // And subsequent change notifications now fire normally (flag is cleared).
    drain_microtask().await;
    assert_eq!(
        counter.get(),
        1,
        "post-panic callback should fire normally — knob is one-shot"
    );
}

/// Cross-sheet eval through the workbook provider, exercised in a real
/// browser. Mirrors the native `wasm_workbook_three_sheet_chain` but pins
/// the wasm32 path end-to-end.
///
/// Note: `WasmWorkbook` exposes `get_display(sheet_idx, addr)` /
/// `get_number(sheet_idx, addr)` rather than `get_cell(name, addr)` —
/// sheet names are looked up by idx on the JS surface. Sheet1 = idx 0
/// (auto-added by `Workbook::new()`), Sheet2 = idx 1.
#[wasm_bindgen_test]
fn wasm_workbook_cross_sheet_eval_in_browser() {
    let mut wb = WasmWorkbook::new();
    wb.add_sheet("Sheet2");

    // Sheet2!A1 = 5, Sheet1!B1 = =Sheet2!A1 * 2 -> 10
    wb.set_number(1, "A1", 5.0);
    assert!(wb.set_formula(0, "B1", "=Sheet2!A1*2"));

    assert_eq!(wb.get_display(0, "B1"), "10");
    assert_eq!(wb.get_number(0, "B1"), 10.0);

    // Update the source — re-read pulls the live value through the
    // workbook eval provider.
    wb.set_number(1, "A1", 12.0);
    assert_eq!(wb.get_display(0, "B1"), "24");
}

/// Lazy probe: a formula that nothing has read should stay `dirty` until
/// somebody actually reads it. Mirrors the native
/// `wasm_workbook_independent_formula_stays_dirty_until_read` test but on
/// wasm32, where the borrow-checker / wasm-bindgen marshalling story is
/// slightly different.
#[wasm_bindgen_test]
fn wasm_workbook_chain_dirty_until_read() {
    let mut wb = WasmWorkbook::new();
    wb.add_sheet("Sheet2");
    wb.add_sheet("Sheet3");

    wb.set_number(0, "B4", 10.0);
    wb.set_number(2, "B4", 100.0);
    assert!(wb.set_formula(2, "C2", "=Sheet1!B4+1"));
    assert!(wb.set_formula(1, "C5", "=Sheet3!B4+5"));

    // C5 has not been read yet; cache should be dirty.
    assert_eq!(wb.debug_formula_cache_state(1, "C5"), "dirty");

    // Reading forces compute and flips cache to clean.
    assert_eq!(wb.get_number(1, "C5"), 105.0);
    assert_eq!(wb.debug_formula_cache_state(1, "C5"), "clean");
}

// === Wave 8 custom-formula integration tests ===

/// Build a `js_sys::Function` from a Rust closure that takes the args
/// Array and returns a `JsValue`. The closure is leaked (`forget`) for
/// the same reason as `counting_callback` — wasm-bindgen-test's scoped
/// future would otherwise drop the closure while JS still holds the
/// reference on the workbook side.
fn make_js_fn<F>(body: F) -> js_sys::Function
where
    F: FnMut(js_sys::Array) -> JsValue + 'static,
{
    let closure = Closure::wrap(Box::new(body) as Box<dyn FnMut(js_sys::Array) -> JsValue>);
    let func: js_sys::Function = closure.as_ref().unchecked_ref::<js_sys::Function>().clone();
    closure.forget();
    func
}

/// MYTAX(amount) returns `amount * 0.2`. End-to-end exercise of the
/// custom-formula path: registration → cell formula references it →
/// engine dispatches through `WorkbookEvalProvider::call_custom` →
/// `WasmCustomFormulaRegistry::lookup` → JS callback → marshaled return.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_tax_round_trip() {
    let mut wb = WasmWorkbook::new();

    let tax = make_js_fn(|args| {
        let first = args.get(0);
        let amount = first.as_f64().unwrap_or(0.0);
        JsValue::from_f64(amount * 0.2)
    });
    wb.register_custom_formula("MYTAX".into(), tax);

    wb.set_number(0, "B1", 100.0);
    assert!(wb.set_formula(0, "C1", "=MYTAX(B1)"));

    assert_eq!(wb.get_number(0, "C1"), 20.0);
}

/// Lookup is case-insensitive. Register under upper case, reference
/// with mixed case in the formula.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_case_insensitive() {
    let mut wb = WasmWorkbook::new();
    let identity = make_js_fn(|args| args.get(0));
    wb.register_custom_formula("MYECHO".into(), identity);

    assert!(wb.set_formula(0, "A1", "=myEcho(42)"));
    assert_eq!(wb.get_number(0, "A1"), 42.0);
}

/// `unregisterCustomFormula` makes subsequent reads surface `#NAME?`.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_unregister_falls_back_to_name_error() {
    let mut wb = WasmWorkbook::new();
    let pi = make_js_fn(|_args| JsValue::from_f64(3.14));
    wb.register_custom_formula("MYPI".into(), pi);

    assert!(wb.set_formula(0, "A1", "=MYPI()"));
    assert_eq!(wb.get_number(0, "A1"), 3.14);

    assert!(wb.unregister_custom_formula("MYPI"));
    // After invalidation + re-eval, the cell now sees #NAME?.
    assert_eq!(wb.get_display(0, "A1"), "#NAME?");
}

/// A JS callback that throws surfaces `#VALUE!` in the cell. The wasm
/// instance stays alive — subsequent calls keep working.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_throw_surfaces_value_error() {
    let mut wb = WasmWorkbook::new();
    let thrower = make_js_fn(|_args| {
        // Construct a JS Error and re-throw via wasm_bindgen's exception
        // path. We can't `throw` from Rust directly, but returning a
        // promise that rejects or using js_sys won't reach this code path
        // — instead we use wasm_bindgen::throw_str which converts to a
        // JS exception on the callback boundary.
        wasm_bindgen::throw_str("synthetic error")
    });
    wb.register_custom_formula("MYBOOM".into(), thrower);

    assert!(wb.set_formula(0, "A1", "=MYBOOM()"));
    assert_eq!(wb.get_display(0, "A1"), "#VALUE!");

    // Instance survives — set a number on another cell and read back.
    wb.set_number(0, "B1", 7.0);
    assert_eq!(wb.get_number(0, "B1"), 7.0);
}

/// Returning a string maps to a text cell; returning canonical error tokens
/// round-trips as the matching `ValueError`.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_string_and_error_token_returns() {
    let mut wb = WasmWorkbook::new();

    let hello = make_js_fn(|_args| JsValue::from_str("hello"));
    wb.register_custom_formula("MYTXT".into(), hello);
    assert!(wb.set_formula(0, "A1", "=MYTXT()"));
    assert_eq!(wb.get_display(0, "A1"), "hello");

    let divzero = make_js_fn(|_args| JsValue::from_str("#DIV/0!"));
    wb.register_custom_formula("MYDIV".into(), divzero);
    assert!(wb.set_formula(0, "A2", "=MYDIV()"));
    assert_eq!(wb.get_display(0, "A2"), "#DIV/0!");

    let calc = make_js_fn(|_args| JsValue::from_str("#CALC!"));
    wb.register_custom_formula("MYCALC".into(), calc);
    assert!(wb.set_formula(0, "A3", "=MYCALC()"));
    assert_eq!(wb.get_display(0, "A3"), "#CALC!");

    let na = make_js_fn(|_args| JsValue::from_str("#N/A"));
    wb.register_custom_formula("MYNA".into(), na);
    assert!(wb.set_formula(0, "A4", "=MYNA()"));
    assert_eq!(wb.get_display(0, "A4"), "#N/A");

    let null = make_js_fn(|_args| JsValue::from_str("#NULL!"));
    wb.register_custom_formula("MYNULL".into(), null);
    assert!(wb.set_formula(0, "A5", "=MYNULL()"));
    assert_eq!(wb.get_display(0, "A5"), "#NULL!");
}

/// Re-registering an existing name replaces the callback AND dirties
/// dependent formulas so the next read reflects the new function.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_re_register_replaces_callback() {
    let mut wb = WasmWorkbook::new();
    let plus_one = make_js_fn(|args| {
        let v = args.get(0).as_f64().unwrap_or(0.0);
        JsValue::from_f64(v + 1.0)
    });
    wb.register_custom_formula("MYOP".into(), plus_one);
    assert!(wb.set_formula(0, "A1", "=MYOP(10)"));
    assert_eq!(wb.get_number(0, "A1"), 11.0);

    let times_two = make_js_fn(|args| {
        let v = args.get(0).as_f64().unwrap_or(0.0);
        JsValue::from_f64(v * 2.0)
    });
    wb.register_custom_formula("MYOP".into(), times_two);
    // Cache was invalidated by the re-register call.
    assert_eq!(wb.get_number(0, "A1"), 20.0);
}

/// `customFormulaCount` reflects registration / unregistration.
#[wasm_bindgen_test]
fn wasm_workbook_custom_formula_count_probe() {
    let mut wb = WasmWorkbook::new();
    assert_eq!(wb.custom_formula_count(), 0);

    let noop = make_js_fn(|_args| JsValue::null());
    wb.register_custom_formula("ONE".into(), noop.clone());
    assert_eq!(wb.custom_formula_count(), 1);

    wb.register_custom_formula("TWO".into(), noop);
    assert_eq!(wb.custom_formula_count(), 2);

    assert!(wb.unregister_custom_formula("ONE"));
    assert_eq!(wb.custom_formula_count(), 1);

    // Idempotent unregister of a missing entry returns false.
    assert!(!wb.unregister_custom_formula("UNKNOWN"));
    assert_eq!(wb.custom_formula_count(), 1);
}

/// STORAGE_PRIMARY Phase 6.2: one round-trip through
/// `bulk_install_workbook`. Primitives (both addr encodings, plus an
/// `{error}` object) and a formula land via the storage-primary path;
/// the formula hydrates lazily on first read; the per-sheet stats
/// report what was installed.
#[wasm_bindgen_test]
fn wasm_workbook_bulk_install_workbook_round_trip() {
    let mut wb = WasmWorkbook::new();
    let payload = js_sys::JSON::parse(
        r##"[{
            "sheet": 0,
            "primitives": [
                ["0:0", 2],
                ["1:0", 3],
                ["A3", "label"],
                ["3:0", {"error": "#DIV/0!"}]
            ],
            "formulas": [["0:1", "=A1+A2"]]
        }]"##,
    )
    .expect("payload JSON parses");

    let stats = wb
        .bulk_install_workbook(payload)
        .expect("bulk install succeeds");
    let entry = js_sys::Array::from(&stats).get(0);
    let field = |name: &str| {
        js_sys::Reflect::get(&entry, &JsValue::from_str(name))
            .expect("stats field exists")
            .as_f64()
            .expect("stats field is a number")
    };
    assert_eq!(field("primitivesInstalled"), 4.0);
    assert_eq!(field("formulasInstalled"), 1.0);
    assert_eq!(
        field("crossSheetParsed"),
        0.0,
        "bulk install performs no formula parse"
    );

    assert_eq!(wb.get_number(0, "A1"), 2.0);
    assert_eq!(wb.get_number(0, "A2"), 3.0);
    assert_eq!(wb.get_display(0, "A3"), "label");
    assert_eq!(wb.get_display(0, "A4"), "#DIV/0!");
    // Lazy hydration on first read.
    assert_eq!(wb.get_number(0, "B1"), 5.0);
}
