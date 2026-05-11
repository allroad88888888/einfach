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
//! wasm-pack test --headless --chrome rust/wasm
//! # or, if you don't have chrome handy:
//! wasm-pack test --node rust/wasm
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
