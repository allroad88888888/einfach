use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use einfach_core::{Value, ValueError};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use umya_spreadsheet::{
    self, Border, HorizontalAlignmentValues, NumberingFormat, Pane, PaneStateValues, PaneValues,
    SheetView, SheetViews, Style, VerticalAlignmentValues,
};

use crate::cell::{CellAddress, CellReference};
use crate::eval::eval_expr;
use crate::formula::{parse_formula, serialize_formula, Expr};

const DEFAULT_ROW_COUNT: u32 = 20;
const DEFAULT_COL_COUNT: u32 = 10;
const DEFAULT_ROW_HEIGHT: u32 = 28;
const DEFAULT_COL_WIDTH: u32 = 120;
const MIN_ROW_HEIGHT: u32 = 24;
const MIN_COL_WIDTH: u32 = 56;

#[derive(Clone)]
struct SheetModel {
    name: String,
    primitive_cells: HashMap<CellAddress, Value>,
    formula_inputs: HashMap<CellAddress, String>,
    row_count: u32,
    col_count: u32,
    row_heights: HashMap<u32, u32>,
    col_widths: HashMap<u32, u32>,
    freeze_top_row: bool,
    freeze_first_column: bool,
}

#[derive(Clone, Copy)]
enum Axis {
    Row,
    Col,
}

#[derive(Clone, Copy)]
enum StructureMode {
    Insert,
    Delete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkbookSnapshotPayload {
    active_sheet_index: usize,
    sheets: Vec<SheetSnapshotPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SheetSnapshotPayload {
    name: String,
    metadata: SheetMetadataPayload,
    row_heights: Vec<(u32, u32)>,
    col_widths: Vec<(u32, u32)>,
    cells: Vec<(String, SnapshotCellValuePayload)>,
    formulas: Vec<(String, String)>,
    #[serde(default)]
    formats: Vec<(String, CellFormatPayload)>,
    #[serde(default)]
    merged_ranges: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SheetMetadataPayload {
    row_count: u32,
    col_count: u32,
    freeze_top_row: bool,
    freeze_first_column: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct SnapshotCellValuePayload {
    #[serde(rename = "type")]
    kind: String,
    value: JsonValue,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CellFormatPayload {
    bold: bool,
    italic: bool,
    font_size: Option<f64>,
    text_color: Option<String>,
    background_color: Option<String>,
    horizontal_align: Option<String>,
    vertical_align: Option<String>,
    border_style: String,
    border_color: Option<String>,
    number_format: NumberFormatPayload,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NumberFormatPayload {
    kind: String,
    decimals: u32,
    use_grouping: bool,
    currency_symbol: String,
}

#[derive(Clone)]
struct ExportMergedRange {
    range: String,
    start: CellAddress,
    end: CellAddress,
}

pub struct Workbook {
    sheets: Vec<SheetModel>,
    active_sheet_index: usize,
}

impl SheetModel {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            primitive_cells: HashMap::new(),
            formula_inputs: HashMap::new(),
            row_count: DEFAULT_ROW_COUNT,
            col_count: DEFAULT_COL_COUNT,
            row_heights: HashMap::new(),
            col_widths: HashMap::new(),
            freeze_top_row: false,
            freeze_first_column: false,
        }
    }
}

impl Workbook {
    pub fn new() -> Self {
        Self {
            sheets: vec![SheetModel::new("Sheet1")],
            active_sheet_index: 0,
        }
    }

    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub fn sheet_name(&self, index: usize) -> Option<&str> {
        self.sheets.get(index).map(|sheet| sheet.name.as_str())
    }

    pub fn active_sheet_index(&self) -> usize {
        self.active_sheet_index
    }

    pub fn set_active_sheet(&mut self, index: usize) -> bool {
        if index >= self.sheets.len() {
            return false;
        }
        self.active_sheet_index = index;
        true
    }

    pub fn add_sheet(&mut self, requested_name: Option<&str>) -> String {
        let name = requested_name
            .filter(|name| is_valid_sheet_name(name) && !self.sheets.iter().any(|sheet| sheet.name == *name))
            .map(str::to_string)
            .unwrap_or_else(|| default_sheet_name(&self.sheets));
        self.sheets.push(SheetModel::new(&name));
        self.active_sheet_index = self.sheets.len() - 1;
        name
    }

    pub fn remove_sheet(&mut self, index: usize) -> bool {
        if self.sheets.len() <= 1 || index >= self.sheets.len() {
            return false;
        }
        let removed = self.sheets.remove(index);
        self.active_sheet_index = self.active_sheet_index.min(self.sheets.len().saturating_sub(1));
        self.rewrite_all_formulas(|expr, _owner_sheet| rewrite_expr_for_sheet_delete(expr, &removed.name));
        true
    }

    pub fn rename_sheet(&mut self, index: usize, next_name: &str) -> bool {
        if index >= self.sheets.len()
            || !is_valid_sheet_name(next_name)
            || self
                .sheets
                .iter()
                .enumerate()
                .any(|(sheet_index, sheet)| sheet_index != index && sheet.name == next_name)
        {
            return false;
        }

        let previous = self.sheets[index].name.clone();
        self.sheets[index].name = next_name.to_string();
        self.rewrite_all_formulas(|expr, _owner_sheet| {
            rewrite_expr_for_sheet_rename(expr, &previous, next_name)
        });
        true
    }

    pub fn row_count(&self) -> u32 {
        self.current_sheet().row_count
    }

    pub fn col_count(&self) -> u32 {
        self.current_sheet().col_count
    }

    pub fn row_height(&self, index: u32) -> u32 {
        *self
            .current_sheet()
            .row_heights
            .get(&index)
            .unwrap_or(&DEFAULT_ROW_HEIGHT)
    }

    pub fn col_width(&self, index: u32) -> u32 {
        *self
            .current_sheet()
            .col_widths
            .get(&index)
            .unwrap_or(&DEFAULT_COL_WIDTH)
    }

    pub fn set_row_height(&mut self, index: u32, height: u32) {
        self.current_sheet_mut()
            .row_heights
            .insert(index, height.max(MIN_ROW_HEIGHT));
    }

    pub fn set_col_width(&mut self, index: u32, width: u32) {
        self.current_sheet_mut()
            .col_widths
            .insert(index, width.max(MIN_COL_WIDTH));
    }

    pub fn freeze_top_row(&self) -> bool {
        self.current_sheet().freeze_top_row
    }

    pub fn freeze_first_column(&self) -> bool {
        self.current_sheet().freeze_first_column
    }

    pub fn set_freeze_top_row(&mut self, value: bool) {
        self.current_sheet_mut().freeze_top_row = value;
    }

    pub fn set_freeze_first_column(&mut self, value: bool) {
        self.current_sheet_mut().freeze_first_column = value;
    }

    pub fn set_cell(&mut self, addr_str: &str, value: Value) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let sheet = self.current_sheet_mut();
        sheet.formula_inputs.remove(&addr);
        sheet.primitive_cells.insert(addr, value);
    }

    pub fn set_number(&mut self, addr_str: &str, value: f64) {
        self.set_cell(addr_str, Value::Number(value));
    }

    pub fn set_text(&mut self, addr_str: &str, value: &str) {
        self.set_cell(addr_str, Value::Text(value.to_string()));
    }

    pub fn clear_cell(&mut self, addr_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let sheet = self.current_sheet_mut();
        sheet.formula_inputs.remove(&addr);
        sheet.primitive_cells.remove(&addr);
    }

    pub fn set_formula(&mut self, addr_str: &str, formula_str: &str) {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let sheet = self.current_sheet_mut();
        sheet.formula_inputs.insert(addr, formula_str.to_string());
    }

    pub fn batch_set_inputs(&mut self, updates: &[(&str, &str)]) {
        for (addr, input) in updates {
            self.apply_input(addr, input);
        }
    }

    pub fn get_cell(&self, addr_str: &str) -> Value {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        self.compute_cell(
            self.current_sheet().name.as_str(),
            addr,
            &RefCell::new(HashSet::new()),
        )
    }

    pub fn get_input(&self, addr_str: &str) -> String {
        let addr = CellAddress::parse(addr_str).expect("invalid cell address");
        let sheet = self.current_sheet();
        if let Some(formula) = sheet.formula_inputs.get(&addr) {
            return formula.clone();
        }
        sheet.primitive_cells.get(&addr).map(value_to_input).unwrap_or_default()
    }

    pub fn insert_row(&mut self, index: u32, count: u32) {
        let target_name = self.current_sheet().name.clone();
        shift_sheet_grid(self.current_sheet_mut(), Axis::Row, index, count.max(1), StructureMode::Insert);
        self.rewrite_all_formulas(|expr, owner_sheet| {
            rewrite_expr_for_structure(expr, owner_sheet, &target_name, Axis::Row, index, count.max(1), StructureMode::Insert)
        });
    }

    pub fn delete_row(&mut self, index: u32, count: u32) {
        let target_name = self.current_sheet().name.clone();
        shift_sheet_grid(self.current_sheet_mut(), Axis::Row, index, count.max(1), StructureMode::Delete);
        self.rewrite_all_formulas(|expr, owner_sheet| {
            rewrite_expr_for_structure(expr, owner_sheet, &target_name, Axis::Row, index, count.max(1), StructureMode::Delete)
        });
    }

    pub fn insert_col(&mut self, index: u32, count: u32) {
        let target_name = self.current_sheet().name.clone();
        shift_sheet_grid(self.current_sheet_mut(), Axis::Col, index, count.max(1), StructureMode::Insert);
        self.rewrite_all_formulas(|expr, owner_sheet| {
            rewrite_expr_for_structure(expr, owner_sheet, &target_name, Axis::Col, index, count.max(1), StructureMode::Insert)
        });
    }

    pub fn delete_col(&mut self, index: u32, count: u32) {
        let target_name = self.current_sheet().name.clone();
        shift_sheet_grid(self.current_sheet_mut(), Axis::Col, index, count.max(1), StructureMode::Delete);
        self.rewrite_all_formulas(|expr, owner_sheet| {
            rewrite_expr_for_structure(expr, owner_sheet, &target_name, Axis::Col, index, count.max(1), StructureMode::Delete)
        });
    }

    fn apply_input(&mut self, addr_str: &str, input: &str) {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            self.clear_cell(addr_str);
        } else if trimmed.starts_with('=') {
            self.set_formula(addr_str, trimmed);
        } else if let Ok(number) = trimmed.parse::<f64>() {
            self.set_cell(addr_str, Value::Number(number));
        } else {
            self.set_cell(addr_str, Value::Text(trimmed.to_string()));
        }
    }

    fn current_sheet(&self) -> &SheetModel {
        &self.sheets[self.active_sheet_index]
    }

    fn current_sheet_mut(&mut self) -> &mut SheetModel {
        &mut self.sheets[self.active_sheet_index]
    }

    fn find_sheet(&self, name: &str) -> Option<&SheetModel> {
        self.sheets.iter().find(|sheet| sheet.name == name)
    }

    fn compute_cell(
        &self,
        sheet_name: &str,
        addr: CellAddress,
        visiting: &RefCell<HashSet<(String, CellAddress)>>,
    ) -> Value {
        let Some(sheet) = self.find_sheet(sheet_name) else {
            return Value::Error(ValueError::InvalidRef);
        };

        if let Some(formula) = sheet.formula_inputs.get(&addr) {
            let key = (sheet_name.to_string(), addr);
            if visiting.borrow().contains(&key) {
                return Value::Error(ValueError::CyclicRef);
            }

            let Some(expr) = parse_formula(formula) else {
                return Value::Error(ValueError::InvalidValue);
            };

            visiting.borrow_mut().insert(key.clone());
            let resolve_cell = |reference: &CellReference| -> Value {
                if reference.is_invalid() {
                    return Value::Error(ValueError::InvalidRef);
                }
                let target_sheet = reference.sheet_name.as_deref().unwrap_or(sheet_name);
                self.compute_cell(target_sheet, reference.addr, visiting)
            };
            let resolve_range = |start: &CellReference, end: &CellReference| -> Vec<Value> {
                if start.is_invalid() || end.is_invalid() {
                    return vec![Value::Error(ValueError::InvalidRef)];
                }
                let target_sheet = start.sheet_name.as_deref().unwrap_or(sheet_name);
                let end_sheet = end.sheet_name.as_deref().unwrap_or(sheet_name);
                if target_sheet != end_sheet {
                    return vec![Value::Error(ValueError::InvalidRef)];
                }

                let min_row = start.addr.row.min(end.addr.row);
                let max_row = start.addr.row.max(end.addr.row);
                let min_col = start.addr.col.min(end.addr.col);
                let max_col = start.addr.col.max(end.addr.col);
                let mut values = Vec::new();
                for row in min_row..=max_row {
                    for col in min_col..=max_col {
                        values.push(self.compute_cell(
                            target_sheet,
                            CellAddress::new(row, col),
                            visiting,
                        ));
                    }
                }
                values
            };
            let value = eval_expr(&expr, &resolve_cell, &resolve_range);
            visiting.borrow_mut().remove(&key);
            return value;
        }

        sheet
            .primitive_cells
            .get(&addr)
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn rewrite_all_formulas(&mut self, handler: impl Fn(&Expr, &str) -> Expr) {
        for sheet_index in 0..self.sheets.len() {
            let owner_name = self.sheets[sheet_index].name.clone();
            let rewritten: HashMap<CellAddress, String> = self.sheets[sheet_index]
                .formula_inputs
                .iter()
                .map(|(addr, input)| {
                    let next = parse_formula(input)
                        .map(|expr| serialize_formula(&handler(&expr, owner_name.as_str())))
                        .unwrap_or_else(|| input.clone());
                    (*addr, next)
                })
                .collect();
            self.sheets[sheet_index].formula_inputs = rewritten;
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

pub fn export_snapshot_json_to_xlsx_bytes(payload: &str) -> Result<Vec<u8>, String> {
    let snapshot: WorkbookSnapshotPayload =
        serde_json::from_str(payload).map_err(|error| error.to_string())?;
    export_snapshot_to_xlsx_bytes(&snapshot)
}

fn export_snapshot_to_xlsx_bytes(snapshot: &WorkbookSnapshotPayload) -> Result<Vec<u8>, String> {
    let mut book = umya_spreadsheet::new_file_empty_worksheet();
    let sheets = if snapshot.sheets.is_empty() {
        vec![SheetSnapshotPayload {
            name: "Sheet1".to_string(),
            metadata: SheetMetadataPayload {
                row_count: DEFAULT_ROW_COUNT,
                col_count: DEFAULT_COL_COUNT,
                freeze_top_row: false,
                freeze_first_column: false,
            },
            row_heights: Vec::new(),
            col_widths: Vec::new(),
            cells: Vec::new(),
            formulas: Vec::new(),
            formats: Vec::new(),
            merged_ranges: Vec::new(),
        }]
    } else {
        snapshot.sheets.clone()
    };

    for sheet in &sheets {
        book.new_sheet(&sheet.name).map_err(|error| error.to_string())?;
    }

    for (index, sheet) in sheets.iter().enumerate() {
        let worksheet = book
            .get_sheet_mut(&index)
            .ok_or_else(|| format!("missing worksheet at index {index}"))?;
        worksheet.set_name(&sheet.name);
        let _declared_bounds = (sheet.metadata.row_count, sheet.metadata.col_count);
        apply_sheet_view(worksheet, sheet, index == snapshot.active_sheet_index);
        let (merged_ranges, covered_non_masters) = collect_merged_ranges(sheet);

        for (row_index, height) in &sheet.row_heights {
            worksheet
                .get_row_dimension_mut(&(row_index + 1))
                .set_height(*height as f64);
        }
        for (col_index, width) in &sheet.col_widths {
            worksheet
                .get_column_dimension_mut(&column_index_to_letters(*col_index))
                .set_width(*width as f64);
        }
        for (addr, value) in &sheet.cells {
            if is_covered_non_master(addr, &covered_non_masters) {
                continue;
            }
            let cell = worksheet.get_cell_mut(addr.as_str());
            match value.kind.as_str() {
                "number" => {
                    if let Some(number) = value.value.as_f64() {
                        cell.set_value_number(number);
                    } else if let Some(number) = value.value.as_i64() {
                        cell.set_value_number(number as f64);
                    }
                }
                "boolean" => {
                    if let Some(flag) = value.value.as_bool() {
                        cell.set_value_bool(flag);
                    }
                }
                "text" | "error" => {
                    if let Some(text) = value.value.as_str() {
                        cell.set_value_string(text);
                    }
                }
                _ => {}
            }
        }
        for (addr, formula) in &sheet.formulas {
            if is_covered_non_master(addr, &covered_non_masters) {
                continue;
            }
            worksheet
                .get_cell_mut(addr.as_str())
                .set_formula(formula.trim_start_matches('='));
        }
        for (addr, format) in &sheet.formats {
            if is_covered_non_master(addr, &covered_non_masters) {
                continue;
            }
            apply_cell_format(worksheet.get_style_mut(addr.as_str()), format);
        }
        for merged in &merged_ranges {
            worksheet.add_merge_cells(merged.range.as_str());
        }
    }

    if !sheets.is_empty() {
        book.set_active_sheet(
            snapshot
                .active_sheet_index
                .min(sheets.len().saturating_sub(1)) as u32,
        );
    }

    let mut bytes = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn value_to_input(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::Text(text) => text.clone(),
        Value::Boolean(true) => "TRUE".into(),
        Value::Boolean(false) => "FALSE".into(),
        Value::Null => String::new(),
        Value::Error(error) => error.to_string(),
    }
}

fn is_valid_sheet_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn default_sheet_name(sheets: &[SheetModel]) -> String {
    let mut index = 1;
    loop {
        let candidate = format!("Sheet{index}");
        if !sheets.iter().any(|sheet| sheet.name == candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn apply_sheet_view(
    worksheet: &mut umya_spreadsheet::Worksheet,
    sheet: &SheetSnapshotPayload,
    is_active: bool,
) {
    let mut view = SheetView::default();
    view.set_workbook_view_id(0);
    view.set_tab_selected(is_active);

    if sheet.metadata.freeze_top_row || sheet.metadata.freeze_first_column {
        let mut pane = Pane::default();
        if sheet.metadata.freeze_first_column {
            pane.set_horizontal_split(1.0);
        }
        if sheet.metadata.freeze_top_row {
            pane.set_vertical_split(1.0);
        }
        let top_left_cell = match (sheet.metadata.freeze_first_column, sheet.metadata.freeze_top_row)
        {
            (true, true) => "B2",
            (true, false) => "B1",
            (false, true) => "A2",
            (false, false) => "A1",
        };
        pane.get_top_left_cell_mut().set_coordinate(top_left_cell);
        pane.set_active_pane(match (sheet.metadata.freeze_first_column, sheet.metadata.freeze_top_row)
        {
            (true, true) => PaneValues::BottomRight,
            (true, false) => PaneValues::TopRight,
            (false, true) => PaneValues::BottomLeft,
            (false, false) => PaneValues::TopLeft,
        });
        pane.set_state(PaneStateValues::Frozen);
        view.set_pane(pane);
    }

    let mut views = SheetViews::default();
    views.add_sheet_view_list_mut(view);
    worksheet.set_sheets_views(views);
}

fn apply_cell_format(style: &mut Style, format: &CellFormatPayload) {
    style.get_font_mut().set_bold(format.bold);
    style.get_font_mut().set_italic(format.italic);
    if let Some(size) = format.font_size {
        style.get_font_mut().set_size(size);
    }
    if let Some(color) = normalize_excel_color(format.text_color.as_deref()) {
        style.get_font_mut().get_color_mut().set_argb(color);
    }
    if let Some(color) = normalize_excel_color(format.background_color.as_deref()) {
        style.set_background_color_solid(color);
    }

    if let Some(horizontal) = format.horizontal_align.as_deref() {
        let value = match horizontal {
            "center" => Some(HorizontalAlignmentValues::Center),
            "right" => Some(HorizontalAlignmentValues::Right),
            "left" => Some(HorizontalAlignmentValues::Left),
            _ => None,
        };
        if let Some(value) = value {
            style.get_alignment_mut().set_horizontal(value);
        }
    }
    if let Some(vertical) = format.vertical_align.as_deref() {
        let value = match vertical {
            "middle" => Some(VerticalAlignmentValues::Center),
            "bottom" => Some(VerticalAlignmentValues::Bottom),
            "top" => Some(VerticalAlignmentValues::Top),
            _ => None,
        };
        if let Some(value) = value {
            style.get_alignment_mut().set_vertical(value);
        }
    }

    if format.border_style == "solid" {
        let color = normalize_excel_color(format.border_color.as_deref())
            .unwrap_or_else(|| "FFAAB6C7".to_string());
        style.get_borders_mut().get_top_mut().set_border_style(Border::BORDER_THIN);
        style.get_borders_mut().get_top_mut().get_color_mut().set_argb(&color);
        style.get_borders_mut().get_right_mut().set_border_style(Border::BORDER_THIN);
        style.get_borders_mut().get_right_mut().get_color_mut().set_argb(&color);
        style.get_borders_mut().get_bottom_mut().set_border_style(Border::BORDER_THIN);
        style.get_borders_mut().get_bottom_mut().get_color_mut().set_argb(&color);
        style.get_borders_mut().get_left_mut().set_border_style(Border::BORDER_THIN);
        style.get_borders_mut().get_left_mut().get_color_mut().set_argb(&color);
    }

    style
        .get_numbering_format_mut()
        .set_format_code(number_format_to_excel(&format.number_format));
}

fn number_format_to_excel(number_format: &NumberFormatPayload) -> String {
    let fractional = if number_format.decimals == 0 {
        String::new()
    } else {
        format!(".{}", "0".repeat(number_format.decimals as usize))
    };
    let grouped = if number_format.use_grouping {
        "#,##0"
    } else {
        "0"
    };
    match number_format.kind.as_str() {
        "fixed" => format!("{grouped}{fractional}"),
        "percent" => format!("{grouped}{fractional}%"),
        "currency" => format!("\"{}\"{grouped}{fractional}", number_format.currency_symbol),
        _ => NumberingFormat::FORMAT_GENERAL.to_string(),
    }
}

fn normalize_excel_color(value: Option<&str>) -> Option<String> {
    let value = value?;
    let normalized = value.trim_start_matches('#');
    match normalized.len() {
        6 => Some(format!("FF{}", normalized.to_uppercase())),
        8 => Some(normalized.to_uppercase()),
        _ => None,
    }
}

fn column_index_to_letters(index: u32) -> String {
    let mut current = index + 1;
    let mut result = String::new();
    while current > 0 {
        let remainder = (current - 1) % 26;
        result.insert(0, char::from_u32(65 + remainder).unwrap());
        current = (current - 1) / 26;
    }
    result
}

fn parse_merged_range(input: &str) -> Option<ExportMergedRange> {
    let (raw_start, raw_end) = input.split_once(':')?;
    let start = CellAddress::parse(raw_start)?;
    let end = CellAddress::parse(raw_end)?;
    let top = start.row.min(end.row);
    let bottom = start.row.max(end.row);
    let left = start.col.min(end.col);
    let right = start.col.max(end.col);
    if top == bottom && left == right {
        return None;
    }
    let start = CellAddress::new(top, left);
    let end = CellAddress::new(bottom, right);
    Some(ExportMergedRange {
        range: format!("{}:{}", start.to_string_repr(), end.to_string_repr()),
        start,
        end,
    })
}

fn collect_merged_ranges(sheet: &SheetSnapshotPayload) -> (Vec<ExportMergedRange>, HashSet<CellAddress>) {
    let mut merged_ranges = Vec::new();
    let mut occupied = HashSet::new();
    let mut covered_non_masters = HashSet::new();

    for raw_range in &sheet.merged_ranges {
        let Some(parsed) = parse_merged_range(raw_range) else {
            continue;
        };

        let mut overlaps = false;
        for row in parsed.start.row..=parsed.end.row {
            for col in parsed.start.col..=parsed.end.col {
                if occupied.contains(&CellAddress::new(row, col)) {
                    overlaps = true;
                    break;
                }
            }
            if overlaps {
                break;
            }
        }
        if overlaps {
            continue;
        }

        for row in parsed.start.row..=parsed.end.row {
            for col in parsed.start.col..=parsed.end.col {
                let addr = CellAddress::new(row, col);
                occupied.insert(addr);
                if addr != parsed.start {
                    covered_non_masters.insert(addr);
                }
            }
        }
        merged_ranges.push(parsed);
    }

    (merged_ranges, covered_non_masters)
}

fn is_covered_non_master(addr: &str, covered_non_masters: &HashSet<CellAddress>) -> bool {
    CellAddress::parse(addr)
        .map(|parsed| covered_non_masters.contains(&parsed))
        .unwrap_or(false)
}

fn shift_sized_map(
    source: &HashMap<u32, u32>,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> HashMap<u32, u32> {
    let mut next = HashMap::new();
    for (key, value) in source {
        let rewritten = match mode {
            StructureMode::Insert => {
                if *key >= index {
                    Some(*key + count)
                } else {
                    Some(*key)
                }
            }
            StructureMode::Delete => {
                if *key >= index && *key < index + count {
                    None
                } else if *key >= index + count {
                    Some(*key - count)
                } else {
                    Some(*key)
                }
            }
        };
        if let Some(next_key) = rewritten {
            next.insert(next_key, *value);
        }
    }
    next
}

fn shift_sheet_grid(
    sheet: &mut SheetModel,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) {
    let primitive = rewrite_addr_map(&sheet.primitive_cells, axis, index, count, mode);
    let formulas = rewrite_addr_map(&sheet.formula_inputs, axis, index, count, mode);
    sheet.primitive_cells = primitive;
    sheet.formula_inputs = formulas;

    match axis {
        Axis::Row => {
            sheet.row_count = match mode {
                StructureMode::Insert => sheet.row_count + count,
                StructureMode::Delete => sheet.row_count.saturating_sub(count).max(1),
            };
            sheet.row_heights = shift_sized_map(&sheet.row_heights, index, count, mode);
        }
        Axis::Col => {
            sheet.col_count = match mode {
                StructureMode::Insert => sheet.col_count + count,
                StructureMode::Delete => sheet.col_count.saturating_sub(count).max(1),
            };
            sheet.col_widths = shift_sized_map(&sheet.col_widths, index, count, mode);
        }
    }
}

fn rewrite_addr_map<T: Clone>(
    source: &HashMap<CellAddress, T>,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> HashMap<CellAddress, T> {
    let mut next = HashMap::new();
    for (addr, value) in source {
        if let Some(rewritten) = rewrite_address(*addr, axis, index, count, mode) {
            next.insert(rewritten, value.clone());
        }
    }
    next
}

fn rewrite_address(
    addr: CellAddress,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> Option<CellAddress> {
    let primary = match axis {
        Axis::Row => addr.row,
        Axis::Col => addr.col,
    };

    match mode {
        StructureMode::Insert => {
            if primary < index {
                Some(addr)
            } else {
                Some(match axis {
                    Axis::Row => CellAddress::new(addr.row + count, addr.col),
                    Axis::Col => CellAddress::new(addr.row, addr.col + count),
                })
            }
        }
        StructureMode::Delete => {
            if primary >= index && primary < index + count {
                None
            } else if primary >= index + count {
                Some(match axis {
                    Axis::Row => CellAddress::new(addr.row - count, addr.col),
                    Axis::Col => CellAddress::new(addr.row, addr.col - count),
                })
            } else {
                Some(addr)
            }
        }
    }
}

fn effective_sheet<'a>(reference: &'a CellReference, current_sheet: &'a str) -> &'a str {
    reference.sheet_name.as_deref().unwrap_or(current_sheet)
}

fn make_invalid_reference(reference: &CellReference) -> CellReference {
    let mut invalid = reference.clone();
    invalid.invalid = true;
    invalid.addr = CellAddress::new(0, 0);
    invalid
}

fn shift_reference_for_structure(
    reference: &CellReference,
    current_sheet: &str,
    target_sheet: &str,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> CellReference {
    if reference.is_invalid() || effective_sheet(reference, current_sheet) != target_sheet {
        return reference.clone();
    }

    let primary = match axis {
        Axis::Row => reference.addr.row,
        Axis::Col => reference.addr.col,
    };

    match mode {
        StructureMode::Insert => {
            if primary < index {
                return reference.clone();
            }
            let mut next = reference.clone();
            next.addr = match axis {
                Axis::Row => CellAddress::new(reference.addr.row + count, reference.addr.col),
                Axis::Col => CellAddress::new(reference.addr.row, reference.addr.col + count),
            };
            next
        }
        StructureMode::Delete => {
            if primary >= index && primary < index + count {
                return make_invalid_reference(reference);
            }
            if primary < index + count {
                return reference.clone();
            }
            let mut next = reference.clone();
            next.addr = match axis {
                Axis::Row => CellAddress::new(reference.addr.row - count, reference.addr.col),
                Axis::Col => CellAddress::new(reference.addr.row, reference.addr.col - count),
            };
            next
        }
    }
}

fn rewrite_range_for_structure(
    start: &CellReference,
    end: &CellReference,
    current_sheet: &str,
    target_sheet: &str,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> (CellReference, CellReference) {
    if start.is_invalid()
        || end.is_invalid()
        || effective_sheet(start, current_sheet) != effective_sheet(end, current_sheet)
        || effective_sheet(start, current_sheet) != target_sheet
    {
        return (start.clone(), end.clone());
    }

    let start_primary = match axis {
        Axis::Row => start.addr.row,
        Axis::Col => start.addr.col,
    };
    let end_primary = match axis {
        Axis::Row => end.addr.row,
        Axis::Col => end.addr.col,
    };
    let range_start = start_primary.min(end_primary);
    let range_end = start_primary.max(end_primary);

    match mode {
        StructureMode::Insert => {
            if range_end < index {
                return (start.clone(), end.clone());
            }
            if range_start >= index {
                return (
                    shift_reference_for_structure(start, current_sheet, target_sheet, axis, index, count, mode),
                    shift_reference_for_structure(end, current_sheet, target_sheet, axis, index, count, mode),
                );
            }

            let mut next_end = end.clone();
            next_end.addr = match axis {
                Axis::Row => CellAddress::new(end.addr.row + count, end.addr.col),
                Axis::Col => CellAddress::new(end.addr.row, end.addr.col + count),
            };
            (start.clone(), next_end)
        }
        StructureMode::Delete => {
            if range_end < index {
                return (start.clone(), end.clone());
            }
            if range_start >= index + count {
                return (
                    shift_reference_for_structure(start, current_sheet, target_sheet, axis, index, count, mode),
                    shift_reference_for_structure(end, current_sheet, target_sheet, axis, index, count, mode),
                );
            }

            let removed_start = range_start.max(index);
            let removed_end = range_end.min(index + count - 1);
            let removed = if removed_end >= removed_start {
                removed_end - removed_start + 1
            } else {
                0
            };
            let remaining = (range_end - range_start + 1).saturating_sub(removed);
            if remaining == 0 {
                return (make_invalid_reference(start), make_invalid_reference(end));
            }

            let next_start = if range_start < index { range_start } else { index };
            let next_end = next_start + remaining - 1;
            let mut rewritten_start = start.clone();
            let mut rewritten_end = end.clone();
            rewritten_start.addr = match axis {
                Axis::Row => CellAddress::new(next_start, start.addr.col),
                Axis::Col => CellAddress::new(start.addr.row, next_start),
            };
            rewritten_end.addr = match axis {
                Axis::Row => CellAddress::new(next_end, end.addr.col),
                Axis::Col => CellAddress::new(end.addr.row, next_end),
            };
            (rewritten_start, rewritten_end)
        }
    }
}

fn rewrite_expr_for_structure(
    expr: &Expr,
    current_sheet: &str,
    target_sheet: &str,
    axis: Axis,
    index: u32,
    count: u32,
    mode: StructureMode,
) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Boolean(_) | Expr::Error(_) => expr.clone(),
        Expr::CellRef(reference) => Expr::CellRef(shift_reference_for_structure(
            reference,
            current_sheet,
            target_sheet,
            axis,
            index,
            count,
            mode,
        )),
        Expr::Range { start, end } => {
            let (next_start, next_end) = rewrite_range_for_structure(
                start,
                end,
                current_sheet,
                target_sheet,
                axis,
                index,
                count,
                mode,
            );
            Expr::Range {
                start: next_start,
                end: next_end,
            }
        }
        Expr::Negate(inner) => Expr::Negate(Box::new(rewrite_expr_for_structure(
            inner,
            current_sheet,
            target_sheet,
            axis,
            index,
            count,
            mode,
        ))),
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|arg| {
                    rewrite_expr_for_structure(arg, current_sheet, target_sheet, axis, index, count, mode)
                })
                .collect(),
        },
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(rewrite_expr_for_structure(
                left,
                current_sheet,
                target_sheet,
                axis,
                index,
                count,
                mode,
            )),
            right: Box::new(rewrite_expr_for_structure(
                right,
                current_sheet,
                target_sheet,
                axis,
                index,
                count,
                mode,
            )),
        },
    }
}

fn rewrite_expr_for_sheet_rename(expr: &Expr, old_name: &str, next_name: &str) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Boolean(_) | Expr::Error(_) => expr.clone(),
        Expr::CellRef(reference) => {
            let mut rewritten = reference.clone();
            if reference.sheet_name.as_deref() == Some(old_name) {
                rewritten.sheet_name = Some(next_name.to_string());
            }
            Expr::CellRef(rewritten)
        }
        Expr::Range { start, end } => {
            let mut next_start = start.clone();
            let mut next_end = end.clone();
            if start.sheet_name.as_deref() == Some(old_name) {
                next_start.sheet_name = Some(next_name.to_string());
            }
            if end.sheet_name.as_deref() == Some(old_name) {
                next_end.sheet_name = Some(next_name.to_string());
            }
            Expr::Range {
                start: next_start,
                end: next_end,
            }
        }
        Expr::Negate(inner) => Expr::Negate(Box::new(rewrite_expr_for_sheet_rename(
            inner,
            old_name,
            next_name,
        ))),
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|arg| rewrite_expr_for_sheet_rename(arg, old_name, next_name))
                .collect(),
        },
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(rewrite_expr_for_sheet_rename(left, old_name, next_name)),
            right: Box::new(rewrite_expr_for_sheet_rename(right, old_name, next_name)),
        },
    }
}

fn rewrite_expr_for_sheet_delete(expr: &Expr, deleted_name: &str) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Boolean(_) | Expr::Error(_) => expr.clone(),
        Expr::CellRef(reference) => Expr::CellRef(if reference.sheet_name.as_deref() == Some(deleted_name) {
            make_invalid_reference(reference)
        } else {
            reference.clone()
        }),
        Expr::Range { start, end } => Expr::Range {
            start: if start.sheet_name.as_deref() == Some(deleted_name) {
                make_invalid_reference(start)
            } else {
                start.clone()
            },
            end: if end.sheet_name.as_deref() == Some(deleted_name) {
                make_invalid_reference(end)
            } else {
                end.clone()
            },
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(rewrite_expr_for_sheet_delete(
            inner,
            deleted_name,
        ))),
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|arg| rewrite_expr_for_sheet_delete(arg, deleted_name))
                .collect(),
        },
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(rewrite_expr_for_sheet_delete(left, deleted_name)),
            right: Box::new(rewrite_expr_for_sheet_delete(right, deleted_name)),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use umya_spreadsheet::EnumTrait;

    #[test]
    fn workbook_supports_cross_sheet_formula_and_sheet_management() {
        let mut workbook = Workbook::new();
        workbook.set_number("A1", 10.0);
        let sheet2 = workbook.add_sheet(Some("Sheet2"));
        assert_eq!(sheet2, "Sheet2");
        workbook.set_number("A1", 5.0);
        workbook.set_active_sheet(0);
        workbook.set_formula("B1", "=Sheet2!A1+A1");
        assert_eq!(workbook.get_cell("B1"), Value::Number(15.0));
        assert_eq!(workbook.get_input("B1"), "=Sheet2!A1+A1");
    }

    #[test]
    fn workbook_rename_sheet_rewrites_formula_text() {
        let mut workbook = Workbook::new();
        workbook.add_sheet(Some("Sheet2"));
        workbook.set_active_sheet(0);
        workbook.set_formula("A1", "=Sheet2!B2");
        assert!(workbook.rename_sheet(1, "Inputs"));
        assert_eq!(workbook.get_input("A1"), "=Inputs!B2");
    }

    #[test]
    fn workbook_delete_sheet_turns_refs_into_ref_errors() {
        let mut workbook = Workbook::new();
        workbook.add_sheet(Some("Sheet2"));
        workbook.set_active_sheet(0);
        workbook.set_formula("A1", "=Sheet2!B2");
        assert!(workbook.remove_sheet(1));
        assert_eq!(workbook.get_input("A1"), "=#REF!");
        assert_eq!(workbook.get_cell("A1"), Value::Error(ValueError::InvalidRef));
    }

    #[test]
    fn workbook_insert_and_delete_rows_rewrite_formula_inputs() {
        let mut workbook = Workbook::new();
        workbook.set_formula("B4", "=A2");
        workbook.insert_row(1, 1);
        assert_eq!(workbook.get_input("B5"), "=A3");
        workbook.delete_row(2, 1);
        assert_eq!(workbook.get_input("B4"), "=#REF!");
    }

    #[test]
    fn workbook_insert_and_delete_cols_rewrite_cross_sheet_formula_inputs() {
        let mut workbook = Workbook::new();
        workbook.add_sheet(Some("Sheet2"));
        workbook.set_active_sheet(1);
        workbook.set_formula("B1", "=A1");
        workbook.set_active_sheet(0);
        workbook.set_formula("A1", "=Sheet2!B1");
        workbook.set_active_sheet(1);
        workbook.insert_col(0, 1);
        workbook.set_active_sheet(0);
        assert_eq!(workbook.get_input("A1"), "=Sheet2!C1");
        workbook.set_active_sheet(1);
        workbook.delete_col(2, 1);
        workbook.set_active_sheet(0);
        assert_eq!(workbook.get_input("A1"), "=#REF!");
    }

    #[test]
    fn workbook_snapshot_export_writes_xlsx_bytes_with_formula_metadata_and_styles() {
        let payload = serde_json::json!({
            "activeSheetIndex": 1,
            "sheets": [
                {
                    "name": "Sheet1",
                    "metadata": {
                        "rowCount": 20,
                        "colCount": 10,
                        "freezeTopRow": true,
                        "freezeFirstColumn": true
                    },
                    "rowHeights": [[0, 36]],
                    "colWidths": [[0, 180]],
                    "cells": [["A1", { "type": "text", "value": "标题" }], ["A2", { "type": "number", "value": 1234.5 }]],
                    "formulas": [["B2", "=A2*2"]],
                    "formats": [["A2", {
                        "bold": true,
                        "italic": false,
                        "fontSize": 16,
                        "textColor": "#ff0000",
                        "backgroundColor": "#00ff00",
                        "horizontalAlign": "right",
                        "verticalAlign": "middle",
                        "borderStyle": "solid",
                        "borderColor": "#112233",
                        "numberFormat": {
                            "kind": "currency",
                            "decimals": 1,
                            "useGrouping": true,
                            "currencySymbol": "¥"
                        }
                    }]],
                    "mergedRanges": ["A1:C1", "A1:A1", "B1:D2"]
                },
                {
                    "name": "Sheet2",
                    "metadata": {
                        "rowCount": 20,
                        "colCount": 10,
                        "freezeTopRow": false,
                        "freezeFirstColumn": false
                    },
                    "rowHeights": [],
                    "colWidths": [],
                    "cells": [["A1", { "type": "text", "value": "inputs" }]],
                    "formulas": [],
                    "formats": [],
                    "mergedRanges": []
                }
            ]
        })
        .to_string();

        let bytes = export_snapshot_json_to_xlsx_bytes(&payload).expect("xlsx export should succeed");
        let book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true)
            .expect("xlsx bytes should be readable");

        let sheet1 = book.get_sheet(&0).expect("sheet1 should exist");
        assert_eq!(sheet1.get_value("A1"), "标题");
        assert_eq!(sheet1.get_value("B1"), "");
        assert_eq!(sheet1.get_value("A2"), "1234.5");
        assert_eq!(
            sheet1.get_cell("B2").expect("formula cell should exist").get_formula(),
            "A2*2"
        );
        assert_eq!(
            sheet1
                .get_merge_cells()
                .iter()
                .map(|range| range.get_range())
                .collect::<Vec<_>>(),
            vec!["A1:C1".to_string()]
        );
        assert_eq!(
            sheet1
                .get_row_dimension(&1)
                .expect("row dimension should exist")
                .get_height(),
            &36.0
        );
        assert_eq!(
            sheet1
                .get_column_dimension_by_number(&1)
                .expect("column dimension should exist")
                .get_width(),
            &180.0
        );
        assert_eq!(
            sheet1
                .get_style("A2")
                .get_numbering_format()
                .expect("number format should exist")
                .get_format_code(),
            "\"¥\"#,##0.0"
        );
        assert_eq!(
            sheet1
                .get_style("A2")
                .get_background_color()
                .expect("background color should exist")
                .get_argb(),
            "FF00FF00"
        );
        assert!(sheet1
            .get_style("A2")
            .get_font()
            .expect("font should exist")
            .get_bold());
        assert_eq!(
            sheet1
                .get_sheets_views()
                .get_sheet_view_list()
                .first()
                .and_then(|view| view.get_pane())
                .map(|pane| pane.get_state().get_value_string()),
            Some("frozen")
        );
        assert_eq!(book.get_active_sheet().get_name(), "Sheet2");
    }
}
