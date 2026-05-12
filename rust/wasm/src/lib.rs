use einfach_core::{CellListener, Value, ValueError};
use einfach_excel_core::{
    Align, CellFormat, CellSubscription, NumberFormat, Sheet, Workbook,
};
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

/// Wire format for `CellFormat` over wasm-bindgen. Mirrors `CellFormat` /
/// `NumberFormat` / `Align` but tagged-by-string so the JS side can build
/// these from plain object literals (`{ numberFormat: { kind: 'percent',
/// digits: 0 }, bold: true }`) without learning Rust's serde tags.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CellFormatJSON {
    #[serde(default, rename = "numberFormat")]
    number_format: Option<NumberFormatJSON>,
    #[serde(default)]
    bold: Option<bool>,
    #[serde(default)]
    italic: Option<bool>,
    #[serde(default)]
    align: Option<String>,
    #[serde(default, rename = "fontSize")]
    font_size: Option<u32>,
    #[serde(default, rename = "fgColor", alias = "color")]
    fg_color: Option<String>,
    #[serde(default, rename = "bgColor", alias = "background")]
    bg_color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NumberFormatJSON {
    /// One of "general" | "decimal" | "percent" | "currency" | "date".
    kind: String,
    #[serde(default)]
    digits: Option<u8>,
    /// Currency symbol — used when `kind == "currency"`.
    #[serde(default)]
    symbol: Option<String>,
    /// Strftime-style pattern — used when `kind == "date"`.
    #[serde(default)]
    pattern: Option<String>,
    /// Render thousands separators for `decimal`.
    #[serde(default)]
    thousands: Option<bool>,
}

impl CellFormatJSON {
    fn into_format(self) -> CellFormat {
        let number_format = self
            .number_format
            .map(|nf| nf.into_number_format())
            .unwrap_or_default();
        let align = match self.align.as_deref() {
            Some("left") => Align::Left,
            Some("center") => Align::Center,
            Some("right") => Align::Right,
            _ => Align::Default,
        };
        CellFormat {
            number_format,
            bold: self.bold.unwrap_or(false),
            italic: self.italic.unwrap_or(false),
            align,
            font_size: self.font_size,
            color: self.fg_color,
            background: self.bg_color,
        }
    }

    fn from_format(fmt: &CellFormat) -> Self {
        CellFormatJSON {
            number_format: Some(NumberFormatJSON::from_number_format(&fmt.number_format)),
            bold: Some(fmt.bold),
            italic: Some(fmt.italic),
            align: Some(match fmt.align {
                Align::Default => "default".into(),
                Align::Left => "left".into(),
                Align::Center => "center".into(),
                Align::Right => "right".into(),
            }),
            font_size: fmt.font_size,
            fg_color: fmt.color.clone(),
            bg_color: fmt.background.clone(),
        }
    }
}

impl NumberFormatJSON {
    fn into_number_format(self) -> NumberFormat {
        match self.kind.as_str() {
            "decimal" => NumberFormat::Decimal {
                digits: self.digits.unwrap_or(2),
                thousands: self.thousands.unwrap_or(false),
            },
            "percent" => NumberFormat::Percent {
                digits: self.digits.unwrap_or(0),
            },
            "currency" => NumberFormat::Currency {
                symbol: self.symbol.unwrap_or_else(|| "$".into()),
                digits: self.digits.unwrap_or(2),
            },
            "date" => NumberFormat::Date(self.pattern.unwrap_or_else(|| "yyyy-mm-dd".into())),
            _ => NumberFormat::General,
        }
    }

    fn from_number_format(nf: &NumberFormat) -> Self {
        match nf {
            NumberFormat::General => NumberFormatJSON {
                kind: "general".into(),
                digits: None,
                symbol: None,
                pattern: None,
                thousands: None,
            },
            NumberFormat::Decimal { digits, thousands } => NumberFormatJSON {
                kind: "decimal".into(),
                digits: Some(*digits),
                symbol: None,
                pattern: None,
                thousands: Some(*thousands),
            },
            NumberFormat::Percent { digits } => NumberFormatJSON {
                kind: "percent".into(),
                digits: Some(*digits),
                symbol: None,
                pattern: None,
                thousands: None,
            },
            NumberFormat::Currency { symbol, digits } => NumberFormatJSON {
                kind: "currency".into(),
                digits: Some(*digits),
                symbol: Some(symbol.clone()),
                pattern: None,
                thousands: None,
            },
            NumberFormat::Date(p) => NumberFormatJSON {
                kind: "date".into(),
                digits: None,
                symbol: None,
                pattern: Some(p.clone()),
                thousands: None,
            },
        }
    }
}

/// Initialize the panic hook once per module load. Called automatically from
/// every `WasmSheet::new()`; idempotent thanks to `set_once`. C.10.
fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

thread_local! {
    /// One-shot debug knob: when true, the next `JsCallbackListener::on_change`
    /// fires panic!() inside its microtask. Used by the regression e2e
    /// (`solid/excel/e2e/regression.spec.ts`) to verify two things in the
    /// real browser:
    ///   1. `console_error_panic_hook` actually surfaces the panic to
    ///      `console.error` (C.10).
    ///   2. The wasm instance survives — the panicking microtask aborts but
    ///      subsequent `set_*` / `get_*` calls keep working.
    /// Cleared on consume so a single arming triggers exactly one panic.
    static PANIC_NEXT_CALLBACK: Cell<bool> = const { Cell::new(false) };
}

/// Adapter listener that bridges core change events to a JS callback.
/// This is the "main-thread adapter" half of the layered subscribe model
/// (ROADMAP 1A D2). The future worker adapter (7C) will implement
/// `CellListener` on top of `postMessage` instead of a direct call.
struct JsCallbackListener {
    callback: js_sys::Function,
}

impl CellListener for JsCallbackListener {
    fn on_change(&self) {
        // Best-effort fire. Queue the JS callback so Solid can re-read the
        // sheet after the current &mut WasmSheet call has returned. Firing
        // synchronously lets reactive subscribers re-enter get_display while
        // set_number/set_formula is still borrowed by wasm-bindgen, which
        // drops the notification on the floor.
        #[cfg(target_arch = "wasm32")]
        {
            let callback = self.callback.clone();
            let task = Closure::once_into_js(move || {
                // Debug knob — see PANIC_NEXT_CALLBACK comment above. Checked
                // inside the microtask so the panic happens AFTER the
                // wasm-bindgen &mut borrow has released, matching real
                // listener panic semantics.
                let should_panic = PANIC_NEXT_CALLBACK.with(|c| {
                    let was = c.get();
                    if was {
                        c.set(false);
                    }
                    was
                });
                if should_panic {
                    panic!("[__debug_panic_next_callback] injected panic for regression test");
                }
                let _ = callback.call0(&JsValue::undefined());
            });
            let queued =
                js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("queueMicrotask"))
                    .ok()
                    .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
                    .and_then(|queue_microtask| {
                        queue_microtask.call1(&JsValue::undefined(), &task).ok()
                    })
                    .is_some();
            if !queued {
                let delayed =
                    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("setTimeout"))
                        .ok()
                        .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
                        .and_then(|set_timeout| {
                            set_timeout
                                .call2(&JsValue::undefined(), &task, &JsValue::from_f64(0.0))
                                .ok()
                        })
                        .is_some();
                if !delayed {
                    let _ = self.callback.call0(&JsValue::undefined());
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            // Native tests do not exercise JS subscriptions, but keep the
            // implementation direct for non-wasm builds.
            let _ = self.callback.call0(&JsValue::undefined());
        }
    }
}

/// WASM-exposed spreadsheet. Wraps the Rust Sheet.
#[wasm_bindgen]
pub struct WasmSheet {
    sheet: Sheet,
    /// Active subscriptions, keyed by an opaque token id we hand back to JS.
    /// Sheet owns the address-level rewiring when a cell switches between
    /// primitive and formula atoms.
    subscriptions: HashMap<u32, CellSubscription>,
    next_token: u32,
}

#[wasm_bindgen]
impl WasmSheet {
    /// Create a new empty spreadsheet.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        install_panic_hook();
        WasmSheet {
            sheet: Sheet::new(),
            subscriptions: HashMap::new(),
            next_token: 0,
        }
    }

    /// Set a cell to a numeric value. Subscribers fire automatically via the
    /// store's propagation pass — no manual fire_listeners needed (C.1+C.2).
    pub fn set_number(&mut self, addr: &str, value: f64) {
        self.sheet.set_cell(addr, Value::Number(value));
    }

    /// Clear a cell to empty. Mirrors ISheet.clear_cell on the JS side.
    pub fn clear_cell(&mut self, addr: &str) {
        self.sheet.clear_cell(addr);
    }

    pub fn insert_row(&mut self, at: u32, count: u32) {
        self.sheet.insert_row(at, count);
    }
    pub fn delete_row(&mut self, at: u32, count: u32) {
        self.sheet.delete_row(at, count);
    }
    pub fn insert_col(&mut self, at: u32, count: u32) {
        self.sheet.insert_col(at, count);
    }
    pub fn delete_col(&mut self, at: u32, count: u32) {
        self.sheet.delete_col(at, count);
    }

    /// Set a cell to a text value.
    pub fn set_text(&mut self, addr: &str, value: &str) {
        self.sheet.set_cell(addr, Value::Text(value.to_string()));
    }

    /// Set a cell to a boolean value.
    pub fn set_boolean(&mut self, addr: &str, value: bool) {
        self.sheet.set_cell(addr, Value::Boolean(value));
    }

    /// Set a cell to an error value by its display code. Unknown codes fall
    /// back to #VALUE!, matching the generic invalid-value error.
    pub fn set_error(&mut self, addr: &str, value: &str) {
        let err = match value {
            "#DIV/0!" => ValueError::DivisionByZero,
            "#REF!" => ValueError::InvalidRef,
            "#NAME?" => ValueError::InvalidName,
            "#CYCLE!" => ValueError::CyclicRef,
            _ => ValueError::InvalidValue,
        };
        self.sheet.set_cell(addr, Value::Error(err));
    }

    /// Set a cell's formula (e.g. "=A1+B1").
    /// Returns `true` if the formula parsed successfully, `false` if it was
    /// invalid (cell becomes `#VALUE!`) or would form a cycle (cell becomes `#CYCLE!`).
    pub fn set_formula(&mut self, addr: &str, formula: &str) -> bool {
        self.sheet.set_formula(addr, formula)
    }

    /// Get a cell's display value as a string.
    pub fn get_display(&mut self, addr: &str) -> String {
        let val = self.sheet.get_cell(addr);
        value_to_display(&val)
    }

    /// Get a cell's raw numeric value. Returns NaN if not a number.
    pub fn get_number(&mut self, addr: &str) -> f64 {
        match self.sheet.get_cell(addr) {
            Value::Number(n) => n,
            _ => f64::NAN,
        }
    }

    /// Get the type of a cell's value: "number", "text", "boolean", "null", "error"
    pub fn get_type(&mut self, addr: &str) -> String {
        match self.sheet.get_cell(addr) {
            Value::Number(_) => "number".into(),
            Value::Text(_) => "text".into(),
            Value::Boolean(_) => "boolean".into(),
            Value::Null => "null".into(),
            Value::Error(_) => "error".into(),
        }
    }

    /// Check if a cell contains an error.
    pub fn is_error(&mut self, addr: &str) -> bool {
        self.sheet.get_cell(addr).is_error()
    }

    /// Set multiple cells at once (batch). Pass arrays of addresses and values.
    pub fn batch_set_numbers(&mut self, addrs: Vec<String>, values: Vec<f64>) {
        let pairs: Vec<(&str, Value)> = addrs
            .iter()
            .zip(values.iter())
            .map(|(a, v)| (a.as_str(), Value::Number(*v)))
            .collect();
        self.sheet.batch_set(&pairs);
    }

    /// Subscribe to changes on a cell. Returns an opaque u32 token to pass
    /// to `unsubscribe`. The callback fires whenever the cell's value
    /// changes — including transitively through formula dependencies (C.2).
    pub fn subscribe(&mut self, addr: &str, callback: js_sys::Function) -> u32 {
        let token = self.next_token;
        self.next_token = self.next_token.wrapping_add(1);
        let listener = JsCallbackListener { callback };
        let sub = self.sheet.subscribe_cell_boxed(addr, Box::new(listener));
        self.subscriptions.insert(token, sub);
        token
    }

    /// Cancel a subscription previously returned from `subscribe`.
    /// Idempotent: unknown tokens are ignored.
    pub fn unsubscribe(&mut self, token: u32) {
        if let Some(sub) = self.subscriptions.remove(&token) {
            self.sheet.unsubscribe_cell(sub);
        }
    }

    /// Debug-only panic injection — arms a one-shot flag so the next
    /// JsCallbackListener fire panics inside its microtask. After consumption
    /// the flag clears, so subsequent fires behave normally. Used by
    /// `regression.spec.ts` (Discovered #E.2) to verify console_error_panic_hook
    /// surfaces the panic to console.error AND the wasm instance keeps
    /// working for subsequent set_/get_ calls. Not part of the production
    /// API surface — naming with `__` prefix to flag.
    #[wasm_bindgen(js_name = "__debugPanicNextCallback")]
    pub fn debug_panic_next_callback(&self) {
        PANIC_NEXT_CALLBACK.with(|c| c.set(true));
    }

    /// Return a cell's original formula text, or empty string for cells
    /// without a formula. Used by the formula bar / double-click edit so
    /// users edit `=A1*2` instead of the displayed result `20` (D.11).
    pub fn get_formula(&self, addr: &str) -> String {
        self.sheet.get_formula(addr).unwrap_or_default()
    }

    /// Every non-empty address on this sheet, as `"A1"`-style strings.
    /// Empty cells are skipped; an address holding both a primitive slot
    /// and a formula appears once (formula dominates). Used by
    /// structural-undo to snapshot only what needs restoring — see
    /// `solid/excel/docs/STRUCTURAL_UNDO.md`.
    pub fn non_empty_addrs(&self) -> Vec<String> {
        self.sheet.non_empty_addrs()
    }

    /// Phase 6 — set the format for a cell. `fmt` is a plain JS object
    /// matching `CellFormatJSON` (numberFormat, bold, italic, align,
    /// bgColor, fgColor). Passing `null` / `undefined` / `{}` removes any
    /// non-default format.
    pub fn set_format(&mut self, addr: &str, fmt: JsValue) -> Result<(), JsValue> {
        let parsed: CellFormatJSON = if fmt.is_undefined() || fmt.is_null() {
            CellFormatJSON::default()
        } else {
            serde_wasm_bindgen::from_value(fmt)
                .map_err(|e| JsValue::from_str(&format!("invalid CellFormat: {e}")))?
        };
        self.sheet.set_format(addr, parsed.into_format());
        Ok(())
    }

    /// Read the base format for a cell (no conditional rules applied).
    pub fn get_format(&self, addr: &str) -> JsValue {
        let fmt = self.sheet.get_format(addr);
        serde_wasm_bindgen::to_value(&CellFormatJSON::from_format(&fmt))
            .unwrap_or(JsValue::UNDEFINED)
    }

    /// Read the effective format for a cell (base + first matching
    /// conditional rule override).
    pub fn get_effective_format(&self, addr: &str) -> JsValue {
        let fmt = self.sheet.effective_format(addr);
        serde_wasm_bindgen::to_value(&CellFormatJSON::from_format(&fmt))
            .unwrap_or(JsValue::UNDEFINED)
    }

    /// Format a cell's value using its effective format. Numeric cells go
    /// through `CellFormat::format_number`; non-numeric cells fall back to
    /// the default display path.
    pub fn formatted_display(&self, addr: &str) -> String {
        self.sheet.formatted_display(addr)
    }

    // === B1 — debug counters mirror ===
    //
    // Thin wrappers that expose the Sheet-level `debug_*` counters across
    // the WASM boundary. Each returns `u32` so the JS side gets a plain
    // number; on 64-bit hosts the counters are `usize` but the values we
    // expect (eval counts, dirty counts, live sub counts) stay well under
    // 2^32 for any realistic test. Naming mirrors `debug_*` on `Sheet`.

    /// Total formula evaluations performed since this sheet was created.
    pub fn debug_formula_eval_count(&self) -> u32 {
        self.sheet.debug_formula_eval_count() as u32
    }

    /// Number of formula records currently in the `Dirty` cache state.
    pub fn debug_dirty_count(&self) -> u32 {
        self.sheet.debug_dirty_count() as u32
    }

    /// Number of formulas registered via `bulk_load` (cumulative).
    pub fn debug_imported_formula_count(&self) -> u32 {
        self.sheet.debug_imported_formula_count() as u32
    }

    /// Number of `CellAddress`es with at least one live listener.
    pub fn debug_live_subscription_count(&self) -> u32 {
        self.sheet.debug_live_subscription_count() as u32
    }

    /// Number of distinct `CellRange`s tracked in the range dependents
    /// index. One entry per range referenced by at least one formula,
    /// regardless of the range's cell count.
    pub fn debug_range_dep_count(&self) -> u32 {
        self.sheet.debug_range_dep_count() as u32
    }
}

/// WASM-exposed workbook. Wraps the Rust Workbook so browser demos can
/// evaluate formulas through workbook context, including cross-sheet refs.
#[wasm_bindgen]
pub struct WasmWorkbook {
    workbook: Workbook,
}

#[wasm_bindgen]
impl WasmWorkbook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        install_panic_hook();
        WasmWorkbook {
            workbook: Workbook::new(),
        }
    }

    pub fn sheet_count(&self) -> u32 {
        self.workbook.sheet_count() as u32
    }

    pub fn sheet_name(&self, idx: u32) -> String {
        self.workbook
            .name(idx as usize)
            .map(str::to_string)
            .unwrap_or_default()
    }

    pub fn add_sheet(&mut self, name: &str) -> u32 {
        self.workbook.add_sheet(name) as u32
    }

    pub fn rename_sheet(&mut self, idx: u32, name: &str) -> bool {
        self.workbook.rename_sheet(idx as usize, name)
    }

    pub fn remove_sheet(&mut self, idx: u32) -> bool {
        self.workbook.remove_sheet(idx as usize).is_some()
    }

    pub fn set_number(&mut self, sheet_idx: u32, addr: &str, value: f64) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.set_cell(addr, Value::Number(value));
        }
    }

    pub fn set_text(&mut self, sheet_idx: u32, addr: &str, value: &str) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.set_cell(addr, Value::Text(value.to_string()));
        }
    }

    pub fn set_boolean(&mut self, sheet_idx: u32, addr: &str, value: bool) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.set_cell(addr, Value::Boolean(value));
        }
    }

    pub fn set_error(&mut self, sheet_idx: u32, addr: &str, value: &str) {
        let err = match value {
            "#DIV/0!" => ValueError::DivisionByZero,
            "#REF!" => ValueError::InvalidRef,
            "#NAME?" => ValueError::InvalidName,
            "#CYCLE!" => ValueError::CyclicRef,
            _ => ValueError::InvalidValue,
        };
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.set_cell(addr, Value::Error(err));
        }
    }

    pub fn set_formula(&mut self, sheet_idx: u32, addr: &str, formula: &str) -> bool {
        self.workbook.set_formula(sheet_idx as usize, addr, formula)
    }

    pub fn clear_cell(&mut self, sheet_idx: u32, addr: &str) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.clear_cell(addr);
        }
    }

    pub fn insert_row(&mut self, sheet_idx: u32, at: u32, count: u32) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.insert_row(at, count);
        }
    }

    pub fn delete_row(&mut self, sheet_idx: u32, at: u32, count: u32) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.delete_row(at, count);
        }
    }

    pub fn insert_col(&mut self, sheet_idx: u32, at: u32, count: u32) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.insert_col(at, count);
        }
    }

    pub fn delete_col(&mut self, sheet_idx: u32, at: u32, count: u32) {
        if let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) {
            sheet.delete_col(at, count);
        }
    }

    pub fn get_display(&self, sheet_idx: u32, addr: &str) -> String {
        let val = self.workbook_value(sheet_idx, addr);
        value_to_display(&val)
    }

    pub fn get_number(&self, sheet_idx: u32, addr: &str) -> f64 {
        match self.workbook_value(sheet_idx, addr) {
            Value::Number(n) => n,
            _ => f64::NAN,
        }
    }

    pub fn get_type(&self, sheet_idx: u32, addr: &str) -> String {
        match self.workbook_value(sheet_idx, addr) {
            Value::Number(_) => "number".into(),
            Value::Text(_) => "text".into(),
            Value::Boolean(_) => "boolean".into(),
            Value::Null => "null".into(),
            Value::Error(_) => "error".into(),
        }
    }

    pub fn is_error(&self, sheet_idx: u32, addr: &str) -> bool {
        self.workbook_value(sheet_idx, addr).is_error()
    }

    pub fn get_formula(&self, sheet_idx: u32, addr: &str) -> String {
        self.workbook
            .sheet(sheet_idx as usize)
            .and_then(|sheet| sheet.get_formula(addr))
            .unwrap_or_default()
    }

    pub fn debug_formula_cache_state(&self, sheet_idx: u32, addr: &str) -> String {
        self.workbook
            .debug_formula_cache_state(sheet_idx as usize, addr)
            .to_string()
    }
}

impl WasmWorkbook {
    fn workbook_value(&self, sheet_idx: u32, addr: &str) -> Value {
        let Some(name) = self.workbook.name(sheet_idx as usize) else {
            return Value::Null;
        };
        self.workbook.get_cell(name, addr)
    }
}

fn value_to_display(val: &Value) -> String {
    match val {
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::Text(s) => s.clone(),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Null => String::new(),
        Value::Error(e) => format!("{}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasm_sheet_basic() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 10.0);
        assert_eq!(sheet.get_display("A1"), "10");
        assert_eq!(sheet.get_number("A1"), 10.0);
        assert_eq!(sheet.get_type("A1"), "number");
    }

    #[test]
    fn wasm_sheet_text() {
        let mut sheet = WasmSheet::new();
        sheet.set_text("A1", "hello");
        assert_eq!(sheet.get_display("A1"), "hello");
        assert_eq!(sheet.get_type("A1"), "text");
    }

    #[test]
    fn wasm_sheet_formula() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 10.0);
        sheet.set_number("B1", 20.0);
        sheet.set_formula("C1", "=A1+B1");
        assert_eq!(sheet.get_display("C1"), "30");
        assert_eq!(sheet.get_number("C1"), 30.0);
    }

    #[test]
    fn wasm_sheet_formula_updates() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 5.0);
        sheet.set_formula("B1", "=A1*2");
        assert_eq!(sheet.get_number("B1"), 10.0);

        sheet.set_number("A1", 100.0);
        assert_eq!(sheet.get_number("B1"), 200.0);
    }

    #[test]
    fn wasm_sheet_error() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 10.0);
        sheet.set_number("B1", 0.0);
        sheet.set_formula("C1", "=A1/B1");
        assert!(sheet.is_error("C1"));
        assert_eq!(sheet.get_display("C1"), "#DIV/0!");
    }

    #[test]
    fn wasm_sheet_null_cell() {
        let mut sheet = WasmSheet::new();
        assert_eq!(sheet.get_display("A1"), "");
        assert_eq!(sheet.get_type("A1"), "null");
    }

    #[test]
    fn wasm_display_integer() {
        assert_eq!(value_to_display(&Value::Number(42.0)), "42");
    }

    #[test]
    fn wasm_display_float() {
        assert_eq!(value_to_display(&Value::Number(3.14)), "3.14");
    }

    #[test]
    fn wasm_display_boolean() {
        assert_eq!(value_to_display(&Value::Boolean(true)), "TRUE");
        assert_eq!(value_to_display(&Value::Boolean(false)), "FALSE");
    }

    #[test]
    fn wasm_sheet_sum_function() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 1.0);
        sheet.set_number("A2", 2.0);
        sheet.set_number("A3", 3.0);
        sheet.set_formula("A4", "=SUM(A1,A2,A3)");
        assert_eq!(sheet.get_number("A4"), 6.0);
    }

    #[test]
    fn wasm_workbook_three_sheet_chain() {
        let mut wb = WasmWorkbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");

        wb.set_number(0, "B4", 10.0);
        assert!(wb.set_formula(2, "B2", "=Sheet1!B4+1"));
        assert!(wb.set_formula(1, "B2", "=Sheet3!B2+1"));
        assert!(wb.set_formula(0, "B2", "=Sheet2!B2+1"));

        assert_eq!(wb.get_number(2, "B2"), 11.0);
        assert_eq!(wb.get_number(1, "B2"), 12.0);
        assert_eq!(wb.get_number(0, "B2"), 13.0);

        wb.set_number(0, "B4", 20.0);
        assert_eq!(wb.get_number(0, "B2"), 23.0);
    }

    #[test]
    fn wasm_workbook_independent_formula_stays_dirty_until_read() {
        let mut wb = WasmWorkbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");

        wb.set_number(0, "B4", 10.0);
        wb.set_number(2, "B4", 100.0);
        assert!(wb.set_formula(2, "C2", "=Sheet1!B4+1"));
        assert!(wb.set_formula(1, "C2", "=Sheet3!C2+1"));
        assert!(wb.set_formula(0, "C2", "=Sheet2!C2+1"));
        assert!(wb.set_formula(1, "C5", "=Sheet3!B4+5"));

        assert_eq!(wb.get_number(0, "C2"), 13.0);
        assert_eq!(wb.debug_formula_cache_state(1, "C5"), "dirty");

        assert_eq!(wb.get_number(1, "C5"), 105.0);
        assert_eq!(wb.debug_formula_cache_state(1, "C5"), "clean");
    }
}
