use einfach_core::{CellListener, Value, ValueError};
use einfach_excel_core::{
    Align, CellAddress, CellFormat, CellRange, CellSubscription, FormatRangeSnapshot, NumberFormat,
    RangeFormatSnapshotLayer, Sheet, Workbook,
};
use serde::{de, Deserialize, Serialize};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CellFormatSnapshotJSON {
    addr: String,
    format: CellFormatJSON,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RangeFormatLayerJSON {
    #[serde(rename = "startRow")]
    start_row: u32,
    #[serde(rename = "startCol")]
    start_col: u32,
    #[serde(rename = "endRow")]
    end_row: u32,
    #[serde(rename = "endCol")]
    end_col: u32,
    format: CellFormatJSON,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FormatRangeSnapshotJSON {
    #[serde(default)]
    sheet: Option<u32>,
    #[serde(rename = "startRow")]
    start_row: u32,
    #[serde(rename = "startCol")]
    start_col: u32,
    #[serde(rename = "endRow")]
    end_row: u32,
    #[serde(rename = "endCol")]
    end_col: u32,
    #[serde(rename = "cellFormats")]
    cell_formats: Vec<CellFormatSnapshotJSON>,
    #[serde(rename = "rangeFormats")]
    range_formats: Vec<RangeFormatLayerJSON>,
}

impl FormatRangeSnapshotJSON {
    fn from_snapshot(snapshot: &FormatRangeSnapshot, sheet: Option<u32>) -> Self {
        FormatRangeSnapshotJSON {
            sheet,
            start_row: snapshot.range.start.row,
            start_col: snapshot.range.start.col,
            end_row: snapshot.range.end.row,
            end_col: snapshot.range.end.col,
            cell_formats: snapshot
                .cell_formats
                .iter()
                .map(|(addr, fmt)| CellFormatSnapshotJSON {
                    addr: addr.to_string(),
                    format: CellFormatJSON::from_format(fmt),
                })
                .collect(),
            range_formats: snapshot
                .range_formats
                .iter()
                .map(|layer| RangeFormatLayerJSON {
                    start_row: layer.range.start.row,
                    start_col: layer.range.start.col,
                    end_row: layer.range.end.row,
                    end_col: layer.range.end.col,
                    format: CellFormatJSON::from_format(&layer.fmt),
                })
                .collect(),
        }
    }

    fn into_snapshot(self) -> Result<FormatRangeSnapshot, JsValue> {
        let mut cell_formats = Vec::with_capacity(self.cell_formats.len());
        for cell in self.cell_formats {
            let addr = CellAddress::parse(&cell.addr).ok_or_else(|| {
                JsValue::from_str(&format!("invalid cell address: {}", cell.addr))
            })?;
            cell_formats.push((addr, cell.format.into_format()));
        }
        let range_formats = self
            .range_formats
            .into_iter()
            .map(|layer| RangeFormatSnapshotLayer {
                range: CellRange::new(
                    CellAddress::new(layer.start_row, layer.start_col),
                    CellAddress::new(layer.end_row, layer.end_col),
                )
                .normalize(),
                fmt: layer.format.into_format(),
            })
            .collect();
        Ok(FormatRangeSnapshot {
            range: CellRange::new(
                CellAddress::new(self.start_row, self.start_col),
                CellAddress::new(self.end_row, self.end_col),
            )
            .normalize(),
            cell_formats,
            range_formats,
        })
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum ImportValueJSON {
    Number(f64),
    Boolean(bool),
    Text(String),
}

#[derive(Clone, Debug)]
enum BulkImportKindJSON {
    Text(String),
    Invalid,
}

impl Default for BulkImportKindJSON {
    fn default() -> Self {
        BulkImportKindJSON::Invalid
    }
}

impl<'de> Deserialize<'de> for BulkImportKindJSON {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = BulkImportKindJSON;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a string import kind")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Text(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Text(value))
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: de::Deserializer<'de>,
            {
                deserializer.deserialize_any(self)
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                while let Some(de::IgnoredAny) = seq.next_element()? {}
                Ok(BulkImportKindJSON::Invalid)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                while let Some((de::IgnoredAny, de::IgnoredAny)) = map.next_entry()? {}
                Ok(BulkImportKindJSON::Invalid)
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

#[derive(Clone, Debug)]
enum BulkImportValueJSON {
    Number(f64),
    Boolean(bool),
    Text(String),
    Invalid,
}

impl<'de> Deserialize<'de> for BulkImportValueJSON {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = BulkImportValueJSON;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a primitive import value")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Text(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Text(value))
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Boolean(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Number(value as f64))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Number(value as f64))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Number(value))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Invalid)
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(BulkImportValueJSON::Invalid)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: de::Deserializer<'de>,
            {
                deserializer.deserialize_any(self)
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                while let Some(de::IgnoredAny) = seq.next_element()? {}
                Ok(BulkImportValueJSON::Invalid)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                while let Some((de::IgnoredAny, de::IgnoredAny)) = map.next_entry()? {}
                Ok(BulkImportValueJSON::Invalid)
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

#[derive(Clone, Debug, Deserialize)]
struct WorkbookImportCellJSON {
    sheet: usize,
    row: u32,
    col: u32,
    #[serde(default)]
    kind: BulkImportKindJSON,
    #[serde(default)]
    value: Option<BulkImportValueJSON>,
}

#[derive(Clone, Debug, Serialize)]
struct WorkbookImportIssueJSON {
    sheet: usize,
    row: u32,
    col: u32,
    kind: String,
    code: String,
    message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
struct WorkbookImportStatsJSON {
    accepted: u32,
    formulas: u32,
    #[serde(rename = "rejectedFormulas")]
    rejected_formulas: u32,
    cleared: u32,
    errors: u32,
    issues: Vec<WorkbookImportIssueJSON>,
}

impl WorkbookImportStatsJSON {
    fn push_issue(&mut self, cell: &WorkbookImportCellJSON, kind: &str, code: &str, message: &str) {
        self.issues.push(WorkbookImportIssueJSON {
            sheet: cell.sheet,
            row: cell.row,
            col: cell.col,
            kind: kind.to_string(),
            code: code.to_string(),
            message: message.to_string(),
        });
    }
}

#[derive(Clone, Debug, Serialize)]
struct CellRefJSON {
    sheet: usize,
    addr: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SparseCellJSON {
    sheet: usize,
    addr: String,
    row: u32,
    col: u32,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<ImportValueJSON>,
}

#[derive(Clone, Debug, Serialize)]
struct CellSnapshotJSON {
    sheet: usize,
    addr: String,
    display: String,
    #[serde(rename = "type")]
    cell_type: String,
    #[serde(rename = "isError")]
    is_error: bool,
    formula: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkbookPersistenceSheetMetaJSON {
    idx: u32,
    name: String,
    #[serde(rename = "rowCount", default, skip_serializing_if = "Option::is_none")]
    row_count: Option<u32>,
    #[serde(rename = "colCount", default, skip_serializing_if = "Option::is_none")]
    col_count: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkbookPersistenceV1JSON {
    version: u32,
    sheets: Vec<WorkbookPersistenceSheetMetaJSON>,
    cells: Vec<SparseCellJSON>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    formats: Vec<FormatRangeSnapshotJSON>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkbookPersistenceRestoreStatsJSON {
    restored_cells: u32,
    restored_formats: u32,
    sheets: u32,
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

    /// Clear non-empty cells in a zero-based inclusive range. The core scans
    /// sparse entries only and coalesces dirty/subscriber propagation.
    pub fn clear_range(
        &mut self,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> u32 {
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        self.sheet.clear_range(range) as u32
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

    /// Phase 6 — set the format for a rectangular range.
    /// `fmt` follows the same wire shape as `set_format`; `null` / `undefined` / `{}` clears
    /// any non-default range style by storing the default style as a layer.
    pub fn set_format_range(
        &mut self,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        fmt: JsValue,
    ) -> Result<u32, JsValue> {
        let parsed: CellFormatJSON = if fmt.is_undefined() || fmt.is_null() {
            CellFormatJSON::default()
        } else {
            serde_wasm_bindgen::from_value(fmt)
                .map_err(|e| JsValue::from_str(&format!("invalid CellFormat: {e}")))?
        };
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        Ok(self.sheet.set_format_range(range, parsed.into_format()) as u32)
    }

    /// Snapshot sparse formatting metadata for undoing a later range-format
    /// edit. Does not read cell values or materialize empty cells.
    pub fn snapshot_format_range(
        &self,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> Result<JsValue, JsValue> {
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        let snapshot = self.sheet.snapshot_format_range(range);
        serde_wasm_bindgen::to_value(&FormatRangeSnapshotJSON::from_snapshot(&snapshot, None))
            .map_err(|err| JsValue::from_str(&format!("serialize format range snapshot: {err}")))
    }

    /// Restore metadata produced by `snapshot_format_range`.
    pub fn restore_format_snapshot(&mut self, snapshot: JsValue) -> Result<u32, JsValue> {
        let snapshot: FormatRangeSnapshotJSON = serde_wasm_bindgen::from_value(snapshot)
            .map_err(|err| JsValue::from_str(&format!("invalid format range snapshot: {err}")))?;
        let snapshot = snapshot.into_snapshot()?;
        Ok(self.sheet.restore_format_range_snapshot(snapshot) as u32)
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

/// Per-cell subscription bookkeeping for `WasmWorkbook`. We carry the
/// (sheet_idx, addr) tuple alongside the underlying `CellSubscription`
/// because Track I's cross-sheet dirty BFS will eventually fire JS callbacks
/// by looking up `(sheet_idx, CellAddress)`. The `CellSubscription` itself
/// is what the underlying `Sheet` returned from `subscribe_cell_boxed` and
/// is what we hand back to `Sheet::unsubscribe_cell` on teardown.
struct WorkbookCellSubscription {
    #[allow(dead_code)] // read post-merge once Track I owns dirty fanout
    sheet_idx: usize,
    #[allow(dead_code)]
    addr: CellAddress,
    sub: CellSubscription,
}

fn remap_sheet_index_after_move(idx: usize, from: usize, to: usize) -> usize {
    if from == to {
        return idx;
    }
    if idx == from {
        return to;
    }
    if from < to && idx > from && idx <= to {
        return idx - 1;
    }
    if to < from && idx >= to && idx < from {
        return idx + 1;
    }
    idx
}

/// WASM-exposed workbook. Wraps the Rust Workbook so browser demos can
/// evaluate formulas through workbook context, including cross-sheet refs.
#[wasm_bindgen]
pub struct WasmWorkbook {
    workbook: Workbook,
    /// Workbook-level per-cell subscriptions. The map is keyed by an opaque
    /// `u32` token handed back to JS. We keep the map on the workbook (not
    /// the underlying sheet) so that Track I's cross-sheet dirty BFS — which
    /// runs at workbook scope — can find the JS callbacks for any
    /// `(sheet_idx, addr)` it dirties.
    ///
    /// Track K first-cut wiring: each entry is registered on the underlying
    /// `Sheet` via `Sheet::subscribe_cell_boxed`. Same-sheet writes therefore
    /// fire correctly today through the existing Sheet propagation path.
    /// Cross-sheet writes do not fire yet — that becomes correct after
    /// Track I merges `Workbook::set_cell` and the cross-sheet dependency
    /// graph; the integrator will route fanout through this map at that
    /// point.
    subscriptions: HashMap<u32, WorkbookCellSubscription>,
    next_token: u32,
}

#[wasm_bindgen]
impl WasmWorkbook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        install_panic_hook();
        WasmWorkbook {
            workbook: Workbook::new(),
            subscriptions: HashMap::new(),
            next_token: 0,
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

    pub fn move_sheet(&mut self, from: u32, to: u32) -> bool {
        let from = from as usize;
        let to = to as usize;
        if !self.workbook.move_sheet(from, to) {
            return false;
        }
        for entry in self.subscriptions.values_mut() {
            entry.sheet_idx = remap_sheet_index_after_move(entry.sheet_idx, from, to);
        }
        true
    }

    pub fn set_number(&mut self, sheet_idx: u32, addr: &str, value: f64) {
        self.workbook
            .set_cell(sheet_idx as usize, addr, Value::Number(value));
    }

    pub fn set_text(&mut self, sheet_idx: u32, addr: &str, value: &str) {
        self.workbook
            .set_cell(sheet_idx as usize, addr, Value::Text(value.to_string()));
    }

    pub fn set_boolean(&mut self, sheet_idx: u32, addr: &str, value: bool) {
        self.workbook
            .set_cell(sheet_idx as usize, addr, Value::Boolean(value));
    }

    pub fn set_error(&mut self, sheet_idx: u32, addr: &str, value: &str) {
        let err = value_error_from_display(value);
        self.workbook
            .set_cell(sheet_idx as usize, addr, Value::Error(err));
    }

    pub fn set_formula(&mut self, sheet_idx: u32, addr: &str, formula: &str) -> bool {
        self.workbook.set_formula(sheet_idx as usize, addr, formula)
    }

    pub fn clear_cell(&mut self, sheet_idx: u32, addr: &str) {
        self.workbook.clear_cell(sheet_idx as usize, addr);
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

    /// Snapshot display/type/error/formula for a single cell with one
    /// workbook read. Worker hydration uses this to avoid evaluating a dirty
    /// formula once for display, again for type, and again for error state.
    #[wasm_bindgen(js_name = "snapshotCell")]
    pub fn snapshot_cell(&self, sheet_idx: u32, addr: &str) -> Result<JsValue, JsValue> {
        let sheet_idx_usize = sheet_idx as usize;
        let value = self.workbook_value(sheet_idx, addr);
        let formula = self
            .workbook
            .sheet(sheet_idx_usize)
            .and_then(|sheet| sheet.get_formula(addr))
            .unwrap_or_default();
        let addr = CellAddress::parse(addr)
            .map(|addr| addr.to_string())
            .unwrap_or_else(|| addr.to_ascii_uppercase());
        serde_wasm_bindgen::to_value(&CellSnapshotJSON {
            sheet: sheet_idx_usize,
            addr,
            display: value_to_display(&value),
            cell_type: value_to_cell_type(&value),
            is_error: value.is_error(),
            formula,
        })
        .map_err(|err| JsValue::from_str(&format!("serialize cell snapshot: {err}")))
    }

    pub fn debug_formula_cache_state(&self, sheet_idx: u32, addr: &str) -> String {
        self.workbook
            .debug_formula_cache_state(sheet_idx as usize, addr)
            .to_string()
    }

    /// Total formula evaluations performed across all workbook sheets since
    /// creation. Uses each sheet's `debug_formula_eval_count` without
    /// evaluating any formulas.
    pub fn debug_formula_eval_count_total(&self) -> u32 {
        let mut total = 0usize;
        for idx in 0..self.workbook.sheet_count() {
            total += self.workbook.debug_formula_eval_count(idx);
        }
        total as u32
    }

    /// Total formula records currently registered across all workbook sheets.
    /// This is a read-only aggregate, not a cell visit across sparse content.
    pub fn debug_formula_count(&self) -> u32 {
        (0..self.workbook.sheet_count())
            .map(|idx| {
                self.workbook
                    .sheet(idx)
                    .map(|sheet| sheet.debug_formula_count())
                    .unwrap_or(0)
            })
            .sum::<usize>() as u32
    }

    /// Total number of live workbook subscription tokens currently held
    /// in the workbook bookkeeping map.
    pub fn debug_live_subscription_count(&self) -> u32 {
        self.subscriptions.len() as u32
    }

    /// Number of live `Sheet` listeners for a specific sheet. This
    /// includes only currently subscribed addresses and maps to the same
    /// contract as `Sheet::debug_live_subscription_count`.
    pub fn debug_sheet_live_subscription_count(&self, sheet_idx: u32) -> u32 {
        self.workbook
            .sheet(sheet_idx as usize)
            .map(|sheet| sheet.debug_live_subscription_count())
            .unwrap_or(0) as u32
    }

    /// Number of formula records currently registered on one workbook sheet.
    /// Returns `0` for missing sheet indexes.
    pub fn debug_sheet_formula_count(&self, sheet_idx: u32) -> u32 {
        self.workbook
            .sheet(sheet_idx as usize)
            .map(|sheet| sheet.debug_formula_count())
            .unwrap_or(0) as u32
    }

    /// Total formula evaluations performed on one workbook sheet since
    /// creation. Used by worker-backed lazy import/read tests.
    pub fn debug_formula_eval_count(&self, sheet_idx: u32) -> u32 {
        self.workbook.debug_formula_eval_count(sheet_idx as usize) as u32
    }

    // === Phase 3 / Track K — workbook mutators ===
    //
    // These mirror `WasmSheet::set_*` / `clear_cell` / `set_formula` but
    // take an explicit `sheet_idx`. They are the JS-facing entry points
    // for Phase 3's "writes go through Workbook" architecture (see
    // `rust/docs/PHASE3_PARALLEL.md` § Architectural Decision).
    //
    // Phase 5 Track A: the legacy JS-facing `set_number` / `set_text` /
    // `set_boolean` / `set_error` / `clear_cell` methods above now route
    // through the same workbook-aware mutators as these canonical aliases.
    // Keep the aliases for new worker code and future generated bindings;
    // keep the legacy names for existing demos/tests that already compile
    // against the older wasm-pack surface.

    /// Set a cell to a numeric value through the workbook. Routes
    /// through `Workbook::set_cell` so cross-sheet dependents dirty
    /// + fire their subscribers via the workbook's BFS.
    pub fn set_cell_number(&mut self, sheet_idx: usize, addr: &str, value: f64) {
        self.workbook
            .set_cell(sheet_idx, addr, Value::Number(value));
    }

    /// Set a cell to a text value through the workbook. Cross-sheet aware.
    pub fn set_cell_text(&mut self, sheet_idx: usize, addr: &str, value: &str) {
        self.workbook
            .set_cell(sheet_idx, addr, Value::Text(value.to_string()));
    }

    /// Set a cell to a boolean value through the workbook. Cross-sheet aware.
    pub fn set_cell_boolean(&mut self, sheet_idx: usize, addr: &str, value: bool) {
        self.workbook
            .set_cell(sheet_idx, addr, Value::Boolean(value));
    }

    /// Set a cell to an error value through the workbook. Cross-sheet aware.
    pub fn set_cell_error(&mut self, sheet_idx: usize, addr: &str, value: &str) {
        let err = value_error_from_display(value);
        self.workbook.set_cell(sheet_idx, addr, Value::Error(err));
    }

    /// Clear a cell through the workbook. Cross-sheet aware — a cleared
    /// upstream cell still propagates dirty to its dependents.
    #[wasm_bindgen(js_name = "clearCellAt")]
    pub fn clear_cell_at(&mut self, sheet_idx: usize, addr: &str) {
        self.workbook.clear_cell(sheet_idx, addr);
    }

    /// Set a cell's formula through the workbook. Returns `true` if the
    /// formula parsed and installed cleanly, `false` if parse failed
    /// (cell becomes `#VALUE!`) or a cycle was detected (cell becomes
    /// `#CYCLE!`).
    ///
    /// Note: the legacy `WasmWorkbook::set_formula(sheet_idx: u32, ...)`
    /// already routes through `Workbook::set_formula`, which is the
    /// Track I target. This `usize`-typed variant is the new Phase 3
    /// canonical entry; both can coexist during the migration.
    #[wasm_bindgen(js_name = "setFormulaAt")]
    pub fn set_formula_at(&mut self, sheet_idx: usize, addr: &str, src: &str) -> bool {
        self.workbook.set_formula(sheet_idx, addr, src)
    }

    /// Read a cell's display string through the workbook eval path.
    /// Convenience wrapper around `get_display(u32, ...)` with `usize`
    /// for the Phase 3 canonical API shape. The `&mut self` receiver
    /// future-proofs against `Workbook::get_cell` requiring a mutable
    /// borrow once cache promotion lands on the workbook eval provider —
    /// today it is read-only, but flipping the underlying signature
    /// must not break the JS API.
    #[wasm_bindgen(js_name = "getCellDisplay")]
    pub fn get_cell_display(&mut self, sheet_idx: usize, addr: &str) -> String {
        let Some(name) = self.workbook.name(sheet_idx).map(str::to_string) else {
            return String::new();
        };
        let val = self.workbook.get_cell(&name, addr);
        value_to_display(&val)
    }

    /// Subscribe to a cell at `sheet_name!addr`. Returns an opaque
    /// `u32` token; pass it back to `unsubscribe_cell` to cancel.
    ///
    /// First-cut wiring: the JS callback is registered on the underlying
    /// `Sheet` via `Sheet::subscribe_cell_boxed`, so same-sheet writes
    /// fire correctly today. The token + `(sheet_idx, addr)` is also
    /// recorded on the workbook so that once Track I lands the
    /// cross-sheet dirty BFS, that BFS can look up this map and fire
    /// JS callbacks for cells that were dirtied via a write on a
    /// different sheet.
    pub fn subscribe_cell(&mut self, sheet_name: &str, addr: &str, cb: js_sys::Function) -> u32 {
        let Some(sheet_idx) = self.workbook.index_of(sheet_name) else {
            // Unknown sheet — hand back a token that is never inserted,
            // mirroring `unsubscribe_cell`'s idempotent posture. Caller
            // can `unsubscribe_cell(token)` safely as a no-op.
            let token = self.next_token;
            self.next_token = self.next_token.wrapping_add(1);
            return token;
        };
        let parsed_addr = match CellAddress::parse(addr) {
            Some(a) => a,
            None => {
                let token = self.next_token;
                self.next_token = self.next_token.wrapping_add(1);
                return token;
            }
        };

        let token = self.next_token;
        self.next_token = self.next_token.wrapping_add(1);

        let listener = JsCallbackListener { callback: cb };
        let Some(sheet) = self.workbook.sheet_mut(sheet_idx) else {
            return token;
        };
        let sub = sheet.subscribe_cell_boxed(addr, Box::new(listener));
        self.subscriptions.insert(
            token,
            WorkbookCellSubscription {
                sheet_idx,
                addr: parsed_addr,
                sub,
            },
        );
        token
    }

    /// Cancel a subscription previously returned from `subscribe_cell`.
    /// Idempotent: unknown / stale tokens are silently ignored.
    pub fn unsubscribe_cell(&mut self, token: u32) {
        if let Some(entry) = self.subscriptions.remove(&token) {
            if let Some(sheet) = self.workbook.sheet_mut(entry.sheet_idx) {
                sheet.unsubscribe_cell(entry.sub);
            }
        }
    }

    /// Number of cross-sheet dependent edges currently tracked on the
    /// workbook. Track L's e2e gates fan-out correctness through this
    /// probe.
    ///
    /// Delegates to `Workbook::debug_cross_sheet_reverse_edge_count` —
    /// counts entries in the workbook's cross-sheet reverse dep index.
    pub fn debug_cross_sheet_dependents_count(&self) -> u32 {
        self.workbook.debug_cross_sheet_reverse_edge_count() as u32
    }

    /// Batch import plain JSON cell records through `Workbook::bulk_load`.
    ///
    /// Coordinates are zero-based (`row=0, col=0` means A1). Formula cells
    /// are installed dirty and remain lazy until a read/subscription hydrates
    /// them through the normal workbook eval path.
    pub fn bulk_import_cells(&mut self, cells: JsValue) -> Result<JsValue, JsValue> {
        let cells: Vec<WorkbookImportCellJSON> = serde_wasm_bindgen::from_value(cells)
            .map_err(|err| JsValue::from_str(&format!("invalid import cells: {err}")))?;

        let mut stats = WorkbookImportStatsJSON::default();
        let sheet_count = self.workbook.sheet_count();
        self.workbook.bulk_load(|loader| {
            for cell in cells {
                let kind = match &cell.kind {
                    BulkImportKindJSON::Text(kind) => kind.clone(),
                    BulkImportKindJSON::Invalid => {
                        stats.errors += 1;
                        stats.push_issue(&cell, "", "INVALID_KIND", "cell kind must be a string");
                        continue;
                    }
                };
                let kind = kind.as_str();
                if cell.sheet >= sheet_count {
                    stats.errors += 1;
                    stats.push_issue(
                        &cell,
                        kind,
                        "SHEET_OUT_OF_RANGE",
                        "cell sheet index is outside the workbook",
                    );
                    continue;
                }
                let addr = CellAddress::new(cell.row, cell.col).to_string_repr();
                match kind {
                    "number" => match &cell.value {
                        Some(BulkImportValueJSON::Number(n)) if n.is_finite() => {
                            loader.set_cell(cell.sheet, &addr, Value::Number(*n));
                            stats.accepted += 1;
                        }
                        _ => {
                            stats.errors += 1;
                            stats.push_issue(
                                &cell,
                                kind,
                                "INVALID_VALUE",
                                "number cells require a numeric value",
                            );
                        }
                    },
                    "text" => match &cell.value {
                        Some(BulkImportValueJSON::Text(s)) => {
                            loader.set_cell(cell.sheet, &addr, Value::Text(s.clone()));
                            stats.accepted += 1;
                        }
                        _ => {
                            stats.errors += 1;
                            stats.push_issue(
                                &cell,
                                kind,
                                "INVALID_VALUE",
                                "text cells require a string value",
                            );
                        }
                    },
                    "boolean" => match &cell.value {
                        Some(BulkImportValueJSON::Boolean(b)) => {
                            loader.set_cell(cell.sheet, &addr, Value::Boolean(*b));
                            stats.accepted += 1;
                        }
                        _ => {
                            stats.errors += 1;
                            stats.push_issue(
                                &cell,
                                kind,
                                "INVALID_VALUE",
                                "boolean cells require a boolean value",
                            );
                        }
                    },
                    "error" => match &cell.value {
                        Some(BulkImportValueJSON::Text(s)) => {
                            loader.set_cell(
                                cell.sheet,
                                &addr,
                                Value::Error(value_error_from_display(s)),
                            );
                            stats.accepted += 1;
                        }
                        _ => {
                            stats.errors += 1;
                            stats.push_issue(
                                &cell,
                                kind,
                                "INVALID_VALUE",
                                "error cells require a string value",
                            );
                        }
                    },
                    "formula" => match &cell.value {
                        Some(BulkImportValueJSON::Text(s)) => {
                            stats.formulas += 1;
                            if loader.set_formula(cell.sheet, &addr, s) {
                                stats.accepted += 1;
                            } else {
                                stats.rejected_formulas += 1;
                                stats.push_issue(
                                    &cell,
                                    kind,
                                    "FORMULA_REJECTED",
                                    "formula was rejected by the workbook",
                                );
                            }
                        }
                        _ => {
                            stats.errors += 1;
                            stats.push_issue(
                                &cell,
                                kind,
                                "INVALID_VALUE",
                                "formula cells require a string value",
                            );
                        }
                    },
                    "null" => {
                        loader.clear_cell(cell.sheet, &addr);
                        stats.accepted += 1;
                        stats.cleared += 1;
                    }
                    _ => {
                        stats.errors += 1;
                        stats.push_issue(&cell, kind, "INVALID_KIND", "cell kind is not supported");
                    }
                }
            }
        });

        serde_wasm_bindgen::to_value(&stats)
            .map_err(|err| JsValue::from_str(&format!("serialize import stats: {err}")))
    }

    /// List every address that has a primitive value or formula across
    /// the workbook. This is metadata-only and does not evaluate formulas.
    pub fn list_non_empty_cells(&self) -> Result<JsValue, JsValue> {
        let mut out = Vec::new();
        for sheet_idx in 0..self.workbook.sheet_count() {
            let Some(sheet) = self.workbook.sheet(sheet_idx) else {
                continue;
            };
            sheet.for_each_non_empty(|addr| {
                out.push(CellRefJSON {
                    sheet: sheet_idx,
                    addr: addr.to_string(),
                });
            });
        }
        serde_wasm_bindgen::to_value(&out)
            .map_err(|err| JsValue::from_str(&format!("serialize non-empty cells: {err}")))
    }

    /// Snapshot sparse workbook contents without reading formula values.
    ///
    /// Formula cells serialize their source (`kind: "formula"`) and do
    /// not call the eval path, so dirty formula caches stay dirty.
    pub fn snapshot_sparse(&self) -> Result<JsValue, JsValue> {
        let out = self.snapshot_sparse_cells();
        serde_wasm_bindgen::to_value(&out)
            .map_err(|err| JsValue::from_str(&format!("serialize sparse snapshot: {err}")))
    }

    /// Snapshot non-empty cells in a zero-based inclusive range without
    /// reading formula values. Formula cells serialize their source and stay
    /// dirty/uncomputed, so this is safe for large-range undo.
    pub fn snapshot_range_sparse(
        &self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> Result<JsValue, JsValue> {
        let out =
            self.snapshot_range_sparse_cells(sheet_idx, start_row, start_col, end_row, end_col);
        serde_wasm_bindgen::to_value(&out)
            .map_err(|err| JsValue::from_str(&format!("serialize sparse range snapshot: {err}")))
    }

    /// Restore sparse cell records produced by `snapshot_sparse` or
    /// `snapshot_range_sparse`. Uses workbook bulk-load so formulas are
    /// reinstalled dirty and are not evaluated during restore.
    pub fn restore_sparse(&mut self, cells: JsValue) -> Result<u32, JsValue> {
        let cells: Vec<SparseCellJSON> = serde_wasm_bindgen::from_value(cells)
            .map_err(|err| JsValue::from_str(&format!("invalid sparse cells: {err}")))?;
        Ok(self.restore_sparse_cells(cells))
    }

    /// Read non-empty cells in a zero-based inclusive range. This is an
    /// explicit read/export path, so formula cells in the range may be
    /// evaluated and promoted to clean cache state.
    pub fn read_sparse_range(
        &self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> Result<JsValue, JsValue> {
        let sheet_idx = sheet_idx as usize;
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        let mut out = Vec::new();
        self.workbook
            .for_each_sparse_range_cell(sheet_idx, range, |addr, value| {
                let addr_str = addr.to_string();
                let formula = self
                    .workbook
                    .sheet(sheet_idx)
                    .and_then(|sheet| sheet.get_formula(&addr_str))
                    .unwrap_or_default();
                out.push(CellSnapshotJSON {
                    sheet: sheet_idx,
                    addr: addr_str,
                    display: value_to_display(&value),
                    cell_type: value_to_cell_type(&value),
                    is_error: value.is_error(),
                    formula,
                });
            });
        serde_wasm_bindgen::to_value(&out)
            .map_err(|err| JsValue::from_str(&format!("serialize sparse range: {err}")))
    }

    /// Clear non-empty cells in a zero-based inclusive range. The Rust
    /// core scans only sparse entries inside the range and does not
    /// evaluate formulas while finding cells to clear.
    pub fn clear_range(
        &mut self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> u32 {
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        self.workbook.clear_range(sheet_idx as usize, range) as u32
    }

    /// Set a range format without materializing empty cells. The core stores
    /// a sparse range-format layer and only notifies addresses that are
    /// already subscribed.
    pub fn set_format_range(
        &mut self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        fmt: JsValue,
    ) -> Result<u32, JsValue> {
        let parsed: CellFormatJSON = if fmt.is_undefined() || fmt.is_null() {
            CellFormatJSON::default()
        } else {
            serde_wasm_bindgen::from_value(fmt)
                .map_err(|e| JsValue::from_str(&format!("invalid CellFormat: {e}")))?
        };
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        let sheet = self
            .workbook
            .sheet_mut(sheet_idx as usize)
            .ok_or_else(|| JsValue::from_str(&format!("invalid sheet index: {sheet_idx}")))?;
        Ok(sheet.set_format_range(range, parsed.into_format()) as u32)
    }

    /// Snapshot sparse formatting metadata for a workbook sheet. The
    /// snapshot is metadata-only and safe for lazy formula caches.
    pub fn snapshot_format_range(
        &self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> Result<JsValue, JsValue> {
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        let sheet = self
            .workbook
            .sheet(sheet_idx as usize)
            .ok_or_else(|| JsValue::from_str(&format!("invalid sheet index: {sheet_idx}")))?;
        let snapshot = sheet.snapshot_format_range(range);
        serde_wasm_bindgen::to_value(&FormatRangeSnapshotJSON::from_snapshot(
            &snapshot,
            Some(sheet_idx),
        ))
        .map_err(|err| JsValue::from_str(&format!("serialize format range snapshot: {err}")))
    }

    /// Restore a formatting snapshot produced by `snapshot_format_range`.
    pub fn restore_format_snapshot(&mut self, snapshot: JsValue) -> Result<u32, JsValue> {
        let snapshot: FormatRangeSnapshotJSON = serde_wasm_bindgen::from_value(snapshot)
            .map_err(|err| JsValue::from_str(&format!("invalid format range snapshot: {err}")))?;
        let sheet_idx = snapshot.sheet.unwrap_or(0);
        let snapshot = snapshot.into_snapshot()?;
        let sheet = self
            .workbook
            .sheet_mut(sheet_idx as usize)
            .ok_or_else(|| JsValue::from_str(&format!("invalid sheet index: {sheet_idx}")))?;
        Ok(sheet.restore_format_range_snapshot(snapshot) as u32)
    }

    /// Snapshot workbook state as persistence-v1 sparse envelope.
    ///
    /// Format metadata includes range-format and in-range cell formats from each
    /// sheet snapshot, but does not serialize any dense grid materialization.
    /// Formula cells are serialized using their source (`=...`), preserving lazy
    /// evaluation contracts during restore.
    pub fn snapshot_persistence_v1(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.snapshot_persistence_v1_json())
            .map_err(|err| JsValue::from_str(&format!("serialize persistence v1 snapshot: {err}")))
    }

    /// Restore a persistence-v1 sparse envelope into this workbook.
    ///
    /// Returns simple restore stats for quick assertions.
    pub fn restore_persistence_v1(&mut self, value: JsValue) -> Result<JsValue, JsValue> {
        let payload: WorkbookPersistenceV1JSON = serde_wasm_bindgen::from_value(value)
            .map_err(|err| JsValue::from_str(&format!("invalid persistence payload: {err}")))?;
        let stats = self
            .restore_persistence_v1_json(payload)
            .map_err(|err| JsValue::from_str(&err))?;
        serde_wasm_bindgen::to_value(&stats).map_err(|err| {
            JsValue::from_str(&format!("serialize persistence restore stats: {err}"))
        })
    }
}

impl Default for WasmWorkbook {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmWorkbook {
    fn workbook_value(&self, sheet_idx: u32, addr: &str) -> Value {
        let Some(name) = self.workbook.name(sheet_idx as usize) else {
            return Value::Null;
        };
        self.workbook.get_cell(name, addr)
    }

    fn snapshot_persistence_v1_json(&self) -> WorkbookPersistenceV1JSON {
        let mut sheets = Vec::with_capacity(self.workbook.sheet_count());
        let mut formats = Vec::with_capacity(self.workbook.sheet_count());

        for sheet_idx in 0..self.workbook.sheet_count() {
            let Some(sheet) = self.workbook.sheet(sheet_idx) else {
                continue;
            };

            let (row_count, col_count) = self.sheet_sparse_bounds(sheet_idx);
            let name = self
                .workbook
                .name(sheet_idx)
                .map(str::to_string)
                .unwrap_or_default();
            sheets.push(WorkbookPersistenceSheetMetaJSON {
                idx: sheet_idx as u32,
                name,
                row_count,
                col_count,
            });

            let snapshot = sheet.snapshot_format_range(Self::full_sheet_range());
            formats.push(FormatRangeSnapshotJSON::from_snapshot(
                &snapshot,
                Some(sheet_idx as u32),
            ));
        }

        WorkbookPersistenceV1JSON {
            version: 1,
            sheets,
            cells: self.snapshot_sparse_cells(),
            formats,
        }
    }

    fn restore_persistence_v1_json(
        &mut self,
        payload: WorkbookPersistenceV1JSON,
    ) -> Result<WorkbookPersistenceRestoreStatsJSON, String> {
        if payload.version != 1 {
            return Err(format!(
                "unsupported persistence version: {}",
                payload.version
            ));
        }

        if payload.sheets.is_empty() {
            return Err("persistence payload has no sheets".into());
        }

        let mut seen_names = HashSet::new();
        for (idx, sheet) in payload.sheets.iter().enumerate() {
            if sheet.idx != idx as u32 {
                return Err(format!(
                    "sheet indices are not contiguous from 0: expected {idx}, got {}",
                    sheet.idx
                ));
            }
            if !seen_names.insert(sheet.name.clone()) {
                return Err(format!("duplicate sheet name in payload: {}", sheet.name));
            }
        }

        let sheet_count = payload.sheets.len();
        let mut format_snapshots = Vec::with_capacity(payload.formats.len());
        for snapshot in payload.formats {
            let sheet_idx = snapshot
                .sheet
                .ok_or_else(|| "format snapshot is missing sheet index".to_string())?
                as usize;
            if sheet_idx >= sheet_count {
                return Err(format!(
                    "format snapshot references missing sheet: {sheet_idx}"
                ));
            }
            let snapshot = snapshot
                .into_snapshot()
                .map_err(|_| "invalid format snapshot".to_string())?;
            format_snapshots.push((sheet_idx, snapshot));
        }

        let mut workbook = Workbook::new();
        let first_name = payload.sheets[0].name.clone();
        let first_sheet_already_named = workbook.name(0) == Some(first_name.as_str());
        if !first_sheet_already_named && !workbook.rename_sheet(0, &first_name) {
            return Err(format!(
                "failed to initialize first sheet name: {}",
                first_name
            ));
        }
        for sheet in payload.sheets.iter().skip(1) {
            workbook.add_sheet(&sheet.name);
        }

        self.subscriptions.clear();
        self.next_token = 0;
        self.workbook = workbook;

        let restored_cells = self.restore_sparse_cells(payload.cells);
        let mut restored_formats = 0u32;
        for (sheet_idx, snapshot) in format_snapshots {
            let sheet = self
                .workbook
                .sheet_mut(sheet_idx)
                .ok_or_else(|| format!("invalid sheet index: {sheet_idx}"))?;
            restored_formats += sheet.restore_format_range_snapshot(snapshot) as u32;
        }

        let stats = WorkbookPersistenceRestoreStatsJSON {
            restored_cells,
            restored_formats,
            sheets: payload.sheets.len() as u32,
        };
        Ok(stats)
    }

    fn snapshot_sparse_cells(&self) -> Vec<SparseCellJSON> {
        let mut out = Vec::new();
        for sheet_idx in 0..self.workbook.sheet_count() {
            let Some(sheet) = self.workbook.sheet(sheet_idx) else {
                continue;
            };
            sheet.for_each_non_empty(|addr| {
                if let Some(cell) = sparse_cell_from_sheet_no_eval(sheet_idx, sheet, addr) {
                    out.push(cell);
                }
            });
        }
        out
    }

    fn snapshot_range_sparse_cells(
        &self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    ) -> Vec<SparseCellJSON> {
        let sheet_idx = sheet_idx as usize;
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        let mut out = Vec::new();
        if let Some(sheet) = self.workbook.sheet(sheet_idx) {
            sheet.for_each_non_empty_in_range(range, |addr| {
                if let Some(cell) = sparse_cell_from_sheet_no_eval(sheet_idx, sheet, addr) {
                    out.push(cell);
                }
            });
        }
        out
    }

    fn sheet_sparse_bounds(&self, sheet_idx: usize) -> (Option<u32>, Option<u32>) {
        let mut max_row = 0u32;
        let mut max_col = 0u32;
        let mut found = false;

        let Some(sheet) = self.workbook.sheet(sheet_idx) else {
            return (None, None);
        };
        sheet.for_each_non_empty(|addr| {
            found = true;
            max_row = max_row.max(addr.row);
            max_col = max_col.max(addr.col);
        });
        if !found {
            return (None, None);
        }
        (
            Some(max_row.saturating_add(1)),
            Some(max_col.saturating_add(1)),
        )
    }

    fn full_sheet_range() -> CellRange {
        CellRange::new(CellAddress::new(0, 0), CellAddress::new(u32::MAX, u32::MAX))
    }

    fn restore_sparse_cells(&mut self, cells: Vec<SparseCellJSON>) -> u32 {
        let sheet_count = self.workbook.sheet_count();
        let mut restored = 0u32;
        self.workbook.bulk_load(|loader| {
            for cell in cells {
                if cell.sheet >= sheet_count {
                    continue;
                }
                let addr = CellAddress::new(cell.row, cell.col).to_string_repr();
                match cell.kind.as_str() {
                    "number" => {
                        if let Some(ImportValueJSON::Number(n)) = cell.value {
                            if n.is_finite() {
                                loader.set_cell(cell.sheet, &addr, Value::Number(n));
                                restored += 1;
                            }
                        }
                    }
                    "text" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            loader.set_cell(cell.sheet, &addr, Value::Text(s));
                            restored += 1;
                        }
                    }
                    "boolean" => {
                        if let Some(ImportValueJSON::Boolean(b)) = cell.value {
                            loader.set_cell(cell.sheet, &addr, Value::Boolean(b));
                            restored += 1;
                        }
                    }
                    "error" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            loader.set_cell(
                                cell.sheet,
                                &addr,
                                Value::Error(value_error_from_display(&s)),
                            );
                            restored += 1;
                        }
                    }
                    "formula" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            if loader.set_formula(cell.sheet, &addr, &s) {
                                restored += 1;
                            }
                        }
                    }
                    "null" => {
                        loader.clear_cell(cell.sheet, &addr);
                        restored += 1;
                    }
                    _ => {}
                }
            }
        });
        restored
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

fn value_to_cell_type(val: &Value) -> String {
    match val {
        Value::Number(_) => "number",
        Value::Text(_) => "text",
        Value::Boolean(_) => "boolean",
        Value::Null => "null",
        Value::Error(_) => "error",
    }
    .into()
}

fn sparse_cell_from_value(sheet: usize, addr: CellAddress, val: &Value) -> Option<SparseCellJSON> {
    let (kind, value) = match val {
        Value::Number(n) => ("number", Some(ImportValueJSON::Number(*n))),
        Value::Text(s) => ("text", Some(ImportValueJSON::Text(s.clone()))),
        Value::Boolean(b) => ("boolean", Some(ImportValueJSON::Boolean(*b))),
        Value::Error(e) => ("error", Some(ImportValueJSON::Text(format!("{}", e)))),
        Value::Null => return None,
    };
    Some(SparseCellJSON {
        sheet,
        addr: addr.to_string(),
        row: addr.row,
        col: addr.col,
        kind: kind.into(),
        value,
    })
}

fn sparse_cell_from_sheet_no_eval(
    sheet_idx: usize,
    sheet: &Sheet,
    addr: CellAddress,
) -> Option<SparseCellJSON> {
    let addr_str = addr.to_string();
    if let Some(formula) = sheet.get_formula(&addr_str) {
        return Some(SparseCellJSON {
            sheet: sheet_idx,
            addr: addr_str,
            row: addr.row,
            col: addr.col,
            kind: "formula".into(),
            value: Some(ImportValueJSON::Text(formula)),
        });
    }

    sparse_cell_from_value(sheet_idx, addr, &sheet.peek_value(addr))
}

fn value_error_from_display(value: &str) -> ValueError {
    match value {
        "#DIV/0!" => ValueError::DivisionByZero,
        "#REF!" => ValueError::InvalidRef,
        "#NAME?" => ValueError::InvalidName,
        "#CYCLE!" => ValueError::CyclicRef,
        _ => ValueError::InvalidValue,
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
    fn wasm_sheet_transitive_formula_chain_updates() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 5.0);
        sheet.set_formula("B1", "=A1*2");
        sheet.set_formula("C1", "=B1+1");
        assert_eq!(sheet.get_number("C1"), 11.0);

        sheet.set_number("A1", 7.0);
        assert_eq!(sheet.get_number("C1"), 15.0);
    }

    #[test]
    fn wasm_sheet_clear_range_clears_sparse_hits() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 1.0);
        sheet.set_number("C3", 3.0);
        sheet.set_formula("D1", "=A1+1");
        assert_eq!(sheet.get_display("D1"), "2");

        assert_eq!(sheet.clear_range(0, 0, 1, 1), 1);

        assert_eq!(sheet.get_type("A1"), "null");
        assert_eq!(sheet.get_display("C3"), "3");
        assert_eq!(sheet.get_display("D1"), "1");
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
    fn wasm_workbook_move_sheet_preserves_cross_sheet_chain() {
        let mut wb = WasmWorkbook::new();
        wb.add_sheet("Sheet2");
        wb.add_sheet("Sheet3");

        wb.set_number(0, "B4", 10.0);
        assert!(wb.set_formula(2, "C2", "=Sheet1!B4+1"));
        assert!(wb.set_formula(1, "C2", "=Sheet3!C2+1"));
        assert!(wb.set_formula(0, "C2", "=Sheet2!C2+1"));

        assert_eq!(wb.get_number(0, "C2"), 13.0);
        assert!(wb.move_sheet(2, 0));
        assert_eq!(wb.sheet_name(0), "Sheet3");
        assert_eq!(wb.sheet_name(1), "Sheet1");
        assert_eq!(wb.sheet_name(2), "Sheet2");
        assert_eq!(wb.get_number(1, "C2"), 13.0);

        wb.set_number(1, "B4", 20.0);
        assert_eq!(wb.debug_formula_cache_state(0, "C2"), "dirty");
        assert_eq!(wb.debug_formula_cache_state(2, "C2"), "dirty");
        assert_eq!(wb.debug_formula_cache_state(1, "C2"), "dirty");
        assert_eq!(wb.get_number(1, "C2"), 23.0);
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

    #[test]
    fn wasm_workbook_snapshot_range_sparse_does_not_eval_formula() {
        let mut wb = WasmWorkbook::new();
        wb.set_number(0, "A1", 41.0);
        assert!(wb.set_formula(0, "C5", "=A1+1"));

        assert_eq!(wb.debug_formula_cache_state(0, "C5"), "dirty");
        assert_eq!(wb.debug_formula_eval_count(0), 0);

        let cells = wb.snapshot_range_sparse_cells(0, 4, 2, 4, 2);

        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].addr, "C5");
        assert_eq!(cells[0].kind, "formula");
        match &cells[0].value {
            Some(ImportValueJSON::Text(source)) => assert_eq!(source, "=A1+1"),
            other => panic!("unexpected sparse formula value: {other:?}"),
        }
        assert_eq!(wb.debug_formula_cache_state(0, "C5"), "dirty");
        assert_eq!(wb.debug_formula_eval_count(0), 0);
    }

    #[test]
    fn wasm_workbook_restore_sparse_reinstalls_formulas_dirty() {
        let mut wb = WasmWorkbook::new();
        wb.set_number(0, "A1", 5.0);
        wb.set_text(0, "A2", "hello");
        assert!(wb.set_formula(0, "B2", "=A1+1"));

        let cells = wb.snapshot_range_sparse_cells(0, 0, 0, 1, 1);
        assert_eq!(cells.len(), 3);

        assert_eq!(wb.clear_range(0, 0, 0, 1, 1), 3);
        assert_eq!(wb.get_type(0, "A1"), "null");
        assert_eq!(wb.get_formula(0, "B2"), "");

        assert_eq!(wb.restore_sparse_cells(cells), 3);
        assert_eq!(wb.get_display(0, "A1"), "5");
        assert_eq!(wb.get_display(0, "A2"), "hello");
        assert_eq!(wb.get_formula(0, "B2"), "=A1+1");
        assert_eq!(wb.debug_formula_cache_state(0, "B2"), "dirty");
        assert_eq!(wb.debug_formula_eval_count(0), 0);

        assert_eq!(wb.get_display(0, "B2"), "6");
        assert_eq!(wb.debug_formula_cache_state(0, "B2"), "clean");
        assert_eq!(wb.debug_formula_eval_count(0), 1);
    }

    #[test]
    fn wasm_workbook_snapshot_persistence_v1_roundtrip_sparse_formula_and_formats() {
        let mut source = WasmWorkbook::new();
        assert!(source.rename_sheet(0, "Data"));
        let _ = source.add_sheet("Calc");

        source.set_number(0, "A1", 10.0);
        source.set_text(0, "B2", "hello");
        assert!(source.set_formula(0, "C3", "=A1+1"));
        source.set_number(1, "A1", 100.0);

        let number_fmt = CellFormatJSON {
            number_format: Some(NumberFormatJSON {
                kind: "decimal".into(),
                digits: Some(2),
                symbol: None,
                pattern: None,
                thousands: Some(true),
            }),
            bold: None,
            italic: None,
            align: None,
            font_size: None,
            fg_color: None,
            bg_color: None,
        };
        source.workbook.sheet_mut(0).unwrap().set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(2, 0)),
            number_fmt.clone().into_format(),
        );

        assert_eq!(source.debug_formula_cache_state(0, "C3"), "dirty");
        assert_eq!(source.debug_formula_eval_count(0), 0);

        let envelope = source.snapshot_persistence_v1_json();

        assert_eq!(envelope.version, 1);
        assert_eq!(envelope.sheets.len(), 2);
        assert_eq!(envelope.sheets[0].idx, 0);
        assert_eq!(envelope.sheets[0].name, "Data");
        assert_eq!(envelope.sheets[0].row_count, Some(3));
        assert_eq!(envelope.sheets[0].col_count, Some(3));
        assert_eq!(envelope.sheets[1].name, "Calc");
        assert_eq!(envelope.sheets[1].row_count, Some(1));
        assert_eq!(envelope.sheets[1].col_count, Some(1));

        let formula_cell = envelope
            .cells
            .iter()
            .find(|cell| cell.sheet == 0 && cell.addr == "C3")
            .expect("formula cell should be included");
        assert_eq!(formula_cell.kind, "formula");
        match &formula_cell.value {
            Some(ImportValueJSON::Text(source)) => assert_eq!(source, "=A1+1"),
            other => panic!("expected formula source in persistence payload: {other:?}"),
        }

        assert_eq!(envelope.formats.len(), 2);

        let mut restored = WasmWorkbook::new();
        let stats = restored.restore_persistence_v1_json(envelope).unwrap();

        assert_eq!(stats.sheets, 2);
        assert_eq!(stats.restored_cells, 4);

        assert_eq!(restored.sheet_name(0), "Data");
        assert_eq!(restored.sheet_name(1), "Calc");
        assert_eq!(restored.get_number(0, "A1"), 10.0);
        assert_eq!(restored.get_display(0, "B2"), "hello");
        assert_eq!(restored.get_formula(0, "C3"), "=A1+1");
        assert_eq!(restored.debug_formula_cache_state(0, "C3"), "dirty");
        assert_eq!(restored.debug_formula_eval_count(0), 0);
        assert_eq!(restored.get_number(0, "C3"), 11.0);
        assert_eq!(restored.debug_formula_cache_state(0, "C3"), "clean");
        assert_eq!(restored.debug_formula_eval_count(0), 1);
        assert_eq!(restored.get_number(1, "A1"), 100.0);

        let restored_fmt =
            restored
                .workbook
                .sheet(0)
                .unwrap()
                .snapshot_format_range(CellRange::new(
                    CellAddress::new(0, 0),
                    CellAddress::new(2, 0),
                ));
        assert_eq!(restored_fmt.range_formats.len(), 1);
        assert!(matches!(
            restored_fmt.range_formats[0].fmt.number_format,
            NumberFormat::Decimal {
                digits: 2,
                thousands: true
            }
        ));
    }

    #[test]
    fn wasm_workbook_snapshot_persistence_v1_uses_sparse_dimensions_only() {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("FormatOnly");
        let fmt = CellFormatJSON {
            number_format: Some(NumberFormatJSON {
                kind: "percent".into(),
                digits: Some(0),
                symbol: None,
                pattern: None,
                thousands: None,
            }),
            bold: None,
            italic: None,
            align: None,
            font_size: None,
            fg_color: None,
            bg_color: None,
        };
        wb.workbook.sheet_mut(1).unwrap().set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(4, 4)),
            fmt.into_format(),
        );

        let envelope = wb.snapshot_persistence_v1_json();
        assert_eq!(envelope.sheets.len(), 2);
        assert_eq!(envelope.sheets[0].row_count, None);
        assert_eq!(envelope.sheets[0].col_count, None);
        assert_eq!(envelope.sheets[1].row_count, None);
        assert_eq!(envelope.sheets[1].col_count, None);
        assert_eq!(envelope.formats[1].range_formats.len(), 1);
    }

    #[test]
    fn wasm_workbook_restore_persistence_v1_rejects_unsupported_version() {
        let mut wb = WasmWorkbook::new();
        let payload = WorkbookPersistenceV1JSON {
            version: 2,
            sheets: vec![WorkbookPersistenceSheetMetaJSON {
                idx: 0,
                name: "Sheet1".into(),
                row_count: None,
                col_count: None,
            }],
            cells: vec![],
            formats: vec![],
        };
        assert!(wb.restore_persistence_v1_json(payload).is_err());
    }

    #[test]
    fn wasm_workbook_restore_persistence_v1_accepts_default_sheet_name() {
        let mut wb = WasmWorkbook::new();
        assert!(wb.rename_sheet(0, "Old"));

        let payload = WorkbookPersistenceV1JSON {
            version: 1,
            sheets: vec![WorkbookPersistenceSheetMetaJSON {
                idx: 0,
                name: "Sheet1".into(),
                row_count: None,
                col_count: None,
            }],
            cells: vec![SparseCellJSON {
                sheet: 0,
                addr: "A1".into(),
                row: 0,
                col: 0,
                kind: "number".into(),
                value: Some(ImportValueJSON::Number(42.0)),
            }],
            formats: vec![],
        };

        let stats = wb.restore_persistence_v1_json(payload).unwrap();
        assert_eq!(stats.restored_cells, 1);
        assert_eq!(wb.sheet_name(0), "Sheet1");
        assert_eq!(wb.get_number(0, "A1"), 42.0);
    }

    #[test]
    fn wasm_workbook_restore_persistence_v1_rejects_bad_format_without_mutating_workbook() {
        let mut wb = WasmWorkbook::new();
        assert!(wb.rename_sheet(0, "Keep"));
        wb.set_number(0, "A1", 7.0);

        let payload = WorkbookPersistenceV1JSON {
            version: 1,
            sheets: vec![WorkbookPersistenceSheetMetaJSON {
                idx: 0,
                name: "Loaded".into(),
                row_count: None,
                col_count: None,
            }],
            cells: vec![SparseCellJSON {
                sheet: 0,
                addr: "A1".into(),
                row: 0,
                col: 0,
                kind: "number".into(),
                value: Some(ImportValueJSON::Number(99.0)),
            }],
            formats: vec![FormatRangeSnapshotJSON {
                sheet: Some(1),
                start_row: 0,
                start_col: 0,
                end_row: 0,
                end_col: 0,
                cell_formats: vec![],
                range_formats: vec![],
            }],
        };

        assert!(wb.restore_persistence_v1_json(payload).is_err());
        assert_eq!(wb.sheet_name(0), "Keep");
        assert_eq!(wb.get_number(0, "A1"), 7.0);
    }

    #[test]
    fn wasm_workbook_restore_persistence_v1_resets_subscription_tokens() {
        let mut wb = WasmWorkbook::new();
        wb.next_token = 42;

        let payload = WorkbookPersistenceV1JSON {
            version: 1,
            sheets: vec![WorkbookPersistenceSheetMetaJSON {
                idx: 0,
                name: "Loaded".into(),
                row_count: None,
                col_count: None,
            }],
            cells: vec![],
            formats: vec![],
        };

        let stats = wb.restore_persistence_v1_json(payload).unwrap();
        assert_eq!(stats.sheets, 1);
        assert_eq!(wb.next_token, 0);
        assert!(wb.subscriptions.is_empty());
    }

    #[test]
    fn wasm_workbook_debug_live_subscription_counters() {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Sheet2");
        let sub_a = wb
            .workbook
            .sheet_mut(0)
            .unwrap()
            .subscribe_cell("A1", || {});
        wb.subscriptions.insert(
            101,
            WorkbookCellSubscription {
                sheet_idx: 0,
                addr: CellAddress::parse("A1").unwrap(),
                sub: sub_a,
            },
        );

        let sub_b = wb
            .workbook
            .sheet_mut(1)
            .unwrap()
            .subscribe_cell("B2", || {});
        wb.subscriptions.insert(
            202,
            WorkbookCellSubscription {
                sheet_idx: 1,
                addr: CellAddress::parse("B2").unwrap(),
                sub: sub_b,
            },
        );

        assert_eq!(wb.debug_live_subscription_count(), 2);
        assert_eq!(wb.debug_sheet_live_subscription_count(0), 1);
        assert_eq!(wb.debug_sheet_live_subscription_count(1), 1);
        assert_eq!(wb.debug_sheet_live_subscription_count(5), 0);

        wb.unsubscribe_cell(101);
        assert_eq!(wb.debug_live_subscription_count(), 1);
        assert_eq!(wb.debug_sheet_live_subscription_count(0), 0);
        assert_eq!(wb.debug_sheet_live_subscription_count(1), 1);
    }

    #[test]
    fn wasm_workbook_move_sheet_remaps_subscription_indices() {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Sheet2");
        let sub = wb
            .workbook
            .sheet_mut(1)
            .unwrap()
            .subscribe_cell("B2", || {});
        wb.subscriptions.insert(
            202,
            WorkbookCellSubscription {
                sheet_idx: 1,
                addr: CellAddress::parse("B2").unwrap(),
                sub,
            },
        );

        assert_eq!(wb.debug_sheet_live_subscription_count(1), 1);
        assert!(wb.move_sheet(1, 0));
        assert_eq!(wb.sheet_name(0), "Sheet2");
        assert_eq!(wb.debug_live_subscription_count(), 1);
        assert_eq!(wb.debug_sheet_live_subscription_count(0), 1);
        assert_eq!(wb.debug_sheet_live_subscription_count(1), 0);

        wb.unsubscribe_cell(202);
        assert_eq!(wb.debug_live_subscription_count(), 0);
        assert_eq!(wb.debug_sheet_live_subscription_count(0), 0);
    }

    #[test]
    fn wasm_workbook_debug_formula_counters() {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Sheet2");

        assert_eq!(wb.debug_formula_count(), 0);
        assert_eq!(wb.debug_sheet_formula_count(0), 0);
        assert_eq!(wb.debug_sheet_formula_count(1), 0);
        assert_eq!(wb.debug_formula_eval_count_total(), 0);
        assert_eq!(wb.debug_formula_eval_count(0), 0);

        assert!(wb.set_formula(0, "A1", "=1"));
        assert!(wb.set_formula(1, "B1", "=10"));
        assert_eq!(wb.debug_sheet_formula_count(0), 1);
        assert_eq!(wb.debug_sheet_formula_count(1), 1);
        assert_eq!(wb.debug_formula_count(), 2);
        assert_eq!(wb.debug_formula_eval_count_total(), 0);

        assert_eq!(wb.get_number(0, "A1"), 1.0);
        assert_eq!(wb.get_number(1, "B1"), 10.0);
        assert_eq!(wb.debug_formula_eval_count(0), 1);
        assert_eq!(wb.debug_formula_eval_count(1), 1);
        assert_eq!(wb.debug_formula_eval_count_total(), 2);
    }
}
