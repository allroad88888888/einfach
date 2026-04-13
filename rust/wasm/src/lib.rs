use std::collections::HashMap;

use einfach_core::Value;
use einfach_excel_core::{export_snapshot_json_to_xlsx_bytes, Sheet, Workbook};
use wasm_bindgen::prelude::*;

/// WASM-exposed spreadsheet. Wraps the Rust Sheet.
#[wasm_bindgen]
pub struct WasmSheet {
    sheet: Sheet,
    /// JS callbacks indexed by subscription key (cell address string)
    listeners: HashMap<String, Vec<js_sys::Function>>,
}

#[wasm_bindgen]
pub struct WasmWorkbook {
    workbook: Workbook,
}

#[wasm_bindgen(js_name = exportWorkbookSnapshotToXlsx)]
pub fn export_workbook_snapshot_to_xlsx(payload: &str) -> Result<js_sys::Uint8Array, JsValue> {
    let bytes = export_workbook_snapshot_to_xlsx_bytes(payload)
        .map_err(|error| JsValue::from_str(&error))?;
    Ok(js_sys::Uint8Array::from(bytes.as_slice()))
}

fn export_workbook_snapshot_to_xlsx_bytes(payload: &str) -> Result<Vec<u8>, String> {
    export_snapshot_json_to_xlsx_bytes(payload)
}

#[wasm_bindgen]
impl WasmSheet {
    /// Create a new empty spreadsheet.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        WasmSheet {
            sheet: Sheet::new(),
            listeners: HashMap::new(),
        }
    }

    /// Set a cell to a numeric value.
    pub fn set_number(&mut self, addr: &str, value: f64) {
        let previous = self.snapshot_listener_values();
        self.sheet.set_cell(addr, Value::Number(value));
        self.fire_listeners(previous);
    }

    /// Set a cell to a text value.
    pub fn set_text(&mut self, addr: &str, value: &str) {
        let previous = self.snapshot_listener_values();
        self.sheet.set_cell(addr, Value::Text(value.to_string()));
        self.fire_listeners(previous);
    }

    /// Set a cell's formula (e.g. "=A1+B1").
    pub fn set_formula(&mut self, addr: &str, formula: &str) {
        let previous = self.snapshot_listener_values();
        self.sheet.set_formula(addr, formula);
        self.fire_listeners(previous);
    }

    /// Clear a cell back to Null.
    pub fn clear_cell(&mut self, addr: &str) {
        let previous = self.snapshot_listener_values();
        self.sheet.clear_cell(addr);
        self.fire_listeners(previous);
    }

    /// Get a cell's display value as a string.
    pub fn get_display(&mut self, addr: &str) -> String {
        let val = self.sheet.get_cell(addr);
        value_to_display(&val)
    }

    /// Get the original cell input used for editing.
    pub fn get_input(&self, addr: &str) -> String {
        self.sheet.get_input(addr)
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
    pub fn batch_set_numbers(&mut self, addrs: Vec<String>, values: Vec<f64>) -> bool {
        if addrs.len() != values.len() {
            return false;
        }

        let previous = self.snapshot_listener_values();
        let pairs: Vec<(&str, Value)> = addrs
            .iter()
            .zip(values.iter())
            .map(|(a, v)| (a.as_str(), Value::Number(*v)))
            .collect();
        self.sheet.batch_set(&pairs);
        self.fire_listeners(previous);
        true
    }

    /// Set multiple cells from raw Excel-like inputs.
    pub fn batch_set_inputs(&mut self, addrs: Vec<String>, inputs: Vec<String>) -> bool {
        if addrs.len() != inputs.len() {
            return false;
        }

        let previous = self.snapshot_listener_values();
        let pairs: Vec<(&str, &str)> = addrs
            .iter()
            .zip(inputs.iter())
            .map(|(addr, input)| (addr.as_str(), input.as_str()))
            .collect();
        self.sheet.batch_set_inputs(&pairs);
        self.fire_listeners(previous);
        true
    }

    /// Subscribe to changes on a cell. The callback is called whenever the cell value changes.
    pub fn subscribe(&mut self, addr: &str, callback: js_sys::Function) {
        self.listeners
            .entry(addr.to_string())
            .or_default()
            .push(callback);
    }

    fn snapshot_listener_values(&mut self) -> HashMap<String, Value> {
        let addrs: Vec<String> = self.listeners.keys().cloned().collect();
        let mut snapshot = HashMap::with_capacity(addrs.len());
        for addr in addrs {
            snapshot.insert(addr.clone(), self.sheet.get_cell(&addr));
        }
        snapshot
    }

    fn changed_listener_addrs(&mut self, previous: &HashMap<String, Value>) -> Vec<String> {
        let addrs: Vec<String> = self.listeners.keys().cloned().collect();
        let mut changed = Vec::new();

        for addr in addrs {
            let current = self.sheet.get_cell(&addr);
            if previous.get(&addr) != Some(&current) {
                changed.push(addr);
            }
        }

        changed
    }

    fn fire_listeners(&mut self, previous: HashMap<String, Value>) {
        for addr in self.changed_listener_addrs(&previous) {
            if let Some(callbacks) = self.listeners.get(&addr) {
                for callback in callbacks {
                    let _ = callback.call0(&JsValue::NULL);
                }
            }
        }
    }
}

#[wasm_bindgen]
impl WasmWorkbook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            workbook: Workbook::new(),
        }
    }

    pub fn sheet_count(&self) -> usize {
        self.workbook.sheet_count()
    }

    pub fn sheet_name(&self, index: usize) -> String {
        self.workbook.sheet_name(index).unwrap_or_default().to_string()
    }

    pub fn active_sheet_index(&self) -> usize {
        self.workbook.active_sheet_index()
    }

    pub fn set_active_sheet(&mut self, index: usize) -> bool {
        self.workbook.set_active_sheet(index)
    }

    pub fn add_sheet(&mut self, name: Option<String>) -> String {
        self.workbook.add_sheet(name.as_deref())
    }

    pub fn remove_sheet(&mut self, index: usize) -> bool {
        self.workbook.remove_sheet(index)
    }

    pub fn rename_sheet(&mut self, index: usize, next_name: &str) -> bool {
        self.workbook.rename_sheet(index, next_name)
    }

    pub fn set_number(&mut self, addr: &str, value: f64) {
        self.workbook.set_number(addr, value);
    }

    pub fn set_text(&mut self, addr: &str, value: &str) {
        self.workbook.set_text(addr, value);
    }

    pub fn set_formula(&mut self, addr: &str, formula: &str) {
        self.workbook.set_formula(addr, formula);
    }

    pub fn clear_cell(&mut self, addr: &str) {
        self.workbook.clear_cell(addr);
    }

    pub fn batch_set_inputs(&mut self, addrs: Vec<String>, inputs: Vec<String>) -> bool {
        if addrs.len() != inputs.len() {
            return false;
        }
        let pairs: Vec<(&str, &str)> = addrs
            .iter()
            .zip(inputs.iter())
            .map(|(addr, input)| (addr.as_str(), input.as_str()))
            .collect();
        self.workbook.batch_set_inputs(&pairs);
        true
    }

    pub fn get_display(&self, addr: &str) -> String {
        value_to_display(&self.workbook.get_cell(addr))
    }

    pub fn get_input(&self, addr: &str) -> String {
        self.workbook.get_input(addr)
    }

    pub fn get_number(&self, addr: &str) -> f64 {
        match self.workbook.get_cell(addr) {
            Value::Number(n) => n,
            _ => f64::NAN,
        }
    }

    pub fn get_type(&self, addr: &str) -> String {
        match self.workbook.get_cell(addr) {
            Value::Number(_) => "number".into(),
            Value::Text(_) => "text".into(),
            Value::Boolean(_) => "boolean".into(),
            Value::Null => "null".into(),
            Value::Error(_) => "error".into(),
        }
    }

    pub fn is_error(&self, addr: &str) -> bool {
        self.workbook.get_cell(addr).is_error()
    }

    pub fn row_count(&self) -> u32 {
        self.workbook.row_count()
    }

    pub fn col_count(&self) -> u32 {
        self.workbook.col_count()
    }

    pub fn row_height(&self, index: u32) -> u32 {
        self.workbook.row_height(index)
    }

    pub fn col_width(&self, index: u32) -> u32 {
        self.workbook.col_width(index)
    }

    pub fn set_row_height(&mut self, index: u32, height: u32) {
        self.workbook.set_row_height(index, height);
    }

    pub fn set_col_width(&mut self, index: u32, width: u32) {
        self.workbook.set_col_width(index, width);
    }

    pub fn freeze_top_row(&self) -> bool {
        self.workbook.freeze_top_row()
    }

    pub fn freeze_first_column(&self) -> bool {
        self.workbook.freeze_first_column()
    }

    pub fn set_freeze_top_row(&mut self, value: bool) {
        self.workbook.set_freeze_top_row(value);
    }

    pub fn set_freeze_first_column(&mut self, value: bool) {
        self.workbook.set_freeze_first_column(value);
    }

    pub fn insert_row(&mut self, index: u32, count: Option<u32>) {
        self.workbook.insert_row(index, count.unwrap_or(1));
    }

    pub fn delete_row(&mut self, index: u32, count: Option<u32>) {
        self.workbook.delete_row(index, count.unwrap_or(1));
    }

    pub fn insert_col(&mut self, index: u32, count: Option<u32>) {
        self.workbook.insert_col(index, count.unwrap_or(1));
    }

    pub fn delete_col(&mut self, index: u32, count: Option<u32>) {
        self.workbook.delete_col(index, count.unwrap_or(1));
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
    use std::io::Cursor;

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
        assert_eq!(sheet.get_input("C1"), "=A1+B1");
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
    fn wasm_invalid_formula_returns_error_cell() {
        let mut sheet = WasmSheet::new();
        sheet.set_formula("A1", "=SUM(");
        assert_eq!(sheet.get_display("A1"), "#VALUE!");
        assert_eq!(sheet.get_type("A1"), "error");
        assert!(sheet.is_error("A1"));
        assert_eq!(sheet.get_input("A1"), "=SUM(");
    }

    #[test]
    fn wasm_batch_set_numbers_rejects_mismatched_lengths() {
        let mut sheet = WasmSheet::new();
        let result = sheet.batch_set_numbers(vec!["A1".into(), "B1".into()], vec![1.0]);
        assert!(!result);
        assert_eq!(sheet.get_type("A1"), "null");
        assert_eq!(sheet.get_type("B1"), "null");
    }

    #[test]
    fn wasm_clear_cell_resets_input() {
        let mut sheet = WasmSheet::new();
        sheet.set_formula("A1", "=1+1");
        sheet.clear_cell("A1");
        assert_eq!(sheet.get_type("A1"), "null");
        assert_eq!(sheet.get_input("A1"), "");
    }

    #[test]
    fn wasm_batch_set_inputs_supports_mixed_values() {
        let mut sheet = WasmSheet::new();
        let result = sheet.batch_set_inputs(
            vec!["A1".into(), "B1".into(), "C1".into(), "D1".into()],
            vec!["42".into(), "hello".into(), "=A1*2".into(), "".into()],
        );
        assert!(result);
        assert_eq!(sheet.get_display("A1"), "42");
        assert_eq!(sheet.get_display("B1"), "hello");
        assert_eq!(sheet.get_display("C1"), "84");
        assert_eq!(sheet.get_type("D1"), "null");
    }

    #[test]
    fn wasm_batch_set_inputs_rejects_mismatched_lengths() {
        let mut sheet = WasmSheet::new();
        let result = sheet.batch_set_inputs(vec!["A1".into(), "B1".into()], vec!["1".into()]);
        assert!(!result);
        assert_eq!(sheet.get_type("A1"), "null");
        assert_eq!(sheet.get_type("B1"), "null");
    }

    #[test]
    fn wasm_batch_set_inputs_round_trips_contract_values() {
        let mut sheet = WasmSheet::new();
        let result = sheet.batch_set_inputs(
            vec!["A1".into(), "B1".into(), "C1".into(), "D1".into()],
            vec!["42".into(), "=SUM(".into(), "TRUE".into(), "".into()],
        );

        assert!(result);
        assert_eq!(sheet.get_display("A1"), "42");
        assert_eq!(sheet.get_input("A1"), "42");
        assert_eq!(sheet.get_type("A1"), "number");

        assert_eq!(sheet.get_display("B1"), "#VALUE!");
        assert_eq!(sheet.get_input("B1"), "=SUM(");
        assert_eq!(sheet.get_type("B1"), "error");

        assert_eq!(sheet.get_display("C1"), "TRUE");
        assert_eq!(sheet.get_input("C1"), "TRUE");
        assert_eq!(sheet.get_type("C1"), "text");

        assert_eq!(sheet.get_display("D1"), "");
        assert_eq!(sheet.get_input("D1"), "");
        assert_eq!(sheet.get_type("D1"), "null");
    }

    #[test]
    fn wasm_absolute_references_evaluate() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 10.0);
        sheet.set_number("A2", 5.0);
        sheet.set_formula("B2", "=$A$1+A2");
        assert_eq!(sheet.get_display("B2"), "15");
    }

    #[test]
    fn wasm_mixed_absolute_reference_input_is_preserved() {
        let mut sheet = WasmSheet::new();
        sheet.set_formula("C3", "=$A1+B$2");

        assert_eq!(sheet.get_input("C3"), "=$A1+B$2");
        assert_eq!(sheet.get_type("C3"), "number");
    }

    #[test]
    fn changed_listener_addrs_detects_formula_dependency_updates() {
        let mut sheet = WasmSheet::new();
        sheet.set_number("A1", 5.0);
        sheet.set_formula("B1", "=A1*2");
        sheet.listeners.insert("B1".into(), Vec::new());

        let previous = sheet.snapshot_listener_values();
        sheet.set_number("A1", 10.0);

        let changed = sheet.changed_listener_addrs(&previous);
        assert_eq!(changed, vec!["B1".to_string()]);
    }

    #[test]
    fn wasm_workbook_manages_sheets_and_cross_sheet_formulas() {
        let mut workbook = WasmWorkbook::new();
        workbook.set_number("A1", 10.0);
        assert_eq!(workbook.add_sheet(Some("Sheet2".into())), "Sheet2");
        assert!(workbook.set_active_sheet(1));
        workbook.set_number("A1", 5.0);
        assert!(workbook.set_active_sheet(0));
        workbook.set_formula("B1", "=Sheet2!A1+A1");
        assert_eq!(workbook.get_display("B1"), "15");
        assert_eq!(workbook.get_input("B1"), "=Sheet2!A1+A1");
    }

    #[test]
    fn wasm_workbook_exposes_structure_and_metadata_operations() {
        let mut workbook = WasmWorkbook::new();
        workbook.set_formula("B4", "=A2");
        workbook.insert_row(1, Some(1));
        assert_eq!(workbook.get_input("B5"), "=A3");
        workbook.delete_row(2, Some(1));
        assert_eq!(workbook.get_input("B4"), "=#REF!");

        workbook.set_col_width(0, 200);
        workbook.set_row_height(0, 32);
        workbook.set_freeze_top_row(true);
        workbook.set_freeze_first_column(true);

        assert_eq!(workbook.col_width(0), 200);
        assert_eq!(workbook.row_height(0), 32);
        assert!(workbook.freeze_top_row());
        assert!(workbook.freeze_first_column());
    }

    #[test]
    fn wasm_exports_workbook_snapshot_to_xlsx_bytes() {
        let payload = serde_json::json!({
            "activeSheetIndex": 0,
            "sheets": [{
                "name": "Sheet1",
                "metadata": {
                    "rowCount": 20,
                    "colCount": 10,
                    "freezeTopRow": true,
                    "freezeFirstColumn": false
                },
                "rowHeights": [[0, 32]],
                "colWidths": [[0, 144]],
                "cells": [["A1", { "type": "text", "value": "标题" }], ["A2", { "type": "number", "value": 42 }]],
                "formulas": [["B2", "=A2*2"]],
                "formats": [],
                "mergedRanges": ["A1:C1"]
            }]
        })
        .to_string();

        let bytes = export_workbook_snapshot_to_xlsx_bytes(&payload)
            .expect("xlsx export should succeed");
        assert!(!bytes.is_empty());
        let book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true)
            .expect("xlsx bytes should be readable");
        let sheet = book.get_sheet(&0).expect("sheet should exist");
        assert_eq!(sheet.get_value("A1"), "标题");
        assert_eq!(
            sheet
                .get_merge_cells()
                .iter()
                .map(|range| range.get_range())
                .collect::<Vec<_>>(),
            vec!["A1:C1".to_string()]
        );
        assert_eq!(
            sheet.get_cell("B2").expect("formula cell should exist").get_formula(),
            "A2*2"
        );
    }
}
