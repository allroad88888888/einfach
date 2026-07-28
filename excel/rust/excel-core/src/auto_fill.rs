use crate::formula::{Expr, RangeAbs, RangeBounds, RefAbs};
use crate::sheet::{EXCEL_MAX_COLS, EXCEL_MAX_ROWS};
use crate::{parse_formula, render_formula, CellAddress, CellFormat, CellRange, Workbook};
use chrono::{Datelike, Duration, NaiveDate};
use einfach_core::Value;
use regex::Regex;
use std::fmt;
use std::sync::OnceLock;
use unicode_normalization::char::canonical_combining_class;

const NUMBER_EPSILON: f64 = 1e-10;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const LIST_MAX_ITEMS: usize = 512;
/// Fail-closed size budget for one drag-fill: one full Excel column
/// (1,048,576 rows × 1 column). Bounds the amount of work a single
/// `apply_auto_fill` call can generate so a runaway target range (e.g. a
/// full-row or full-sheet drag) is rejected during geometry preflight
/// instead of materializing millions of planned cells. Mirrored by the wasm
/// wire (`AUTO_FILL_TOO_LARGE`) and by both TS adapters
/// (`worker-workbook-backend.ts`, `static-backend.ts`) so hosts fail fast
/// without a round trip.
pub const MAX_AUTO_FILL_CELLS: u64 = 1_048_576;
const BUILTIN_WEEKDAY_SHORT: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUILTIN_WEEKDAY_LONG: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];
const BUILTIN_MONTH_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const BUILTIN_MONTH_LONG: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoFillDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoFillSeries {
    Copy,
    IntegerStep,
    DecimalStep,
    LinearTrend,
    DateDay,
    DateWeek,
    DateMonth,
    TextNumber,
    WeekdayName,
    MonthName,
    CustomList,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoFillTextPattern {
    pub prefix: String,
    pub suffix: String,
    pub width: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoFillListWitness {
    pub list_name: String,
    pub values: Vec<String>,
    pub locale: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutoFillRequest {
    pub sheet_idx: usize,
    pub source_range: CellRange,
    pub target_range: CellRange,
    pub direction: AutoFillDirection,
    pub series: AutoFillSeries,
    pub step: Option<f64>,
    pub text_pattern: Option<AutoFillTextPattern>,
    pub list: Option<AutoFillListWitness>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoFillReport {
    pub write_range: Option<CellRange>,
    pub written: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutoFillError {
    SheetOutOfRange,
    MutationDuringCustomCall,
    InvalidGeometry(&'static str),
    /// The target range spans more cells than [`MAX_AUTO_FILL_CELLS`]. Checked
    /// during geometry preflight, before any source or witness validation, so
    /// an oversized drag fails fast without touching the workbook.
    TooLarge {
        requested_cells: u64,
    },
    InvalidStep(&'static str),
    InvalidSource(&'static str),
    InvalidWitness(&'static str),
    FormulaParse,
    UnsupportedFormula,
    SpillTarget(CellAddress),
    UnsupportedSeries,
}

impl fmt::Display for AutoFillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AutoFillError::SheetOutOfRange => write!(f, "sheet index is out of range"),
            AutoFillError::MutationDuringCustomCall => {
                f.write_str("workbook mutations are forbidden during a custom formula call")
            }
            AutoFillError::InvalidGeometry(message)
            | AutoFillError::InvalidStep(message)
            | AutoFillError::InvalidSource(message)
            | AutoFillError::InvalidWitness(message) => f.write_str(message),
            AutoFillError::TooLarge { requested_cells } => write!(
                f,
                "auto-fill target spans {requested_cells} cells but the engine cap is {MAX_AUTO_FILL_CELLS}"
            ),
            AutoFillError::FormulaParse => f.write_str("source formula could not be parsed"),
            AutoFillError::UnsupportedFormula => {
                f.write_str("source formula contains an unsupported expression")
            }
            AutoFillError::SpillTarget(addr) => {
                write!(f, "auto-fill target {addr} belongs to a spilled array")
            }
            AutoFillError::UnsupportedSeries => f.write_str("auto-fill series is not implemented"),
        }
    }
}

impl std::error::Error for AutoFillError {}

#[derive(Clone)]
enum PlannedValue {
    Primitive(Value),
    /// Rendered formula source text. Written through
    /// `WorkbookLoader::set_formula_at`, the same validated path
    /// `Workbook::set_formula` uses, so a formula that closes a dependency
    /// cycle lands as `#CYCLE!` instead of being rejected (Excel parity) —
    /// see `Workbook::apply_auto_fill`.
    Formula(String),
}

#[derive(Clone)]
struct PlannedCell {
    addr: CellAddress,
    value: PlannedValue,
    format: CellFormat,
}

impl Workbook {
    /// Preflight and apply one drag-fill as a single native operation.
    ///
    /// Every source value, formula, target spill constraint, and generated
    /// value is validated before the first mutation. Callers therefore either
    /// receive a complete fill or an error with the workbook untouched.
    pub fn apply_auto_fill(
        &mut self,
        request: &AutoFillRequest,
    ) -> Result<AutoFillReport, AutoFillError> {
        validate_geometry(request)?;
        let write_range = fill_write_range(request);

        if self.is_inside_custom_call() {
            return Err(AutoFillError::MutationDuringCustomCall);
        }
        self.sheet(request.sheet_idx)
            .ok_or(AutoFillError::SheetOutOfRange)?;

        // Copy has no semantic witnesses to validate when the handle did not
        // extend beyond the source. Series validation intentionally continues
        // below, matching the stricter static backend contract.
        if write_range.is_none() && request.series == AutoFillSeries::Copy {
            return Ok(AutoFillReport {
                write_range: None,
                written: 0,
            });
        }

        let sheet = self
            .sheet(request.sheet_idx)
            .expect("auto-fill sheet was validated above");
        let planned = match request.series {
            AutoFillSeries::Copy => plan_copy(sheet, request, write_range.unwrap())?,
            AutoFillSeries::IntegerStep | AutoFillSeries::DecimalStep => {
                plan_numeric_series(sheet, request, write_range)?
            }
            AutoFillSeries::LinearTrend => plan_linear_trend(sheet, request, write_range)?,
            AutoFillSeries::DateDay | AutoFillSeries::DateWeek | AutoFillSeries::DateMonth => {
                plan_date_series(sheet, request, write_range)?
            }
            AutoFillSeries::TextNumber => plan_text_number_series(sheet, request, write_range)?,
            AutoFillSeries::WeekdayName
            | AutoFillSeries::MonthName
            | AutoFillSeries::CustomList => plan_named_series(sheet, request, write_range)?,
        };

        let Some(write_range) = write_range else {
            return Ok(AutoFillReport {
                write_range: None,
                written: 0,
            });
        };

        // No operation below can fail. Formula text was parsed during
        // preflight and all writes are buffered into one workbook bulk-load.
        // Formula cells route through `WorkbookLoader::set_formula_at` — the
        // same validated path `Workbook::set_formula` itself uses — instead
        // of the prevalidated fast path, so a fill that closes a dependency
        // cycle still LANDS: the cycle-closing cell(s) install as `#CYCLE!`
        // (either the install-time static check or the Store's own runtime
        // cyclic-eval guard catches it) and every other planned cell
        // computes normally. This matches Excel: dragging a fill handle
        // never rejects the drag outright, exactly like typing each
        // formula in by hand would not.
        self.bulk_load(|loader| {
            for cell in &planned {
                match &cell.value {
                    PlannedValue::Primitive(Value::Null) => {
                        loader.clear_cell_at(request.sheet_idx, cell.addr);
                    }
                    PlannedValue::Primitive(value) => {
                        loader.set_cell_at(request.sheet_idx, cell.addr, value.clone());
                    }
                    PlannedValue::Formula(source) => {
                        loader.set_formula_at(request.sheet_idx, cell.addr, source);
                    }
                }
            }
        });

        let target_sheet = self
            .sheet_mut(request.sheet_idx)
            .expect("preflighted auto-fill sheet disappeared");
        // A default range layer clears any previous effective target format.
        // Non-default copied effective formats are then restored sparsely.
        target_sheet.set_format_range(write_range, CellFormat::default());
        for cell in &planned {
            if cell.format != CellFormat::default() {
                target_sheet.set_format(&cell.addr.to_string_repr(), cell.format.clone());
            }
        }

        Ok(AutoFillReport {
            write_range: Some(write_range),
            written: planned.len(),
        })
    }
}

fn validate_geometry(request: &AutoFillRequest) -> Result<(), AutoFillError> {
    for range in [request.source_range, request.target_range] {
        if range != range.normalize()
            || range.end.row >= EXCEL_MAX_ROWS
            || range.end.col >= EXCEL_MAX_COLS
        {
            return Err(AutoFillError::InvalidGeometry(
                "ranges must be canonical and inside the Excel grid",
            ));
        }
    }

    let source = request.source_range;
    let target = request.target_range;

    // Fail fast on an oversized drag before any other geometry, witness, or
    // workbook check runs. Both range axes were just proven to sit inside
    // the Excel grid (<= EXCEL_MAX_ROWS / EXCEL_MAX_COLS), so widening to
    // u64 before multiplying cannot overflow.
    let requested_cells = target.rows() as u64 * target.cols() as u64;
    if requested_cells > MAX_AUTO_FILL_CELLS {
        return Err(AutoFillError::TooLarge { requested_cells });
    }

    match request.direction {
        AutoFillDirection::Down | AutoFillDirection::Up => {
            if target.start.col != source.start.col || target.end.col != source.end.col {
                return Err(AutoFillError::InvalidGeometry(
                    "vertical target must keep the source columns",
                ));
            }
            if request.series != AutoFillSeries::Copy && source.start.col != source.end.col {
                return Err(AutoFillError::InvalidGeometry(
                    "vertical series require one source column",
                ));
            }
            let extends = match request.direction {
                AutoFillDirection::Down => {
                    target.start.row == source.start.row && target.end.row >= source.end.row
                }
                AutoFillDirection::Up => {
                    target.end.row == source.end.row && target.start.row <= source.start.row
                }
                _ => unreachable!(),
            };
            if !extends {
                return Err(AutoFillError::InvalidGeometry(
                    "target does not extend the source in the requested direction",
                ));
            }
        }
        AutoFillDirection::Left | AutoFillDirection::Right => {
            if target.start.row != source.start.row || target.end.row != source.end.row {
                return Err(AutoFillError::InvalidGeometry(
                    "horizontal target must keep the source rows",
                ));
            }
            if request.series != AutoFillSeries::Copy && source.start.row != source.end.row {
                return Err(AutoFillError::InvalidGeometry(
                    "horizontal series require one source row",
                ));
            }
            let extends = match request.direction {
                AutoFillDirection::Right => {
                    target.start.col == source.start.col && target.end.col >= source.end.col
                }
                AutoFillDirection::Left => {
                    target.end.col == source.end.col && target.start.col <= source.start.col
                }
                _ => unreachable!(),
            };
            if !extends {
                return Err(AutoFillError::InvalidGeometry(
                    "target does not extend the source in the requested direction",
                ));
            }
        }
    }
    Ok(())
}

fn fill_write_range(request: &AutoFillRequest) -> Option<CellRange> {
    let source = request.source_range;
    let target = request.target_range;
    match request.direction {
        AutoFillDirection::Down if target.end.row > source.end.row => Some(CellRange::new(
            CellAddress::new(source.end.row + 1, source.start.col),
            CellAddress::new(target.end.row, source.end.col),
        )),
        AutoFillDirection::Up if target.start.row < source.start.row => Some(CellRange::new(
            CellAddress::new(target.start.row, source.start.col),
            CellAddress::new(source.start.row - 1, source.end.col),
        )),
        AutoFillDirection::Right if target.end.col > source.end.col => Some(CellRange::new(
            CellAddress::new(source.start.row, source.end.col + 1),
            CellAddress::new(source.end.row, target.end.col),
        )),
        AutoFillDirection::Left if target.start.col < source.start.col => Some(CellRange::new(
            CellAddress::new(source.start.row, target.start.col),
            CellAddress::new(source.end.row, source.start.col - 1),
        )),
        _ => None,
    }
}

fn source_coord(source: CellRange, target: CellAddress) -> CellAddress {
    let height = source.rows();
    let width = source.cols();
    let row_offset = positive_mod(target.row as i64 - source.start.row as i64, height as i64);
    let col_offset = positive_mod(target.col as i64 - source.start.col as i64, width as i64);
    CellAddress::new(
        source.start.row + row_offset as u32,
        source.start.col + col_offset as u32,
    )
}

fn positive_mod(value: i64, divisor: i64) -> i64 {
    ((value % divisor) + divisor) % divisor
}

fn plan_copy(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: CellRange,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let mut planned = Vec::with_capacity(write_range.cell_count() as usize);
    for addr in write_range.iter() {
        if sheet.is_spilled(addr) {
            return Err(AutoFillError::SpillTarget(addr));
        }
        let source = source_coord(request.source_range, addr);
        let value = if let Some(formula) = sheet.formula_text_at(source) {
            let expr = parse_formula(&formula).ok_or(AutoFillError::FormulaParse)?;
            let shifted = shift_fill_formula(
                &expr,
                addr.row as i64 - source.row as i64,
                addr.col as i64 - source.col as i64,
            )?;
            PlannedValue::Formula(render_formula(&shifted))
        } else {
            PlannedValue::Primitive(sheet.peek_value(source))
        };
        planned.push(PlannedCell {
            addr,
            value,
            format: sheet.effective_format(&source.to_string_repr()),
        });
    }
    Ok(planned)
}

fn plan_numeric_series(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let requested_step = request
        .step
        .filter(|step| step.is_finite() && *step != 0.0)
        .ok_or(AutoFillError::InvalidStep(
            "step must be finite and non-zero",
        ))?;
    let source_addrs = ordered_source_addrs(request);
    if source_addrs.len() < 2 {
        return Err(AutoFillError::InvalidSource(
            "numeric series require at least two source cells",
        ));
    }
    let mut values = Vec::with_capacity(source_addrs.len());
    for addr in &source_addrs {
        if sheet.formula_text_at(*addr).is_some() {
            return Err(AutoFillError::InvalidSource(
                "source cells must be canonical non-formula numbers",
            ));
        }
        match sheet.peek_value(*addr) {
            Value::Number(value) if value.is_finite() => values.push(value),
            _ => {
                return Err(AutoFillError::InvalidSource(
                    "source cells must be canonical non-formula numbers",
                ))
            }
        }
    }
    for pair in values.windows(2) {
        if !steps_match(pair[1] - pair[0], requested_step) {
            return Err(AutoFillError::InvalidSource(
                "source values do not match the requested step",
            ));
        }
    }
    let integer_series = requested_step.abs() >= NUMBER_EPSILON
        && is_fill_integer(requested_step)
        && values.iter().copied().all(is_fill_integer);
    if (request.series == AutoFillSeries::IntegerStep && !integer_series)
        || (request.series == AutoFillSeries::DecimalStep && integer_series)
    {
        return Err(AutoFillError::InvalidSource(
            "series kind does not match the canonical source values",
        ));
    }

    let Some(write_range) = write_range else {
        return Ok(Vec::new());
    };
    let first = values[0];
    let mut planned = Vec::with_capacity(write_range.cell_count() as usize);
    for addr in write_range.iter() {
        if sheet.is_spilled(addr) {
            return Err(AutoFillError::SpillTarget(addr));
        }
        let relative = source_relative_index(request, addr) as f64;
        let value = first + requested_step * relative;
        if !value.is_finite() {
            return Err(AutoFillError::InvalidSource(
                "generated series contains a non-finite value",
            ));
        }
        let source = source_coord(request.source_range, addr);
        planned.push(PlannedCell {
            addr,
            value: PlannedValue::Primitive(Value::Number(value)),
            format: sheet.effective_format(&source.to_string_repr()),
        });
    }
    Ok(planned)
}

fn requested_step(request: &AutoFillRequest) -> Result<f64, AutoFillError> {
    request
        .step
        .filter(|step| step.is_finite() && *step != 0.0)
        .ok_or(AutoFillError::InvalidStep(
            "step must be finite and non-zero",
        ))
}

fn source_numbers(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    minimum: usize,
) -> Result<(Vec<CellAddress>, Vec<f64>), AutoFillError> {
    let source_addrs = ordered_source_addrs(request);
    if source_addrs.len() < minimum {
        return Err(AutoFillError::InvalidSource(
            "series does not have enough source cells",
        ));
    }
    let mut values = Vec::with_capacity(source_addrs.len());
    for addr in &source_addrs {
        if sheet.formula_text_at(*addr).is_some() {
            return Err(AutoFillError::InvalidSource(
                "source cells must be canonical non-formula numbers",
            ));
        }
        match sheet.peek_value(*addr) {
            Value::Number(value) if value.is_finite() => values.push(value),
            _ => {
                return Err(AutoFillError::InvalidSource(
                    "source cells must be canonical non-formula numbers",
                ))
            }
        }
    }
    Ok((source_addrs, values))
}

fn source_texts(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
) -> Result<Vec<String>, AutoFillError> {
    ordered_source_addrs(request)
        .into_iter()
        .map(|addr| {
            if sheet.formula_text_at(addr).is_some() {
                return Err(AutoFillError::InvalidSource(
                    "source cells must be canonical non-formula strings",
                ));
            }
            match sheet.peek_value(addr) {
                Value::Text(value) => Ok(value),
                _ => Err(AutoFillError::InvalidSource(
                    "source cells must be canonical non-formula strings",
                )),
            }
        })
        .collect()
}

fn plan_generated(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
    mut generate: impl FnMut(i64) -> Result<Value, AutoFillError>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let Some(write_range) = write_range else {
        return Ok(Vec::new());
    };
    let mut planned = Vec::with_capacity(write_range.cell_count() as usize);
    for addr in write_range.iter() {
        if sheet.is_spilled(addr) {
            return Err(AutoFillError::SpillTarget(addr));
        }
        let value = generate(source_relative_index(request, addr))?;
        let source = source_coord(request.source_range, addr);
        planned.push(PlannedCell {
            addr,
            value: PlannedValue::Primitive(value),
            format: sheet.effective_format(&source.to_string_repr()),
        });
    }
    Ok(planned)
}

fn linear_trend(values: &[f64]) -> Option<(f64, f64)> {
    if values.len() < 2 || !values.iter().all(|value| value.is_finite()) {
        return None;
    }
    let mean_x = (values.len() - 1) as f64 / 2.0;
    let mean_y = values.iter().sum::<f64>() / values.len() as f64;
    if !mean_y.is_finite() {
        return None;
    }
    let mut numerator = 0.0;
    let mut denominator = 0.0;
    for (index, value) in values.iter().enumerate() {
        let centered_x = index as f64 - mean_x;
        numerator += centered_x * (*value - mean_y);
        denominator += centered_x * centered_x;
    }
    if !numerator.is_finite() || denominator == 0.0 {
        return None;
    }
    let slope = numerator / denominator;
    let intercept = mean_y - slope * mean_x;
    (slope.is_finite() && intercept.is_finite()).then_some((slope, intercept))
}

fn plan_linear_trend(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let step = requested_step(request)?;
    let (_, values) = source_numbers(sheet, request, 3)?;
    let (slope, intercept) = linear_trend(&values).ok_or(AutoFillError::InvalidSource(
        "canonical source values do not define a linear trend",
    ))?;
    if slope.abs() < NUMBER_EPSILON || !steps_match(slope, step) {
        return Err(AutoFillError::InvalidSource(
            "canonical source values do not match the requested linear trend",
        ));
    }
    plan_generated(sheet, request, write_range, |relative| {
        let value = intercept + slope * relative as f64;
        if value.is_finite() {
            Ok(Value::Number(value))
        } else {
            Err(AutoFillError::InvalidSource(
                "generated series contains a non-finite value",
            ))
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ExcelDateParts {
    year: i32,
    month: u32,
    day: u32,
    fraction: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DateSeriesKind {
    Day,
    Week,
    Month,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DateAnalysis {
    kind: DateSeriesKind,
    step: i64,
    preserve_end_of_month: bool,
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_SAFE_INTEGER && value.fract() == 0.0
}

fn days_in_excel_month(year: i32, month: u32) -> Option<u32> {
    if year == 1900 && month == 2 {
        return Some(29);
    }
    let (next_year, next_month) = if month == 12 {
        (year.checked_add(1)?, 1)
    } else {
        (year, month.checked_add(1)?)
    };
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1)?;
    Some((next - first).num_days() as u32)
}

fn excel_serial_to_date_parts(serial: f64) -> Option<ExcelDateParts> {
    if !serial.is_finite() {
        return None;
    }
    let whole = serial.floor();
    if whole < i64::MIN as f64 || whole > i64::MAX as f64 {
        return None;
    }
    let whole = whole as i64;
    let fraction = serial - whole as f64;
    if whole == 60 {
        return Some(ExcelDateParts {
            year: 1900,
            month: 2,
            day: 29,
            fraction,
        });
    }
    let adjusted = if whole > 60 { whole - 1 } else { whole };
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 31)?;
    let date = epoch.checked_add_signed(Duration::days(adjusted))?;
    Some(ExcelDateParts {
        year: date.year(),
        month: date.month(),
        day: date.day(),
        fraction,
    })
}

fn excel_date_parts_to_serial(parts: ExcelDateParts) -> Option<f64> {
    if !parts.fraction.is_finite()
        || parts.month == 0
        || parts.month > 12
        || parts.day == 0
        || parts.day > days_in_excel_month(parts.year, parts.month)?
    {
        return None;
    }
    if parts.year == 1900 && parts.month == 2 && parts.day == 29 {
        return Some(60.0 + parts.fraction);
    }
    let date = NaiveDate::from_ymd_opt(parts.year, parts.month, parts.day)?;
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 31)?;
    let mut serial = date.signed_duration_since(epoch).num_days() as f64;
    if parts.year > 1900 || (parts.year == 1900 && parts.month > 2) {
        serial += 1.0;
    }
    let serial = serial + parts.fraction;
    serial.is_finite().then_some(serial)
}

fn add_excel_months(
    anchor_serial: f64,
    month_offset: i64,
    preserve_end_of_month: bool,
) -> Option<f64> {
    let anchor = excel_serial_to_date_parts(anchor_serial)?;
    let absolute_month = (anchor.year as i64)
        .checked_mul(12)?
        .checked_add(anchor.month as i64 - 1)?
        .checked_add(month_offset)?;
    let year = absolute_month.div_euclid(12);
    if year < i32::MIN as i64 || year > i32::MAX as i64 {
        return None;
    }
    let month = absolute_month.rem_euclid(12) as u32 + 1;
    let month_days = days_in_excel_month(year as i32, month)?;
    let day = if preserve_end_of_month {
        month_days
    } else {
        anchor.day.min(month_days)
    };
    excel_date_parts_to_serial(ExcelDateParts {
        year: year as i32,
        month,
        day,
        fraction: anchor.fraction,
    })
}

fn date_value(
    anchor: f64,
    kind: DateSeriesKind,
    step: i64,
    relative: i64,
    preserve_end_of_month: bool,
) -> Option<f64> {
    match kind {
        DateSeriesKind::Month => {
            add_excel_months(anchor, step.checked_mul(relative)?, preserve_end_of_month)
        }
        DateSeriesKind::Day | DateSeriesKind::Week => {
            let multiplier = if kind == DateSeriesKind::Week { 7 } else { 1 };
            let delta = step.checked_mul(relative)?.checked_mul(multiplier)?;
            let value = anchor + delta as f64;
            value.is_finite().then_some(value)
        }
    }
}

fn analyze_dates(values: &[f64]) -> Option<DateAnalysis> {
    if values.is_empty() || !values.iter().all(|value| value.is_finite()) {
        return None;
    }
    if values.len() == 1 {
        return Some(DateAnalysis {
            kind: DateSeriesKind::Day,
            step: 1,
            preserve_end_of_month: false,
        });
    }
    let first = excel_serial_to_date_parts(values[0])?;
    let second = excel_serial_to_date_parts(values[1])?;
    let month_step = (second.year as i64 - first.year as i64)
        .checked_mul(12)?
        .checked_add(second.month as i64 - first.month as i64)?;
    if month_step != 0 {
        let first_eom = first.day == days_in_excel_month(first.year, first.month)?;
        for preserve_end_of_month in [true, false]
            .into_iter()
            .filter(|preserve| first_eom || !*preserve)
        {
            let matches = values.iter().enumerate().all(|(index, actual)| {
                date_value(
                    values[0],
                    DateSeriesKind::Month,
                    month_step,
                    index as i64,
                    preserve_end_of_month,
                )
                .is_some_and(|expected| steps_match(*actual, expected))
            });
            if matches {
                return Some(DateAnalysis {
                    kind: DateSeriesKind::Month,
                    step: month_step,
                    preserve_end_of_month,
                });
            }
        }
    }
    let raw_step = values[1] - values[0];
    if !is_fill_integer(raw_step) || raw_step.abs() < NUMBER_EPSILON {
        return None;
    }
    let day_step = raw_step.round() as i64;
    if !values
        .iter()
        .enumerate()
        .all(|(index, value)| steps_match(*value, values[0] + day_step as f64 * index as f64))
    {
        return None;
    }
    if day_step % 7 == 0 {
        Some(DateAnalysis {
            kind: DateSeriesKind::Week,
            step: day_step / 7,
            preserve_end_of_month: false,
        })
    } else {
        Some(DateAnalysis {
            kind: DateSeriesKind::Day,
            step: day_step,
            preserve_end_of_month: false,
        })
    }
}

fn plan_date_series(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let step = requested_step(request)?;
    if !is_safe_integer(step) {
        return Err(AutoFillError::InvalidStep(
            "calendar series step must be a non-zero safe integer",
        ));
    }
    // Excel dates are plain serial numbers: fill arithmetic runs on the
    // serial value regardless of number format, which affects display only
    // (Excel parity — a date-kind series is not gated on the source cell
    // having an effective date format). `source_numbers` already enforces
    // the value-type requirement: source cells must be canonical
    // non-formula numbers.
    let (_source_addrs, values) = source_numbers(sheet, request, 1)?;
    let analysis = analyze_dates(&values).ok_or(AutoFillError::InvalidSource(
        "canonical source dates do not define a calendar series",
    ))?;
    let expected_kind = match request.series {
        AutoFillSeries::DateDay => DateSeriesKind::Day,
        AutoFillSeries::DateWeek => DateSeriesKind::Week,
        AutoFillSeries::DateMonth => DateSeriesKind::Month,
        _ => unreachable!(),
    };
    if analysis.kind != expected_kind || !steps_match(analysis.step as f64, step) {
        return Err(AutoFillError::InvalidSource(
            "canonical source dates do not match the requested calendar series",
        ));
    }
    let anchor = values[0];
    plan_generated(sheet, request, write_range, |relative| {
        date_value(
            anchor,
            expected_kind,
            step as i64,
            relative,
            analysis.preserve_end_of_month,
        )
        .map(Value::Number)
        .ok_or(AutoFillError::InvalidSource(
            "generated series contains an invalid date",
        ))
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedTextNumber {
    prefix: String,
    suffix: String,
    width: u32,
    value: i64,
}

fn parse_text_number(value: &str) -> Option<ParsedTextNumber> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let captures = RE
        .get_or_init(|| Regex::new(r"^(.*?)(-?\d+)(\D*)$").expect("valid text-number regex"))
        .captures(value)?;
    let prefix = captures.get(1)?.as_str();
    if prefix.is_empty() {
        return None;
    }
    let numeric = captures.get(2)?.as_str();
    let parsed = numeric.parse::<i64>().ok()?;
    if (parsed as f64).abs() > MAX_SAFE_INTEGER {
        return None;
    }
    Some(ParsedTextNumber {
        prefix: prefix.to_string(),
        suffix: captures.get(3)?.as_str().to_string(),
        width: numeric.trim_start_matches('-').len() as u32,
        value: parsed,
    })
}

fn format_text_number(pattern: &AutoFillTextPattern, value: i64) -> Option<String> {
    if pattern.width as usize > usize::MAX / 2 {
        return None;
    }
    let absolute = value.unsigned_abs().to_string();
    let digits = if pattern.width > 0 {
        format!("{:0>width$}", absolute, width = pattern.width as usize)
    } else {
        absolute
    };
    Some(format!(
        "{}{}{}{}",
        pattern.prefix,
        if value < 0 { "-" } else { "" },
        digits,
        pattern.suffix
    ))
}

fn plan_text_number_series(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let step = requested_step(request)?;
    if !is_safe_integer(step) {
        return Err(AutoFillError::InvalidStep(
            "text-number series step must be a non-zero safe integer",
        ));
    }
    let pattern = request
        .text_pattern
        .as_ref()
        .ok_or(AutoFillError::InvalidWitness(
            "text-number series require a text pattern witness",
        ))?;
    let parsed: Vec<ParsedTextNumber> = source_texts(sheet, request)?
        .iter()
        .map(|value| parse_text_number(value))
        .collect::<Option<_>>()
        .ok_or(AutoFillError::InvalidSource(
            "source strings do not contain a safe trailing number",
        ))?;
    let first = parsed.first().ok_or(AutoFillError::InvalidSource(
        "text-number series require source cells",
    ))?;
    let established_width = if parsed.iter().all(|value| value.width == first.width) {
        first.width
    } else {
        0
    };
    if pattern.prefix != first.prefix
        || pattern.suffix != first.suffix
        || pattern.width != established_width
    {
        return Err(AutoFillError::InvalidWitness(
            "text pattern witness does not match the canonical source strings",
        ));
    }
    let step_i64 = step as i64;
    for (index, value) in parsed.iter().enumerate() {
        let expected =
            first
                .value
                .checked_add(step_i64.checked_mul(index as i64).ok_or(
                    AutoFillError::InvalidSource("text-number series exceeds safe integer bounds"),
                )?)
                .ok_or(AutoFillError::InvalidSource(
                    "text-number series exceeds safe integer bounds",
                ))?;
        if expected as f64 > MAX_SAFE_INTEGER
            || (expected as f64) < -MAX_SAFE_INTEGER
            || value.prefix != first.prefix
            || value.suffix != first.suffix
            || value.value != expected
        {
            return Err(AutoFillError::InvalidSource(
                "source strings do not match the requested text-number step",
            ));
        }
    }
    let anchor = first.value;
    plan_generated(sheet, request, write_range, |relative| {
        let value = anchor
            .checked_add(
                step_i64
                    .checked_mul(relative)
                    .ok_or(AutoFillError::InvalidSource(
                        "generated text-number exceeds safe integer bounds",
                    ))?,
            )
            .ok_or(AutoFillError::InvalidSource(
                "generated text-number exceeds safe integer bounds",
            ))?;
        if value as f64 > MAX_SAFE_INTEGER || (value as f64) < -MAX_SAFE_INTEGER {
            return Err(AutoFillError::InvalidSource(
                "generated text-number exceeds safe integer bounds",
            ));
        }
        format_text_number(pattern, value)
            .map(Value::Text)
            .ok_or(AutoFillError::InvalidSource(
                "generated text-number is invalid",
            ))
    })
}

fn builtin_list(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "builtin-weekday-short" => Some(&BUILTIN_WEEKDAY_SHORT),
        "builtin-weekday-long" => Some(&BUILTIN_WEEKDAY_LONG),
        "builtin-month-short" => Some(&BUILTIN_MONTH_SHORT),
        "builtin-month-long" => Some(&BUILTIN_MONTH_LONG),
        _ => None,
    }
}

fn supported_locale_language(locale: &str) -> Option<&str> {
    let mut parts = locale.split('-');
    let language = parts.next()?;
    if !matches!(language, "en" | "zh" | "tr" | "az") {
        return None;
    }

    let remaining: Vec<&str> = parts.collect();
    let canonical_script = |part: &str| {
        part.len() == 4
            && part.as_bytes()[0].is_ascii_uppercase()
            && part.as_bytes()[1..]
                .iter()
                .all(|byte| byte.is_ascii_lowercase())
    };
    let canonical_region = |part: &str| {
        (part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_uppercase()))
            || (part.len() == 3 && part.bytes().all(|byte| byte.is_ascii_digit()))
    };

    let canonical = match remaining.as_slice() {
        [] => true,
        [part] => canonical_script(part) || canonical_region(part),
        [script, region] => canonical_script(script) && canonical_region(region),
        _ => false,
    };
    canonical.then_some(language)
}

fn is_unicode_cased(character: char) -> bool {
    static CASED: OnceLock<Regex> = OnceLock::new();
    let mut encoded = [0_u8; 4];
    CASED
        .get_or_init(|| Regex::new(r"^\p{Cased}$").expect("valid Unicode Cased property"))
        .is_match(character.encode_utf8(&mut encoded))
}

fn is_unicode_case_ignorable(character: char) -> bool {
    static CASE_IGNORABLE: OnceLock<Regex> = OnceLock::new();
    let mut encoded = [0_u8; 4];
    CASE_IGNORABLE
        .get_or_init(|| {
            Regex::new(r"^\p{Case_Ignorable}$").expect("valid Unicode Case_Ignorable property")
        })
        .is_match(character.encode_utf8(&mut encoded))
}

fn is_final_sigma(chars: &[char], index: usize) -> bool {
    let preceded_by_cased = chars[..index]
        .iter()
        .rev()
        .find(|character| !is_unicode_case_ignorable(**character))
        .is_some_and(|character| is_unicode_cased(*character));
    let followed_by_cased = chars[index + 1..]
        .iter()
        .find(|character| !is_unicode_case_ignorable(**character))
        .is_some_and(|character| is_unicode_cased(*character));
    preceded_by_cased && !followed_by_cased
}

fn turkic_before_dot(chars: &[char], index: usize) -> bool {
    chars[index + 1..]
        .iter()
        .find(|character| matches!(canonical_combining_class(**character), 0 | 230))
        .is_some_and(|character| *character == '\u{0307}')
}

fn turkic_after_i(chars: &[char], index: usize) -> bool {
    chars[..index]
        .iter()
        .rev()
        .find(|character| matches!(canonical_combining_class(**character), 0 | 230))
        .is_some_and(|character| *character == 'I')
}

fn fold_named_value(value: &str, language: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let turkic = matches!(language, "tr" | "az");
    let mut folded = String::with_capacity(value.len());
    for (index, character) in chars.iter().copied().enumerate() {
        match character {
            'Σ' if is_final_sigma(&chars, index) => folded.push('ς'),
            'Σ' => folded.push('σ'),
            'I' if turkic && !turkic_before_dot(&chars, index) => folded.push('ı'),
            'İ' if turkic => folded.push('i'),
            '\u{0307}' if turkic && turkic_after_i(&chars, index) => {}
            _ => folded.extend(character.to_lowercase()),
        }
    }
    folded
}

fn plan_named_series(
    sheet: &crate::Sheet,
    request: &AutoFillRequest,
    write_range: Option<CellRange>,
) -> Result<Vec<PlannedCell>, AutoFillError> {
    let step = requested_step(request)?;
    if step != 1.0 && step != -1.0 {
        return Err(AutoFillError::InvalidStep(
            "named series step must be 1 or -1",
        ));
    }
    let witness = request.list.as_ref().ok_or(AutoFillError::InvalidWitness(
        "named series require a list witness",
    ))?;
    if witness.list_name.trim().is_empty()
        || witness.values.len() < 2
        || witness.values.len() > LIST_MAX_ITEMS
        || witness.values.iter().any(|value| value.trim().is_empty())
    {
        return Err(AutoFillError::InvalidWitness(
            "named series list witness is invalid",
        ));
    }
    let language = supported_locale_language(&witness.locale).ok_or(
        AutoFillError::InvalidWitness("named series locale must be supported and canonical"),
    )?;
    let normalized: Vec<String> = witness
        .values
        .iter()
        .map(|value| fold_named_value(value, language))
        .collect();
    let mut unique = std::collections::HashSet::with_capacity(normalized.len());
    if normalized.iter().any(|value| !unique.insert(value)) {
        return Err(AutoFillError::InvalidWitness(
            "named series list witness values must be unique",
        ));
    }
    // List names are protocol identifiers. Reserved prefixes always use
    // locale-independent ASCII casing, even for Turkish/Azeri witnesses.
    let lower_name = witness.list_name.to_ascii_lowercase();
    if request.series == AutoFillSeries::CustomList
        && (lower_name.starts_with("builtin-") || lower_name.starts_with("locale-"))
    {
        return Err(AutoFillError::InvalidWitness(
            "custom list witness may not use a reserved list name",
        ));
    }
    if lower_name.starts_with("builtin-") {
        if witness.locale != "en" {
            return Err(AutoFillError::InvalidWitness(
                "built-in list witness locale must be en",
            ));
        }
        let canonical = builtin_list(&witness.list_name).ok_or(AutoFillError::InvalidWitness(
            "unknown built-in list witness",
        ))?;
        if canonical.len() != witness.values.len()
            || canonical
                .iter()
                .zip(&witness.values)
                .any(|(left, right)| *left != right)
        {
            return Err(AutoFillError::InvalidWitness(
                "built-in list witness does not match the canonical list",
            ));
        }
    }
    match request.series {
        AutoFillSeries::WeekdayName
            if !(witness.list_name.starts_with("builtin-weekday-")
                || witness.list_name == "locale-weekday") =>
        {
            return Err(AutoFillError::InvalidWitness(
                "weekday series kind does not match its list witness",
            ))
        }
        AutoFillSeries::MonthName
            if !(witness.list_name.starts_with("builtin-month-")
                || witness.list_name == "locale-month") =>
        {
            return Err(AutoFillError::InvalidWitness(
                "month series kind does not match its list witness",
            ))
        }
        _ => {}
    }
    let source = source_texts(sheet, request)?;
    let indices: Vec<usize> = source
        .iter()
        .map(|value| {
            normalized
                .iter()
                .position(|candidate| candidate == &fold_named_value(value, language))
                .ok_or(AutoFillError::InvalidSource(
                    "source strings do not belong to the requested named list",
                ))
        })
        .collect::<Result<_, _>>()?;
    let step_i64 = step as i64;
    let first = *indices.first().ok_or(AutoFillError::InvalidSource(
        "named series require source cells",
    ))? as i64;
    let list_len = witness.values.len() as i64;
    if indices.iter().enumerate().any(|(index, actual)| {
        (first + step_i64 * index as i64).rem_euclid(list_len) != *actual as i64
    }) {
        return Err(AutoFillError::InvalidSource(
            "source strings do not match the requested named-list step",
        ));
    }
    plan_generated(sheet, request, write_range, |relative| {
        let index = (first + step_i64 * relative).rem_euclid(list_len) as usize;
        Ok(Value::Text(witness.values[index].clone()))
    })
}

fn ordered_source_addrs(request: &AutoFillRequest) -> Vec<CellAddress> {
    match request.direction {
        AutoFillDirection::Up | AutoFillDirection::Down => (request.source_range.start.row
            ..=request.source_range.end.row)
            .map(|row| CellAddress::new(row, request.source_range.start.col))
            .collect(),
        AutoFillDirection::Left | AutoFillDirection::Right => (request.source_range.start.col
            ..=request.source_range.end.col)
            .map(|col| CellAddress::new(request.source_range.start.row, col))
            .collect(),
    }
}

fn source_relative_index(request: &AutoFillRequest, addr: CellAddress) -> i64 {
    match request.direction {
        AutoFillDirection::Up | AutoFillDirection::Down => {
            addr.row as i64 - request.source_range.start.row as i64
        }
        AutoFillDirection::Left | AutoFillDirection::Right => {
            addr.col as i64 - request.source_range.start.col as i64
        }
    }
}

fn is_fill_integer(value: f64) -> bool {
    value.is_finite() && (value - value.round()).abs() < NUMBER_EPSILON
}

fn steps_match(actual: f64, requested: f64) -> bool {
    if requested.abs() >= NUMBER_EPSILON {
        return (actual - requested).abs() < NUMBER_EPSILON;
    }
    let magnitude = actual.abs().max(requested.abs()).max(f64::MIN_POSITIVE);
    (actual - requested).abs() <= f64::EPSILON * magnitude * 8.0
}

fn shift_axis(value: u32, delta: i64, absolute: bool, max: u32) -> Option<u32> {
    if absolute {
        return Some(value);
    }
    let shifted = value as i64 + delta;
    (shifted >= 0 && shifted < max as i64).then_some(shifted as u32)
}

fn shift_ref(addr: CellAddress, abs: RefAbs, drow: i64, dcol: i64) -> Option<CellAddress> {
    Some(CellAddress::new(
        shift_axis(addr.row, drow, abs.row, EXCEL_MAX_ROWS)?,
        shift_axis(addr.col, dcol, abs.col, EXCEL_MAX_COLS)?,
    ))
}

fn shift_range(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    abs: RangeAbs,
    drow: i64,
    dcol: i64,
) -> Option<(CellAddress, CellAddress)> {
    let shift_corner = |addr: CellAddress, corner_abs: RefAbs, end_corner: bool| {
        let row = if unbounded.rows_unbounded() {
            if end_corner {
                u32::MAX
            } else {
                0
            }
        } else {
            shift_axis(addr.row, drow, corner_abs.row, EXCEL_MAX_ROWS)?
        };
        let col = if unbounded.cols_unbounded() {
            if end_corner {
                u32::MAX
            } else {
                0
            }
        } else {
            shift_axis(addr.col, dcol, corner_abs.col, EXCEL_MAX_COLS)?
        };
        Some(CellAddress::new(row, col))
    };
    Some((
        shift_corner(start, abs.start, false)?,
        shift_corner(end, abs.end, true)?,
    ))
}

fn shift_fill_formula(expr: &Expr, drow: i64, dcol: i64) -> Result<Expr, AutoFillError> {
    let shifted = match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) | Expr::Name(_) => {
            expr.clone()
        }
        Expr::CellRef(addr, abs) => shift_ref(*addr, *abs, drow, dcol)
            .map(|addr| Expr::CellRef(addr, *abs))
            .unwrap_or_else(|| Expr::Error(einfach_core::ValueError::InvalidRef)),
        Expr::Range {
            start,
            end,
            unbounded,
            abs,
        } => shift_range(*start, *end, *unbounded, *abs, drow, dcol)
            .map(|(start, end)| Expr::Range {
                start,
                end,
                unbounded: *unbounded,
                abs: *abs,
            })
            .unwrap_or_else(|| Expr::Error(einfach_core::ValueError::InvalidRef)),
        Expr::SheetRef { sheet, addr, abs } => shift_ref(*addr, *abs, drow, dcol)
            .map(|addr| Expr::SheetRef {
                sheet: sheet.clone(),
                addr,
                abs: *abs,
            })
            .unwrap_or_else(|| Expr::Error(einfach_core::ValueError::InvalidRef)),
        Expr::SheetRange {
            sheet,
            start,
            end,
            unbounded,
            abs,
        } => shift_range(*start, *end, *unbounded, *abs, drow, dcol)
            .map(|(start, end)| Expr::SheetRange {
                sheet: sheet.clone(),
                start,
                end,
                unbounded: *unbounded,
                abs: *abs,
            })
            .unwrap_or_else(|| Expr::Error(einfach_core::ValueError::InvalidRef)),
        Expr::Negate(inner) => Expr::Negate(Box::new(shift_fill_formula(inner, drow, dcol)?)),
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(shift_fill_formula(left, drow, dcol)?),
            right: Box::new(shift_fill_formula(right, drow, dcol)?),
        },
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|arg| shift_fill_formula(arg, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        },
        Expr::SpillRef(anchor) => {
            Expr::SpillRef(Box::new(shift_fill_formula(anchor, drow, dcol)?))
        }
        Expr::DynamicRange { start, end } => Expr::DynamicRange {
            start: Box::new(shift_fill_formula(start, drow, dcol)?),
            end: Box::new(shift_fill_formula(end, drow, dcol)?),
        },
        Expr::Call(callee, args) => Expr::Call(
            Box::new(shift_fill_formula(callee, drow, dcol)?),
            args.iter()
                .map(|arg| shift_fill_formula(arg, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Expr::ArrayLit { .. } => expr.clone(),
        Expr::MultiArea(parts) => Expr::MultiArea(
            parts
                .iter()
                .map(|part| shift_fill_formula(part, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => return Err(AutoFillError::UnsupportedFormula),
    };
    Ok(shifted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Align, NumberFormat};

    fn addr(value: &str) -> CellAddress {
        CellAddress::parse(value).unwrap()
    }

    fn range(start: &str, end: &str) -> CellRange {
        CellRange::new(addr(start), addr(end))
    }

    fn request(
        source: CellRange,
        target: CellRange,
        direction: AutoFillDirection,
        series: AutoFillSeries,
        step: Option<f64>,
    ) -> AutoFillRequest {
        AutoFillRequest {
            sheet_idx: 0,
            source_range: source,
            target_range: target,
            direction,
            series,
            step,
            text_pattern: None,
            list: None,
        }
    }

    #[test]
    fn copy_shifts_relative_formula_axes_and_copies_effective_format() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(3.0));
        assert!(wb.set_formula(0, "B1", "=A1+$A1+A$1+$A$1+Sheet1!A1"));
        wb.sheet_mut(0).unwrap().set_format(
            "B1",
            CellFormat {
                number_format: NumberFormat::Decimal {
                    digits: 2,
                    thousands: false,
                },
                align: Align::Right,
                ..CellFormat::default()
            },
        );

        let report = wb
            .apply_auto_fill(&request(
                range("B1", "B1"),
                range("B1", "B2"),
                AutoFillDirection::Down,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();

        assert_eq!(report.written, 1);
        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("B2")).as_deref(),
            Some("=((((A2+$A2)+A$1)+$A$1)+Sheet1!A2)")
        );
        assert_eq!(
            wb.sheet(0).unwrap().get_format("B2").number_format,
            NumberFormat::Decimal {
                digits: 2,
                thousands: false
            }
        );
    }

    #[test]
    fn integer_and_decimal_fill_work_in_reverse_directions() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A3", Value::Number(3.0));
        wb.set_cell(0, "A4", Value::Number(5.0));
        wb.apply_auto_fill(&request(
            range("A3", "A4"),
            range("A1", "A4"),
            AutoFillDirection::Up,
            AutoFillSeries::IntegerStep,
            Some(2.0),
        ))
        .unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A1")),
            Value::Number(-1.0)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A2")),
            Value::Number(1.0)
        );

        wb.set_cell(0, "C1", Value::Number(1.25));
        wb.set_cell(0, "D1", Value::Number(1.75));
        wb.apply_auto_fill(&request(
            range("C1", "D1"),
            range("A1", "D1"),
            AutoFillDirection::Left,
            AutoFillSeries::DecimalStep,
            Some(0.5),
        ))
        .unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A1")),
            Value::Number(0.25)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B1")),
            Value::Number(0.75)
        );
    }

    #[test]
    fn formula_copy_shifts_absolute_and_relative_axes_in_all_directions() {
        let cases = [
            (
                AutoFillDirection::Down,
                range("C3", "C4"),
                "C4",
                "=(((B3+$B3)+B$2)+$B$2)",
            ),
            (
                AutoFillDirection::Up,
                range("C2", "C3"),
                "C2",
                "=(((B1+$B1)+B$2)+$B$2)",
            ),
            (
                AutoFillDirection::Right,
                range("C3", "D3"),
                "D3",
                "=(((C2+$B2)+C$2)+$B$2)",
            ),
            (
                AutoFillDirection::Left,
                range("B3", "C3"),
                "B3",
                "=(((A2+$B2)+A$2)+$B$2)",
            ),
        ];

        for (direction, target, written_addr, expected) in cases {
            let mut wb = Workbook::new();
            assert!(wb.set_formula(0, "C3", "=B2+$B2+B$2+$B$2"));
            wb.apply_auto_fill(&request(
                range("C3", "C3"),
                target,
                direction,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();
            assert_eq!(
                wb.sheet(0)
                    .unwrap()
                    .formula_text_at(addr(written_addr))
                    .as_deref(),
                Some(expected),
                "{direction:?}"
            );
        }
    }

    #[test]
    fn formula_copy_renders_ref_when_relative_shift_leaves_the_grid() {
        let cases = [
            (
                "B1",
                "=A1+$C$1",
                range("A1", "B1"),
                AutoFillDirection::Left,
                "A1",
                "=(#REF!+$C$1)",
            ),
            (
                "A2",
                "=A1+$B$1",
                range("A1", "A2"),
                AutoFillDirection::Up,
                "A1",
                "=(#REF!+$B$1)",
            ),
        ];

        for (source_addr, formula, target, direction, written_addr, expected) in cases {
            let mut wb = Workbook::new();
            assert!(wb.set_formula(0, source_addr, formula));
            wb.apply_auto_fill(&request(
                range(source_addr, source_addr),
                target,
                direction,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();
            assert_eq!(
                wb.sheet(0)
                    .unwrap()
                    .formula_text_at(addr(written_addr))
                    .as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn formula_self_cycle_lands_as_cycle_error_but_still_copies_format() {
        // Excel parity (was `AutoFillError::FormulaCycle`): a fill whose
        // formula closes a dependency cycle now ALWAYS lands, exactly as if
        // the cell had been typed by hand. `Workbook::set_formula` itself
        // never installs a self-referencing formula — it writes a plain
        // `#CYCLE!` value instead — and `apply_auto_fill` reuses that exact
        // path (`WorkbookLoader::set_formula_at`), so the target here ends
        // up with no formula text at all, only the error value.
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(7.0));
        wb.sheet_mut(0).unwrap().set_format(
            "A1",
            CellFormat {
                bold: true,
                ..CellFormat::default()
            },
        );
        assert!(wb.set_formula(0, "B1", "=$A$1"));
        wb.sheet_mut(0).unwrap().set_format(
            "B1",
            CellFormat {
                italic: true,
                ..CellFormat::default()
            },
        );

        let report = wb
            .apply_auto_fill(&request(
                range("B1", "B1"),
                range("A1", "B1"),
                AutoFillDirection::Left,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();
        assert_eq!(report.written, 1);

        assert_eq!(wb.sheet(0).unwrap().formula_text_at(addr("A1")), None);
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A1")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        // Fill-copy format propagation is independent of the cycle: A1
        // still takes on B1's effective format like any other copy target.
        assert!(wb.sheet(0).unwrap().get_format("A1").italic);
        assert!(!wb.sheet(0).unwrap().get_format("A1").bold);

        // B1's own formula is untouched, but it now reads A1 — which holds
        // the cycle error — so the error propagates through normal
        // evaluation, not through any cycle of B1's own.
        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("B1")).as_deref(),
            Some("=$A$1")
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B1")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
    }

    #[test]
    fn formula_batch_only_cycle_lands_as_cycle_error_for_both_cells() {
        // Neither A1 nor A2 closes a cycle against the OTHER's pre-fill
        // state — `set_formula_at` validates each cell against the
        // workbook as it stood BEFORE this batch flushes, exactly like
        // typing the two formulas in one at a time against a workbook that
        // has not yet seen the sibling write. Both therefore install as
        // real formulas; the mutual cycle only exists once both are live,
        // and the Store's own runtime cyclic-eval guard catches it on
        // first read (see `excel/rust/core/src/store.rs` "runtime cycle guard").
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(10.0));
        wb.set_cell(0, "A2", Value::Number(20.0));
        wb.sheet_mut(0).unwrap().set_format(
            "A2",
            CellFormat {
                bold: true,
                ..CellFormat::default()
            },
        );
        assert!(wb.set_formula(0, "B1", "=$A$2"));
        assert!(wb.set_formula(0, "B2", "=$A$1"));

        let report = wb
            .apply_auto_fill(&request(
                range("B1", "B2"),
                range("A1", "B2"),
                AutoFillDirection::Left,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();
        assert_eq!(report.written, 2);

        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("A1")).as_deref(),
            Some("=$A$2")
        );
        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("A2")).as_deref(),
            Some("=$A$1")
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A1")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A2")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        // Format propagation still runs: A2's pre-fill bold format is
        // replaced by B2's (default) effective format like any other copy
        // target — the cycle does not short-circuit it.
        assert!(!wb.sheet(0).unwrap().get_format("A2").bold);
    }

    #[test]
    fn running_total_batch_cycle_lands_while_sibling_column_still_computes() {
        // Regression for the FormulaCycle removal: a "running total"-style
        // fill (`previous total + this row's data`) dragged DOWN over a
        // range that closes a cycle must still land, with only the
        // cycle-closing cells reading `#CYCLE!` and every other cell in the
        // same drag computing normally. A genuinely relative running total
        // (no `$`) can never close a cycle by itself — a fixed per-row
        // shift only ever walks further from the source — so the mutual
        // reference here is anchored with absolute refs, mirroring how a
        // batch-only cycle actually arises in practice (two new formulas
        // that only reference each other once both are live).
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(1.0));
        wb.set_cell(0, "A2", Value::Number(2.0));
        assert!(wb.set_formula(0, "C1", "=$D$2+$A$1"));
        assert!(wb.set_formula(0, "D1", "=$C$2+$A$2"));
        assert!(wb.set_formula(0, "E1", "=A1*2"));

        let report = wb
            .apply_auto_fill(&request(
                range("C1", "E1"),
                range("C1", "E2"),
                AutoFillDirection::Down,
                AutoFillSeries::Copy,
                None,
            ))
            .unwrap();
        assert_eq!(report.written, 3);

        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("C2")).as_deref(),
            Some("=($D$2+$A$1)")
        );
        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("D2")).as_deref(),
            Some("=($C$2+$A$2)")
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("C2")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("D2")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        // The cycle propagates back to the untouched source cells that
        // feed into it…
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("C1")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("D1")),
            Value::Error(einfach_core::ValueError::CyclicRef)
        );
        // …but the sibling column E, filled in the very same batch, is
        // completely unaffected and computes normally.
        assert_eq!(
            wb.sheet(0).unwrap().formula_text_at(addr("E2")).as_deref(),
            Some("=(A2*2)")
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("E1")),
            Value::Number(2.0)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("E2")),
            Value::Number(4.0)
        );
    }

    #[test]
    fn copy_noop_validates_sheet_and_writes_nothing() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(9.0));
        wb.sheet_mut(0).unwrap().set_format(
            "A1",
            CellFormat {
                bold: true,
                ..CellFormat::default()
            },
        );
        let mut noop = request(
            range("A1", "A1"),
            range("A1", "A1"),
            AutoFillDirection::Down,
            AutoFillSeries::Copy,
            None,
        );
        noop.sheet_idx = 1;
        assert_eq!(
            wb.apply_auto_fill(&noop),
            Err(AutoFillError::SheetOutOfRange)
        );

        noop.sheet_idx = 0;
        assert_eq!(
            wb.apply_auto_fill(&noop).unwrap(),
            AutoFillReport {
                write_range: None,
                written: 0,
            }
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A1")),
            Value::Number(9.0)
        );
        assert!(wb.sheet(0).unwrap().get_format("A1").bold);
    }

    #[test]
    fn linear_trend_uses_least_squares_instead_of_the_last_delta() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(1.0));
        wb.set_cell(0, "A2", Value::Number(3.0));
        wb.set_cell(0, "A3", Value::Number(2.0));

        wb.apply_auto_fill(&request(
            range("A1", "A3"),
            range("A1", "A5"),
            AutoFillDirection::Down,
            AutoFillSeries::LinearTrend,
            Some(0.5),
        ))
        .unwrap();

        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A4")),
            Value::Number(3.0)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A5")),
            Value::Number(3.5)
        );
    }

    #[test]
    fn calendar_series_support_day_week_and_end_of_month_rules() {
        let mut wb = Workbook::new();
        let date_format = CellFormat {
            number_format: NumberFormat::Date("yyyy-mm-dd".to_string()),
            ..CellFormat::default()
        };
        let serial = |year, month, day| {
            excel_date_parts_to_serial(ExcelDateParts {
                year,
                month,
                day,
                fraction: 0.0,
            })
            .unwrap()
        };

        for (cell, value) in [
            ("A1", serial(2024, 1, 31)),
            ("A2", serial(2024, 2, 29)),
            ("B1", serial(2024, 1, 1)),
            ("B2", serial(2024, 1, 8)),
            ("C1", serial(2024, 1, 1)),
            ("C2", serial(2024, 1, 3)),
        ] {
            wb.set_cell(0, cell, Value::Number(value));
            wb.sheet_mut(0)
                .unwrap()
                .set_format(cell, date_format.clone());
        }

        wb.apply_auto_fill(&request(
            range("A1", "A2"),
            range("A1", "A4"),
            AutoFillDirection::Down,
            AutoFillSeries::DateMonth,
            Some(1.0),
        ))
        .unwrap();
        wb.apply_auto_fill(&request(
            range("B1", "B2"),
            range("B1", "B3"),
            AutoFillDirection::Down,
            AutoFillSeries::DateWeek,
            Some(1.0),
        ))
        .unwrap();
        wb.apply_auto_fill(&request(
            range("C1", "C2"),
            range("C1", "C3"),
            AutoFillDirection::Down,
            AutoFillSeries::DateDay,
            Some(2.0),
        ))
        .unwrap();

        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A3")),
            Value::Number(serial(2024, 3, 31))
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A4")),
            Value::Number(serial(2024, 4, 30))
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B3")),
            Value::Number(serial(2024, 1, 15))
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("C3")),
            Value::Number(serial(2024, 1, 5))
        );
        assert_eq!(
            wb.sheet(0).unwrap().get_format("A3").number_format,
            date_format.number_format
        );
    }

    #[test]
    fn calendar_day_series_crosses_excel_1900_leap_bug_in_both_directions() {
        let mut wb = Workbook::new();
        let date_format = CellFormat {
            number_format: NumberFormat::Date("yyyy-mm-dd".to_string()),
            ..CellFormat::default()
        };
        for (cell, value) in [("A1", 59.0), ("A2", 60.0), ("B2", 60.0), ("B3", 61.0)] {
            wb.set_cell(0, cell, Value::Number(value));
            wb.sheet_mut(0)
                .unwrap()
                .set_format(cell, date_format.clone());
        }

        wb.apply_auto_fill(&request(
            range("A1", "A2"),
            range("A1", "A3"),
            AutoFillDirection::Down,
            AutoFillSeries::DateDay,
            Some(1.0),
        ))
        .unwrap();
        wb.apply_auto_fill(&request(
            range("B2", "B3"),
            range("B1", "B3"),
            AutoFillDirection::Up,
            AutoFillSeries::DateDay,
            Some(1.0),
        ))
        .unwrap();

        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A3")),
            Value::Number(61.0)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B1")),
            Value::Number(59.0)
        );
    }

    #[test]
    fn calendar_series_ignores_number_format_and_operates_on_the_raw_serial() {
        // Excel parity: dates are plain serial numbers, and fill arithmetic
        // runs on the serial regardless of number format — format affects
        // display only. A date-kind series must not be gated on the source
        // cell having an effective date format (it previously was); only
        // the VALUE-TYPE requirement (canonical, non-formula numbers)
        // still applies.
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(45_292.0));
        wb.set_cell(0, "A2", Value::Number(45_293.0));
        assert_eq!(
            wb.sheet(0).unwrap().get_format("A1").number_format,
            NumberFormat::General
        );

        let report = wb
            .apply_auto_fill(&request(
                range("A1", "A2"),
                range("A1", "A4"),
                AutoFillDirection::Down,
                AutoFillSeries::DateDay,
                Some(1.0),
            ))
            .unwrap();
        assert_eq!(report.written, 2);

        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A3")),
            Value::Number(45_294.0)
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A4")),
            Value::Number(45_295.0)
        );
        // Format propagation is unchanged by this fix: the written cells
        // copy the source's (unformatted) effective format, they are not
        // retroactively stamped as dates.
        assert_eq!(
            wb.sheet(0).unwrap().get_format("A4").number_format,
            NumberFormat::General
        );
    }

    #[test]
    fn text_number_and_named_lists_extend_and_wrap() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Text("Item01".to_string()));
        wb.set_cell(0, "A2", Value::Text("Item02".to_string()));
        let mut text_request = request(
            range("A1", "A2"),
            range("A1", "A4"),
            AutoFillDirection::Down,
            AutoFillSeries::TextNumber,
            Some(1.0),
        );
        text_request.text_pattern = Some(AutoFillTextPattern {
            prefix: "Item".to_string(),
            suffix: String::new(),
            width: 2,
        });
        wb.apply_auto_fill(&text_request).unwrap();

        wb.set_cell(0, "B1", Value::Text("Sun".to_string()));
        let mut weekday_request = request(
            range("B1", "B1"),
            range("B1", "B3"),
            AutoFillDirection::Down,
            AutoFillSeries::WeekdayName,
            Some(1.0),
        );
        weekday_request.list = Some(AutoFillListWitness {
            list_name: "builtin-weekday-short".to_string(),
            values: BUILTIN_WEEKDAY_SHORT
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            locale: "en".to_string(),
        });
        wb.apply_auto_fill(&weekday_request).unwrap();

        wb.set_cell(0, "C1", Value::Text("small".to_string()));
        wb.set_cell(0, "C2", Value::Text("medium".to_string()));
        let mut custom_request = request(
            range("C1", "C2"),
            range("C1", "C4"),
            AutoFillDirection::Down,
            AutoFillSeries::CustomList,
            Some(1.0),
        );
        custom_request.list = Some(AutoFillListWitness {
            list_name: "sizes".to_string(),
            values: ["small", "medium", "large"]
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            locale: "en".to_string(),
        });
        wb.apply_auto_fill(&custom_request).unwrap();

        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A3")),
            Value::Text("Item03".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A4")),
            Value::Text("Item04".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B2")),
            Value::Text("Mon".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("B3")),
            Value::Text("Tue".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("C3")),
            Value::Text("large".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("C4")),
            Value::Text("small".to_string())
        );

        wb.set_cell(0, "D1", Value::Text("Dec".to_string()));
        let mut month_request = request(
            range("D1", "D1"),
            range("D1", "D3"),
            AutoFillDirection::Down,
            AutoFillSeries::MonthName,
            Some(1.0),
        );
        month_request.list = Some(AutoFillListWitness {
            list_name: "builtin-month-short".to_string(),
            values: BUILTIN_MONTH_SHORT
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            locale: "en".to_string(),
        });
        wb.apply_auto_fill(&month_request).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("D2")),
            Value::Text("Jan".to_string())
        );
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("D3")),
            Value::Text("Feb".to_string())
        );
    }

    #[test]
    fn named_lists_require_supported_canonical_locale_and_use_turkish_case_fold() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Text("ı".to_string()));
        let mut request = request(
            range("A1", "A1"),
            range("A1", "A2"),
            AutoFillDirection::Down,
            AutoFillSeries::CustomList,
            Some(1.0),
        );
        request.list = Some(AutoFillListWitness {
            list_name: "letters".to_string(),
            values: vec!["I".to_string(), "İ".to_string()],
            locale: "tr-TR".to_string(),
        });
        wb.apply_auto_fill(&request).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A2")),
            Value::Text("İ".to_string())
        );

        for (locale, first, expected) in [("zh-Hans-CN", "甲", "乙"), ("az-Latn-AZ", "ı", "İ")]
        {
            let mut localized = request.clone();
            localized.list = Some(AutoFillListWitness {
                list_name: "localized".to_string(),
                values: if locale.starts_with("zh") {
                    vec!["甲".to_string(), "乙".to_string()]
                } else {
                    vec!["I".to_string(), "İ".to_string()]
                },
                locale: locale.to_string(),
            });
            wb.set_cell(0, "B1", Value::Text(first.to_string()));
            localized.source_range = range("B1", "B1");
            localized.target_range = range("B1", "B2");
            wb.apply_auto_fill(&localized).unwrap();
            assert_eq!(
                wb.sheet(0).unwrap().peek_value(addr("B2")),
                Value::Text(expected.to_string())
            );
        }

        for locale in ["tr-tr", "fr"] {
            let mut invalid = request.clone();
            invalid.list.as_mut().unwrap().locale = locale.to_string();
            assert!(matches!(
                wb.apply_auto_fill(&invalid),
                Err(AutoFillError::InvalidWitness(_))
            ));
        }
    }

    #[test]
    fn named_list_fold_matches_ecma_402_for_sigma_and_turkic_i_contexts() {
        // Golden outputs from String.prototype.toLocaleLowerCase for the
        // supported locale families. The contextual cases are where Rust's
        // plain str::to_lowercase differs from ECMA-402.
        for language in ["en", "zh"] {
            for (source, expected) in [
                ("ΟΣ", "ος"),
                ("ΟΣΑ", "οσα"),
                ("A'Σ", "a'ς"),
                ("Σ", "σ"),
                ("Iİ", "ii\u{0307}"),
            ] {
                assert_eq!(fold_named_value(source, language), expected);
            }
        }
        for language in ["tr", "az"] {
            for (source, expected) in [
                ("ΟΣ", "ος"),
                ("I\u{0307}", "i"),
                ("I\u{0323}\u{0307}", "i\u{0323}"),
                ("I\u{0307}\u{0323}", "i\u{0323}"),
                ("I\u{0301}\u{0307}", "ı\u{0301}\u{0307}"),
                ("İI", "iı"),
            ] {
                assert_eq!(fold_named_value(source, language), expected);
            }
        }

        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Text("ος".to_string()));
        let mut request = request(
            range("A1", "A1"),
            range("A1", "A2"),
            AutoFillDirection::Down,
            AutoFillSeries::CustomList,
            Some(1.0),
        );
        request.list = Some(AutoFillListWitness {
            list_name: "greek".to_string(),
            values: vec!["ΟΣ".to_string(), "ΟΣΑ".to_string()],
            locale: "en".to_string(),
        });
        wb.apply_auto_fill(&request).unwrap();
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A2")),
            Value::Text("ΟΣΑ".to_string())
        );
    }

    #[test]
    fn built_in_named_lists_reject_locale_tampering() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Text("Mon".to_string()));
        wb.set_cell(0, "A2", Value::Text("untouched".to_string()));
        let mut request = request(
            range("A1", "A1"),
            range("A1", "A2"),
            AutoFillDirection::Down,
            AutoFillSeries::WeekdayName,
            Some(1.0),
        );
        request.list = Some(AutoFillListWitness {
            list_name: "builtin-weekday-short".to_string(),
            values: BUILTIN_WEEKDAY_SHORT
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            locale: "zh".to_string(),
        });

        assert!(matches!(
            wb.apply_auto_fill(&request),
            Err(AutoFillError::InvalidWitness(
                "built-in list witness locale must be en"
            ))
        ));
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A2")),
            Value::Text("untouched".to_string())
        );
    }

    #[test]
    fn failed_preflight_does_not_mutate_values_or_formats() {
        let mut wb = Workbook::new();
        wb.set_cell(0, "A1", Value::Number(1.0));
        wb.set_cell(0, "A2", Value::Number(3.0));
        wb.set_cell(0, "A3", Value::Number(99.0));
        wb.sheet_mut(0).unwrap().set_format(
            "A3",
            CellFormat {
                bold: true,
                ..CellFormat::default()
            },
        );

        let error = wb
            .apply_auto_fill(&request(
                range("A1", "A2"),
                range("A1", "A3"),
                AutoFillDirection::Down,
                AutoFillSeries::IntegerStep,
                Some(4.0),
            ))
            .unwrap_err();
        assert!(matches!(error, AutoFillError::InvalidSource(_)));
        assert_eq!(
            wb.sheet(0).unwrap().peek_value(addr("A3")),
            Value::Number(99.0)
        );
        assert!(wb.sheet(0).unwrap().get_format("A3").bold);
    }

    #[test]
    fn validate_geometry_rejects_a_target_range_over_the_cell_budget() {
        // Two full columns (2 * MAX_AUTO_FILL_CELLS) — well over budget.
        // `validate_geometry` never touches the workbook, so this asserts
        // the rejection without materializing anything.
        let over_cap = request(
            range("A1", "B1"),
            range("A1", "B1048576"),
            AutoFillDirection::Down,
            AutoFillSeries::Copy,
            None,
        );
        assert_eq!(
            validate_geometry(&over_cap),
            Err(AutoFillError::TooLarge {
                requested_cells: 2 * MAX_AUTO_FILL_CELLS,
            })
        );
    }

    #[test]
    fn validate_geometry_accepts_a_target_range_exactly_at_the_cell_budget() {
        // Exactly one full Excel column: MAX_AUTO_FILL_CELLS cells, right at
        // the boundary. The cap must not be off-by-one in either direction.
        let at_cap = request(
            range("A1", "A1"),
            range("A1", "A1048576"),
            AutoFillDirection::Down,
            AutoFillSeries::Copy,
            None,
        );
        assert_eq!(validate_geometry(&at_cap), Ok(()));
    }
}
