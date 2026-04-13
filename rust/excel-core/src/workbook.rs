use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use einfach_core::{Value, ValueError};

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
}
