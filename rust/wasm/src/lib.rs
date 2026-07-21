use einfach_core::{CellListener, Value, ValueError};
use einfach_excel_core::{
    Align, BorderSpec, BorderStyle, CellAddress, CellBorders, CellFormat, CellRange,
    CellSubscription, ColumnFilterRule, CustomFunctionRegistry, DepGraphStats, FilterApplyReport,
    FilterError, FilterSnapshot, FormatRangeSnapshot, HiddenRowsSnapshot, NumberFormat,
    RangeFormatSnapshotLayer, Rotation, Sheet, SheetError, SheetFilterState, SheetHiddenRows,
    SortDirection, SortKey, SortRangeError, SortRangeReport, TableEntry, TableError,
    TableRegistrySnapshot, TotalsFunction, VerticalAlign, Workbook, WorkbookError,
    MAX_FILTER_PREDICATE_CELLS,
};
use serde::{de, Deserialize, Serialize};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

/// Wire format for `CellFormat` over wasm-bindgen. Mirrors `CellFormat` /
/// `NumberFormat` / `Align` but tagged-by-string so the JS side can build
/// these from plain object literals (`{ numberFormat: { kind: 'percent',
/// digits: 0 }, bold: true }`) without learning Rust's serde tags.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CellFormatJSON {
    #[serde(
        default,
        rename = "numberFormat",
        skip_serializing_if = "Option::is_none"
    )]
    number_format: Option<NumberFormatJSON>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    align: Option<String>,
    #[serde(default, rename = "fontSize", skip_serializing_if = "Option::is_none")]
    font_size: Option<u32>,
    #[serde(
        default,
        rename = "fgColor",
        alias = "color",
        skip_serializing_if = "Option::is_none"
    )]
    fg_color: Option<String>,
    #[serde(
        default,
        rename = "bgColor",
        alias = "background",
        skip_serializing_if = "Option::is_none"
    )]
    bg_color: Option<String>,
    #[serde(
        default,
        rename = "fontFamily",
        skip_serializing_if = "Option::is_none"
    )]
    font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    strikethrough: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    indent: Option<u8>,
    #[serde(
        default,
        rename = "verticalAlign",
        skip_serializing_if = "Option::is_none"
    )]
    vertical_align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rotation: Option<RotationJSON>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    borders: Option<CellBordersJSON>,
}

/// Wire format for cell rotation. JS sends `number | 'vertical'`; the
/// untagged enum lets serde pick the matching variant automatically.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum RotationJSON {
    Vertical(String),
    Degrees(i16),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CellBordersJSON {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top: Option<BorderSpecJSON>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    right: Option<BorderSpecJSON>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bottom: Option<BorderSpecJSON>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    left: Option<BorderSpecJSON>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BorderSpecJSON {
    /// One of "none" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double".
    style: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NumberFormatJSON {
    /// One of "general" | "decimal" | "percent" | "currency" | "date" | "custom".
    kind: String,
    #[serde(default)]
    digits: Option<u8>,
    /// Currency symbol — used when `kind == "currency"`.
    #[serde(default)]
    symbol: Option<String>,
    /// Pattern — used when `kind == "date"` or `kind == "custom"`.
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
        let vertical_align = match self.vertical_align.as_deref() {
            Some("top") => VerticalAlign::Top,
            Some("center") => VerticalAlign::Center,
            Some("bottom") => VerticalAlign::Bottom,
            Some("justify") => VerticalAlign::Justify,
            Some("distributed") => VerticalAlign::Distributed,
            _ => VerticalAlign::Default,
        };
        let rotation = match self.rotation {
            Some(RotationJSON::Vertical(ref s)) if s == "vertical" => Rotation::Vertical,
            Some(RotationJSON::Degrees(d)) => Rotation::Degrees(d),
            _ => Rotation::None,
        };
        CellFormat {
            number_format,
            bold: self.bold.unwrap_or(false),
            italic: self.italic.unwrap_or(false),
            align,
            font_size: self.font_size,
            color: self.fg_color,
            background: self.bg_color,
            font_family: self.font_family,
            underline: self.underline.unwrap_or(false),
            strikethrough: self.strikethrough.unwrap_or(false),
            wrap_text: self.wrap.unwrap_or(false),
            indent: self.indent.unwrap_or(0),
            vertical_align,
            rotation,
            borders: self
                .borders
                .map(CellBordersJSON::into_borders)
                .unwrap_or_default(),
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
            font_family: fmt.font_family.clone(),
            underline: if fmt.underline { Some(true) } else { None },
            strikethrough: if fmt.strikethrough { Some(true) } else { None },
            wrap: if fmt.wrap_text { Some(true) } else { None },
            indent: if fmt.indent > 0 {
                Some(fmt.indent)
            } else {
                None
            },
            vertical_align: match fmt.vertical_align {
                VerticalAlign::Default => None,
                VerticalAlign::Top => Some("top".into()),
                VerticalAlign::Center => Some("center".into()),
                VerticalAlign::Bottom => Some("bottom".into()),
                VerticalAlign::Justify => Some("justify".into()),
                VerticalAlign::Distributed => Some("distributed".into()),
            },
            rotation: match fmt.rotation {
                Rotation::None => None,
                Rotation::Degrees(d) => Some(RotationJSON::Degrees(d)),
                Rotation::Vertical => Some(RotationJSON::Vertical("vertical".into())),
            },
            borders: CellBordersJSON::from_borders(&fmt.borders),
        }
    }
}

impl CellBordersJSON {
    fn into_borders(self) -> CellBorders {
        CellBorders {
            top: self.top.map(BorderSpecJSON::into_spec),
            right: self.right.map(BorderSpecJSON::into_spec),
            bottom: self.bottom.map(BorderSpecJSON::into_spec),
            left: self.left.map(BorderSpecJSON::into_spec),
        }
    }

    fn from_borders(borders: &CellBorders) -> Option<Self> {
        if borders == &CellBorders::default() {
            return None;
        }
        Some(CellBordersJSON {
            top: borders.top.as_ref().map(BorderSpecJSON::from_spec),
            right: borders.right.as_ref().map(BorderSpecJSON::from_spec),
            bottom: borders.bottom.as_ref().map(BorderSpecJSON::from_spec),
            left: borders.left.as_ref().map(BorderSpecJSON::from_spec),
        })
    }
}

impl BorderSpecJSON {
    fn into_spec(self) -> BorderSpec {
        let style = match self.style.as_str() {
            "thin" => BorderStyle::Thin,
            "medium" => BorderStyle::Medium,
            "thick" => BorderStyle::Thick,
            "dashed" => BorderStyle::Dashed,
            "dotted" => BorderStyle::Dotted,
            "double" => BorderStyle::Double,
            _ => BorderStyle::None,
        };
        BorderSpec {
            style,
            color: self.color,
        }
    }

    fn from_spec(spec: &BorderSpec) -> Self {
        BorderSpecJSON {
            style: match spec.style {
                BorderStyle::None => "none".into(),
                BorderStyle::Thin => "thin".into(),
                BorderStyle::Medium => "medium".into(),
                BorderStyle::Thick => "thick".into(),
                BorderStyle::Dashed => "dashed".into(),
                BorderStyle::Dotted => "dotted".into(),
                BorderStyle::Double => "double".into(),
            },
            color: spec.color.clone(),
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ViewportRowHeightJSON {
    #[serde(rename = "rowIndex")]
    row_index: u32,
    #[serde(rename = "heightPx")]
    height_px: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ViewportColumnWidthJSON {
    #[serde(rename = "colIndex")]
    col_index: u32,
    #[serde(rename = "widthPx")]
    width_px: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ViewportSizeSnapshotJSON {
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
    #[serde(rename = "rowHeights", default, skip_serializing_if = "Vec::is_empty")]
    row_heights: Vec<ViewportRowHeightJSON>,
    #[serde(rename = "colWidths", default, skip_serializing_if = "Vec::is_empty")]
    col_widths: Vec<ViewportColumnWidthJSON>,
}

impl ViewportSizeSnapshotJSON {
    fn from_sheet_range(sheet: &Sheet, range: CellRange, sheet_idx: Option<u32>) -> Self {
        let range = range.normalize();
        ViewportSizeSnapshotJSON {
            sheet: sheet_idx,
            start_row: range.start.row,
            start_col: range.start.col,
            end_row: range.end.row,
            end_col: range.end.col,
            row_heights: sheet
                .row_heights_in_range(range.start.row, range.end.row)
                .into_iter()
                .map(|(row_index, height_px)| ViewportRowHeightJSON {
                    row_index,
                    height_px,
                })
                .collect(),
            col_widths: sheet
                .col_widths_in_range(range.start.col, range.end.col)
                .into_iter()
                .map(|(col_index, width_px)| ViewportColumnWidthJSON {
                    col_index,
                    width_px,
                })
                .collect(),
        }
    }

    fn from_full_sheet(sheet: &Sheet, sheet_idx: u32) -> Self {
        ViewportSizeSnapshotJSON {
            sheet: Some(sheet_idx),
            start_row: 0,
            start_col: 0,
            end_row: u32::MAX,
            end_col: u32::MAX,
            row_heights: sheet
                .all_row_heights()
                .into_iter()
                .map(|(row_index, height_px)| ViewportRowHeightJSON {
                    row_index,
                    height_px,
                })
                .collect(),
            col_widths: sheet
                .all_col_widths()
                .into_iter()
                .map(|(col_index, width_px)| ViewportColumnWidthJSON {
                    col_index,
                    width_px,
                })
                .collect(),
        }
    }

    fn is_empty(&self) -> bool {
        self.row_heights.is_empty() && self.col_widths.is_empty()
    }

    fn into_size_facts(self) -> Result<(Vec<(u32, u32)>, Vec<(u32, u32)>), String> {
        let mut row_heights = Vec::with_capacity(self.row_heights.len());
        for row in self.row_heights {
            if row.height_px == 0 {
                return Err(format!("invalid row height at row {}", row.row_index));
            }
            if row.row_index < self.start_row || row.row_index > self.end_row {
                return Err(format!(
                    "row height outside snapshot range: {}",
                    row.row_index
                ));
            }
            row_heights.push((row.row_index, row.height_px));
        }

        let mut col_widths = Vec::with_capacity(self.col_widths.len());
        for col in self.col_widths {
            if col.width_px == 0 {
                return Err(format!("invalid column width at col {}", col.col_index));
            }
            if col.col_index < self.start_col || col.col_index > self.end_col {
                return Err(format!(
                    "column width outside snapshot range: {}",
                    col.col_index
                ));
            }
            col_widths.push((col.col_index, col.width_px));
        }

        Ok((row_heights, col_widths))
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
            "custom" => self
                .pattern
                .map(NumberFormat::Custom)
                .unwrap_or(NumberFormat::General),
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
            NumberFormat::Custom(p) => NumberFormatJSON {
                kind: "custom".into(),
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

// === STORAGE_PRIMARY Phase 6.2 wire (`bulk_install_workbook`) ===
//
// One entry per sheet; `primitives` / `formulas` are arrays of
// `[addr, value]` pairs that deserialize DIRECTLY into the
// `HashMap<CellAddress, _>` maps `Workbook::install_workbook_bulk`
// consumes — no intermediate `Vec<ImportCellWire>`, no per-cell engine
// calls. The addr string accepts two encodings:
//
//   - `"R:C"` — zero-based row/col pair (e.g. `"0:0"` = A1). Matches
//     the zero-based row/col fields of the legacy `bulk_import_cells`
//     wire, so the worker-side migration (Phase 6.3) is a
//     `` `${row}:${col}` `` template away.
//   - A1 form (e.g. `"B2"`) — convenience for hand-written payloads
//     and tests.
fn parse_wire_addr(s: &str) -> Option<CellAddress> {
    if let Some((row, col)) = s.split_once(':') {
        if let (Ok(row), Ok(col)) = (row.parse::<u32>(), col.parse::<u32>()) {
            return Some(CellAddress::new(row, col));
        }
    }
    CellAddress::parse(s)
}

/// Primitive value wire for the storage-primary install path. Same
/// JS-type-driven encoding as `BulkImportValueJSON` (number → Number,
/// string → Text, boolean → Boolean) minus the side-channel `kind`
/// string; error cells ride as `{ error: "#DIV/0!" }` objects since
/// there is no `kind: "error"` discriminator anymore.
#[derive(Clone, Debug)]
enum PrimitiveWireJSON {
    Number(f64),
    Boolean(bool),
    Text(String),
    Error(String),
    /// `null` / `undefined` — treated as "absent": skipped at install.
    Null,
}

impl PrimitiveWireJSON {
    /// Convert to an engine `Value`. `None` means "skip this entry":
    /// explicit nulls and non-finite numbers (NaN / ±Infinity cannot be
    /// represented as a cell number; the legacy wire rejected them too).
    fn into_value(self) -> Option<Value> {
        match self {
            PrimitiveWireJSON::Number(n) if n.is_finite() => Some(Value::Number(n)),
            PrimitiveWireJSON::Number(_) => None,
            PrimitiveWireJSON::Boolean(b) => Some(Value::Boolean(b)),
            PrimitiveWireJSON::Text(s) => Some(Value::Text(s)),
            PrimitiveWireJSON::Error(s) => Some(Value::Error(value_error_from_display(&s))),
            PrimitiveWireJSON::Null => None,
        }
    }
}

impl<'de> Deserialize<'de> for PrimitiveWireJSON {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = PrimitiveWireJSON;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a number, string, boolean, null, or { error } object")
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Number(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Number(v as f64))
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Number(v as f64))
            }

            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Boolean(v))
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Text(v.to_string()))
            }

            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Text(v))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Null)
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(PrimitiveWireJSON::Null)
            }

            fn visit_some<D2>(self, deserializer: D2) -> Result<Self::Value, D2::Error>
            where
                D2: de::Deserializer<'de>,
            {
                deserializer.deserialize_any(self)
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: de::MapAccess<'de>,
            {
                let mut error: Option<String> = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "error" {
                        error = Some(map.next_value::<String>()?);
                    } else {
                        let _ = map.next_value::<de::IgnoredAny>()?;
                    }
                }
                match error {
                    Some(e) => Ok(PrimitiveWireJSON::Error(e)),
                    None => Err(de::Error::custom(
                        "object primitive must carry an `error` key",
                    )),
                }
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

/// `Array<[addr, PrimitiveWire]>` → `HashMap<CellAddress, Value>` in one
/// deserialize pass. Skippable entries (null / non-finite numbers) are
/// dropped here; malformed addresses fail the whole call (the payload
/// is machine-built by the worker — fail fast beats silent data loss).
#[derive(Default)]
struct PrimitivePairsJSON(HashMap<CellAddress, Value>);

impl<'de> Deserialize<'de> for PrimitivePairsJSON {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = PrimitivePairsJSON;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an array of [addr, primitive] pairs")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                let mut map: HashMap<CellAddress, Value> =
                    HashMap::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some((addr, wire)) = seq.next_element::<(String, PrimitiveWireJSON)>()? {
                    let Some(addr) = parse_wire_addr(&addr) else {
                        return Err(de::Error::custom(format!("invalid cell address: {addr}")));
                    };
                    if let Some(value) = wire.into_value() {
                        map.insert(addr, value);
                    }
                }
                Ok(PrimitivePairsJSON(map))
            }
        }

        deserializer.deserialize_seq(Visitor)
    }
}

/// `Array<[addr, source]>` → `HashMap<CellAddress, String>`. Source text
/// is NOT parse-validated here — that's the storage-primary contract;
/// unparseable text surfaces `#VALUE!` at first read via the hydrator.
#[derive(Default)]
struct FormulaPairsJSON(HashMap<CellAddress, String>);

impl<'de> Deserialize<'de> for FormulaPairsJSON {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = FormulaPairsJSON;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an array of [addr, formula-source] pairs")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                let mut map: HashMap<CellAddress, String> =
                    HashMap::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some((addr, source)) = seq.next_element::<(String, String)>()? {
                    let Some(addr) = parse_wire_addr(&addr) else {
                        return Err(de::Error::custom(format!("invalid cell address: {addr}")));
                    };
                    map.insert(addr, source);
                }
                Ok(FormulaPairsJSON(map))
            }
        }

        deserializer.deserialize_seq(Visitor)
    }
}

/// One sheet's storage-primary payload.
#[derive(Deserialize)]
struct SheetBulkInstallJSON {
    sheet: usize,
    #[serde(default)]
    primitives: PrimitivePairsJSON,
    #[serde(default)]
    formulas: FormulaPairsJSON,
}

/// Per-sheet stats returned by `bulk_install_workbook`.
#[derive(Clone, Copy, Debug, Serialize)]
struct BulkInstallStatsJSON {
    sheet: usize,
    #[serde(rename = "primitivesInstalled")]
    primitives_installed: u32,
    #[serde(rename = "formulasInstalled")]
    formulas_installed: u32,
    #[serde(rename = "crossSheetParsed")]
    cross_sheet_parsed: u32,
}

#[derive(Clone, Debug, Serialize)]
struct CellRefJSON {
    sheet: usize,
    addr: String,
}

/// Phase 1 dep-graph statistics wire shape. Mirrors
/// `einfach_excel_core::DepGraphStats` summed across all sheets plus
/// the derived `avg_fanout` computed here so the JS bench doesn't have
/// to divide on its side.
#[derive(Clone, Debug, Default, Serialize)]
struct DepGraphStatsJSON {
    #[serde(rename = "totalFormulaCount")]
    total_formula_count: u64,
    #[serde(rename = "totalPointDepEdges")]
    total_point_dep_edges: u64,
    #[serde(rename = "totalRangeDepEntries")]
    total_range_dep_entries: u64,
    #[serde(rename = "maxFanout")]
    max_fanout: u32,
    #[serde(rename = "avgFanout")]
    avg_fanout: f64,
    #[serde(rename = "rangeFormulaCount")]
    range_formula_count: u64,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sizes: Vec<ViewportSizeSnapshotJSON>,
    /// Excel Table registry (#32). `default` + `skip_serializing_if` keeps
    /// the wire backward-compatible in BOTH directions: payloads written
    /// before this field existed restore as "no Tables" (exactly today's
    /// behaviour), and a table-less workbook still serializes byte-identical
    /// to before. Included because `restore_persistence_v1` builds a FRESH
    /// `Workbook` — without the registry travelling with the payload, every
    /// restored workbook came back with its Tables silently gone and its
    /// structured references reading `#NAME?`, i.e. a lossy restore.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tables: Vec<TableJSON>,
    /// Manually hidden rows, per sheet (E2 of `design-engine-hidden-rows.md`).
    /// Same `default` + `skip_serializing_if` backward-compatibility argument
    /// as `tables` above: payloads written before this field existed restore
    /// as "nothing hidden", and a workbook with nothing hidden still
    /// serializes byte-identical to before.
    ///
    /// Included because `restore_persistence_v1` builds a FRESH `Workbook`.
    /// Before the engine owned the set there was nothing on this side to
    /// serialize — the host's hidden state never reached the engine's
    /// snapshot at all — so every save/load round trip silently un-hid every
    /// row and changed every `SUBTOTAL(101-111)` that depended on one. That
    /// also closes an xlsx-parity gap: real workbooks persist hidden rows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hidden: Vec<SheetHiddenRowsJSON>,
    /// Per-sheet AutoFilter state — rules AND the rows they hid (E3 of
    /// `design-engine-hidden-rows.md`). Same `default` +
    /// `skip_serializing_if` backward-compatibility argument as `hidden`
    /// and `tables` above.
    ///
    /// Both halves are persisted for the same reason the undo snapshot
    /// carries both: restoring rules alone would force a re-derivation
    /// against whatever the restored cells say, which is exactly the
    /// liveness #27's snapshot semantics removed. Closes the other half of
    /// the xlsx-parity gap `hidden` opened — real workbooks persist their
    /// autoFilter state.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    filters: Vec<SheetFilterStateJSON>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WorkbookPersistenceRestoreStatsJSON {
    restored_cells: u32,
    restored_formats: u32,
    sheets: u32,
    /// Excel Tables re-registered (#32). Additive output key — hosts that
    /// predate it simply ignore it.
    restored_tables: u32,
    /// Sheets that came back with at least one manually hidden row (E2).
    /// Additive output key, same as `restored_tables`.
    restored_hidden_sheets: u32,
    /// Sheets that came back with an AutoFilter (E3). Additive output key.
    restored_filter_sheets: u32,
}

// === Engine physical sort (`sortRange`) wire — S2 of
// `solid/excel/docs/online-excel-parity/design-engine-sort.md` ===
//
// Payload `{ range, keys: [{ col, direction, caseSensitive }], excludedRows }`.
// `range` is either an A1 string (`"A1:B3"`, or `"A1"` for a single cell) or a
// zero-based `{ startRow, startCol, endRow, endCol }` bounds object. Success
// serializes `SortRangeReportJSON` (`{ ok: true, movedRows, movedCells,
// rowPermutation }`); every rejection (engine gate OR payload parse) returns a
// structured `{ ok: false, code, anchor?, message? }` object in the Ok arm,
// matching the `trySetCell*` convention (`sheet_error_to_js`).

/// Range wire: an A1 string or a zero-based bounds object.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum SortRangeWireJSON {
    A1(String),
    Bounds {
        #[serde(rename = "startRow")]
        start_row: u32,
        #[serde(rename = "startCol")]
        start_col: u32,
        #[serde(rename = "endRow")]
        end_row: u32,
        #[serde(rename = "endCol")]
        end_col: u32,
    },
}

impl SortRangeWireJSON {
    fn into_range(self) -> Result<CellRange, String> {
        match self {
            SortRangeWireJSON::A1(s) => {
                let (a, b) = s.split_once(':').unwrap_or((s.as_str(), s.as_str()));
                let start = CellAddress::parse(a.trim())
                    .ok_or_else(|| format!("invalid range cell: {a}"))?;
                let end = CellAddress::parse(b.trim())
                    .ok_or_else(|| format!("invalid range cell: {b}"))?;
                Ok(CellRange::new(start, end))
            }
            SortRangeWireJSON::Bounds {
                start_row,
                start_col,
                end_row,
                end_col,
            } => Ok(CellRange::new(
                CellAddress::new(start_row, start_col),
                CellAddress::new(end_row, end_col),
            )),
        }
    }
}

/// One sort key. `direction` accepts `"asc"`/`"desc"` (the UI-core
/// `SortDirection` vocabulary) plus the long `"ascending"`/`"descending"`
/// spellings; anything else — including a missing field — defaults to
/// ascending. `caseSensitive` defaults to `false` (Excel default).
#[derive(Clone, Debug, Deserialize)]
struct SortKeyWireJSON {
    col: u32,
    #[serde(default)]
    direction: Option<String>,
    #[serde(rename = "caseSensitive", default)]
    case_sensitive: bool,
}

impl SortKeyWireJSON {
    fn into_key(self) -> SortKey {
        let direction = match self.direction.as_deref() {
            Some("desc") | Some("descending") => SortDirection::Descending,
            _ => SortDirection::Ascending,
        };
        SortKey {
            col: self.col,
            direction,
            case_sensitive: self.case_sensitive,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct SortRangePayloadJSON {
    range: SortRangeWireJSON,
    #[serde(default)]
    keys: Vec<SortKeyWireJSON>,
    #[serde(rename = "excludedRows", default)]
    excluded_rows: Vec<u32>,
}

/// Success witness. `rowPermutation` is the changed-slot permutation as
/// `[[slotRow, sourceRow], …]` pairs (compact for the up-to-50k moved-row
/// witness; reserved for overlay remap / parity, v1 consumers may ignore).
#[derive(Clone, Debug, Serialize)]
struct SortRangeReportJSON {
    ok: bool,
    #[serde(rename = "movedRows")]
    moved_rows: u32,
    #[serde(rename = "movedCells")]
    moved_cells: u32,
    #[serde(rename = "rowPermutation")]
    row_permutation: Vec<[u32; 2]>,
}

impl SortRangeReportJSON {
    fn from_report(report: &SortRangeReport) -> Self {
        SortRangeReportJSON {
            ok: true,
            moved_rows: report.moved_rows,
            moved_cells: report.moved_cells,
            row_permutation: report
                .row_permutation
                .iter()
                .map(|&(slot, source)| [slot, source])
                .collect(),
        }
    }
}

// === Excel Table registry wire (#32) — CRUD DTO for `listTables` /
// `getTable`. Mirrors `TableEntry`'s public accessors; the range is emitted
// as an A1 string (`"A1:C10"`) to match how ranges read elsewhere on the JS
// side, plus the resolved 0-based `sheetIndex` for adapter convenience.
//
// Also the wire element of the `snapshotTables` / `restoreTables` undo
// primitive, hence `Deserialize`: a host round-trips exactly what
// `listTables` hands it. On the way back IN, `sheetIndex` is ignored — the
// engine anchors Tables by sheet NAME (so the snapshot survives `moveSheet`
// and index churn between capture and restore), which is why the field
// carries a `default` and the restore path reads `sheet` only.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct TableJSON {
    name: String,
    sheet: String,
    #[serde(rename = "sheetIndex", default)]
    sheet_index: u32,
    range: String,
    #[serde(rename = "hasHeaders", default)]
    has_headers: bool,
    #[serde(rename = "hasTotals", default)]
    has_totals: bool,
    #[serde(default)]
    columns: Vec<String>,
}

impl TableJSON {
    fn from_entry(entry: &TableEntry, sheet_index: u32) -> Self {
        let range = entry.range();
        TableJSON {
            name: entry.name().to_string(),
            sheet: entry.sheet_name().to_string(),
            sheet_index,
            range: format!(
                "{}:{}",
                range.start.to_string_repr(),
                range.end.to_string_repr()
            ),
            has_headers: entry.has_headers(),
            has_totals: entry.has_totals(),
            columns: entry.columns().to_vec(),
        }
    }

    /// Rehydrate a snapshot entry. The `range` is the same `"A1:C10"` form
    /// `from_entry` emits; a bare `"A1"` degenerates to a 1x1 range, matching
    /// `SortRangeWireJSON`. Shape checks beyond parsing (column count vs
    /// range width, name mutex, cap) belong to `Workbook::restore_tables`,
    /// which validates the batch atomically.
    fn into_entry(self) -> Result<TableEntry, String> {
        let (a, b) = self
            .range
            .split_once(':')
            .unwrap_or((self.range.as_str(), self.range.as_str()));
        let start = CellAddress::parse(a.trim())
            .ok_or_else(|| format!("invalid table range cell: {a}"))?;
        let end = CellAddress::parse(b.trim())
            .ok_or_else(|| format!("invalid table range cell: {b}"))?;
        Ok(TableEntry::from_parts(
            self.name,
            self.sheet,
            CellRange::new(start, end),
            self.has_headers,
            self.has_totals,
            self.columns,
        ))
    }
}

/// Envelope for `snapshotTables` / `restoreTables`. Versioned like the
/// persistence-v1 payload so a stored undo record can be rejected loudly
/// rather than silently half-applied, and so the shape stays distinguishable
/// from the bare `TableJSON[]` that `listTables` returns.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct TableRegistrySnapshotJSON {
    version: u32,
    tables: Vec<TableJSON>,
}

// === Engine-owned MANUAL hidden rows wire (E2 of
// `design-engine-hidden-rows.md`) ===

/// One sheet's manually hidden rows. Element of both the
/// `snapshotHidden` / `restoreHidden` undo envelope and the persistence-v1
/// `hidden` field, so the two agree by construction.
///
/// Keyed by sheet INDEX, unlike `TableJSON`'s sheet NAME: hidden rows are
/// per-`Sheet` dimension metadata that rides `moveSheet` automatically, and
/// every other per-sheet persistence payload here (`FormatRangeSnapshotJSON`,
/// `ViewportSizeSnapshotJSON`) is already index-keyed.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SheetHiddenRowsJSON {
    sheet: u32,
    rows: Vec<u32>,
}

impl SheetHiddenRowsJSON {
    fn from_entry(entry: &SheetHiddenRows) -> Self {
        SheetHiddenRowsJSON {
            sheet: entry.sheet_index as u32,
            rows: entry.rows.clone(),
        }
    }

    fn into_entry(self) -> SheetHiddenRows {
        SheetHiddenRows {
            sheet_index: self.sheet as usize,
            rows: self.rows,
        }
    }
}

/// Envelope for `snapshotHidden` / `restoreHidden`. Versioned exactly like
/// `TableRegistrySnapshotJSON`, so a stored undo record from a future shape
/// is rejected loudly rather than half-applied.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct HiddenRowsSnapshotJSON {
    version: u32,
    hidden: Vec<SheetHiddenRowsJSON>,
}

// === Engine-owned FILTER wire (E3 of `design-engine-hidden-rows.md`) ===
//
// `ColumnFilterRuleJSON` is the Rust twin of the TypeScript wire union
// `ColumnFilterRule` (`spreadsheet-ui-core/src/filter-sort/types.ts:12-16`),
// which is the ONE piece of predicate knowledge UI-core keeps after E4. The
// shape is copied field for field so a host can pass its existing rule
// objects straight through with no adapter mapping:
//
//   { kind: 'equals'   | 'contains', colIndex, value, caseSensitive? }
//   { kind: 'range',    colIndex, min?, max? }
//   { kind: 'list',     colIndex, values }
//
// `caseSensitive` is optional on the wire and absent means `false`, which is
// what the TypeScript predicate does (`caseSensitive ? value : lower(value)`).

/// One column filter rule, internally tagged by `kind` exactly like the
/// TypeScript union.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ColumnFilterRuleJSON {
    Equals {
        #[serde(rename = "colIndex")]
        col_index: u32,
        value: String,
        #[serde(rename = "caseSensitive", default, skip_serializing_if = "is_false")]
        case_sensitive: bool,
    },
    Contains {
        #[serde(rename = "colIndex")]
        col_index: u32,
        value: String,
        #[serde(rename = "caseSensitive", default, skip_serializing_if = "is_false")]
        case_sensitive: bool,
    },
    Range {
        #[serde(rename = "colIndex")]
        col_index: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    List {
        #[serde(rename = "colIndex")]
        col_index: u32,
        values: Vec<String>,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ColumnFilterRuleJSON {
    fn from_rule(rule: &ColumnFilterRule) -> Self {
        match rule {
            ColumnFilterRule::Equals {
                col_index,
                value,
                case_sensitive,
            } => ColumnFilterRuleJSON::Equals {
                col_index: *col_index,
                value: value.clone(),
                case_sensitive: *case_sensitive,
            },
            ColumnFilterRule::Contains {
                col_index,
                value,
                case_sensitive,
            } => ColumnFilterRuleJSON::Contains {
                col_index: *col_index,
                value: value.clone(),
                case_sensitive: *case_sensitive,
            },
            ColumnFilterRule::Range {
                col_index,
                min,
                max,
            } => ColumnFilterRuleJSON::Range {
                col_index: *col_index,
                min: *min,
                max: *max,
            },
            ColumnFilterRule::List { col_index, values } => ColumnFilterRuleJSON::List {
                col_index: *col_index,
                values: values.clone(),
            },
        }
    }

    fn into_rule(self) -> ColumnFilterRule {
        match self {
            ColumnFilterRuleJSON::Equals {
                col_index,
                value,
                case_sensitive,
            } => ColumnFilterRule::Equals {
                col_index,
                value,
                case_sensitive,
            },
            ColumnFilterRuleJSON::Contains {
                col_index,
                value,
                case_sensitive,
            } => ColumnFilterRule::Contains {
                col_index,
                value,
                case_sensitive,
            },
            ColumnFilterRuleJSON::Range {
                col_index,
                min,
                max,
            } => ColumnFilterRule::Range {
                col_index,
                min,
                max,
            },
            ColumnFilterRuleJSON::List { col_index, values } => {
                ColumnFilterRule::List { col_index, values }
            }
        }
    }
}

/// `applyFilter` / `reapplyFilter` payload.
#[derive(Clone, Debug, Default, Deserialize)]
struct ApplyFilterPayloadJSON {
    #[serde(default)]
    rules: Vec<ColumnFilterRuleJSON>,
}

/// Success shape of the three filter commands, mirroring
/// `SortRangeReportJSON`'s `{ ok: true, … }` convention so a host can
/// discriminate on `ok` alone.
#[derive(Clone, Debug, Serialize)]
struct FilterApplyReportJSON {
    ok: bool,
    /// 0-based SOURCE rows the applied rules hid, for the WHOLE scanned
    /// extent — never a window-bounded subset. This is what the host stores
    /// verbatim as the answer to "is this row painted?".
    #[serde(rename = "hiddenRows")]
    hidden_rows: Vec<u32>,
    #[serde(rename = "scannedRows")]
    scanned_rows: u32,
    #[serde(rename = "predicateCells")]
    predicate_cells: u32,
}

/// One sheet's filter state. Element of both the `snapshotFilters` /
/// `restoreFilters` undo envelope and the persistence-v1 `filters` field,
/// so the two agree by construction. Sheet-INDEX keyed for the same reason
/// `SheetHiddenRowsJSON` is.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SheetFilterStateJSON {
    sheet: u32,
    rules: Vec<ColumnFilterRuleJSON>,
    /// The rows those rules hid. Carried alongside the rules, not re-derived
    /// on restore: re-deriving would evaluate against whatever the cells say
    /// at restore time, which is live evaluation wearing an undo costume.
    #[serde(rename = "hiddenRows")]
    hidden_rows: Vec<u32>,
}

impl SheetFilterStateJSON {
    fn from_entry(entry: &SheetFilterState) -> Self {
        SheetFilterStateJSON {
            sheet: entry.sheet_index as u32,
            rules: entry.rules.iter().map(ColumnFilterRuleJSON::from_rule).collect(),
            hidden_rows: entry.hidden_rows.clone(),
        }
    }

    fn into_entry(self) -> SheetFilterState {
        SheetFilterState {
            sheet_index: self.sheet as usize,
            rules: self
                .rules
                .into_iter()
                .map(ColumnFilterRuleJSON::into_rule)
                .collect(),
            hidden_rows: self.hidden_rows,
        }
    }
}

/// Envelope for `snapshotFilters` / `restoreFilters`, versioned exactly
/// like `HiddenRowsSnapshotJSON`.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct FilterSnapshotJSON {
    version: u32,
    filters: Vec<SheetFilterStateJSON>,
}

/// Map a [`FilterError`] to the structured `{ ok: false, code, message }`
/// rejection object the `sortRange` wire established. Codes are kebab-case,
/// matching the `sheet_error_to_js` family; `source-too-large` is the sunk
/// twin of the adapter's `FILTER_SORT_SOURCE_TOO_LARGE`.
fn filter_error_to_js(err: FilterError) -> JsValue {
    match err {
        FilterError::InvalidSheet => sort_error_to_js("invalid-sheet", None, None),
        FilterError::MutationDuringCustomCall => {
            sort_error_to_js("mutation-during-custom-call", None, None)
        }
        FilterError::SourceTooLarge {
            rows,
            columns,
            predicate_cells,
        } => sort_error_to_js(
            "source-too-large",
            None,
            Some(&format!(
                "filter predicate scan needs {predicate_cells} cells ({rows} rows x {columns} \
                 columns) but the engine cap is {MAX_FILTER_PREDICATE_CELLS}; the filter was \
                 not applied"
            )),
        ),
    }
}

/// Map a `TableError` to a stable JS error string (mirrors
/// `workbook_error_to_js`). Not part of the frozen export surface — no
/// snapshot regeneration is triggered by adding a variant here.
fn table_error_to_js(err: TableError) -> JsValue {
    JsValue::from_str(table_error_id(err))
}

/// The stable string id behind `table_error_to_js`, split out so the
/// natively-testable helpers (`restore_tables_json`) can surface the same
/// vocabulary without constructing a `JsValue`.
fn table_error_id(err: TableError) -> &'static str {
    match err {
        TableError::TooManyTables => "too-many-tables",
        TableError::InvalidName => "invalid-name",
        TableError::ReservedName => "reserved-name",
        TableError::NameLikeCellRef => "name-like-cell-ref",
        TableError::NameConflict => "name-conflict",
        TableError::RangeOverlap => "range-overlap",
        TableError::SheetNotFound => "sheet-not-found",
        TableError::NotFound => "not-found",
        TableError::ColumnNotFound => "column-not-found",
        TableError::DuplicateColumn => "duplicate-column",
        TableError::InvalidColumnName => "invalid-column-name",
        TableError::TotalsRowBlocked => "totals-row-blocked",
        TableError::NoTotalsRow => "no-totals-row",
        TableError::MutationDuringCustomCall => "mutation-during-custom-call",
        TableError::MalformedSnapshot => "malformed-snapshot",
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
        let err = error_token_to_value_error(value).unwrap_or(ValueError::InvalidValue);
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
        // Collapse a spill anchor's Array to its top-left element first,
        // so a spilled numeric anchor returns the [0][0] number instead
        // of NaN (the JS boundary contract).
        match collapse_array_for_js(&self.sheet.get_cell(addr)).into_owned() {
            Value::Number(n) => n,
            _ => f64::NAN,
        }
    }

    /// Get the type of a cell's value: "number", "text", "boolean", "null", "error"
    pub fn get_type(&mut self, addr: &str) -> String {
        // Funnel through `value_to_cell_type` so spill anchors collapse
        // to their top-left element's type instead of leaking an Array
        // string the JS layer wouldn't know how to handle.
        value_to_cell_type(&self.sheet.get_cell(addr))
    }

    /// Check if a cell contains an error.
    pub fn is_error(&mut self, addr: &str) -> bool {
        self.sheet.get_cell(addr).is_error()
    }

    /// If `addr` is a dynamic-array spill *anchor*, return the spill
    /// shape as a `[rows, cols]` `Uint32Array`. Returns `undefined` /
    /// `null` (`JsValue::null`) for plain cells, spilled-into cells,
    /// and `#SPILL!` anchors. The JS UI uses this to render the spill
    /// border around the anchor's bounding rectangle.
    #[wasm_bindgen(js_name = "spillInfo")]
    pub fn spill_info(&self, addr: &str) -> JsValue {
        let Some(parsed) = CellAddress::parse(addr) else {
            return JsValue::null();
        };
        match self.sheet.spill_info(parsed) {
            Some((rows, cols)) => {
                let arr = js_sys::Uint32Array::new_with_length(2);
                arr.copy_from(&[rows, cols]);
                arr.into()
            }
            None => JsValue::null(),
        }
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

    /// Number of materialized Store geometry roots used by large range
    /// formulas. Small ranges depend on member facades and contribute zero.
    pub fn debug_range_dep_count(&self) -> u32 {
        self.sheet.debug_range_dep_count() as u32
    }
}

/// Per-cell subscription bookkeeping for `WasmWorkbook`. The sheet index is
/// retained so topology operations can remap or remove the token. The stable
/// facade subscription itself owns callback delivery and is handed back to
/// `Sheet::unsubscribe_cell` on teardown.
struct WorkbookCellSubscription {
    sheet_idx: usize,
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

// === Wave 8 custom-formula registry ===
//
// `CustomFormulaRegistry` holds a map of upper-cased name → `js_sys::Function`
// (the JS callback the host registered via `registerCustomFormula`). When
// the formula engine encounters an unknown function name and falls through
// to `EvalProvider::call_custom`, the WorkbookEvalProvider impl delegates
// to the registry's `lookup`, which marshals args from `Value` to `JsValue`,
// invokes the callback, and marshals the return back.
//
// Thread safety: `js_sys::Function` is `!Send + !Sync` (it holds a JS-side
// reference). wasm32-unknown-unknown is single-threaded by default, so we
// wrap the inner state in `Mutex` (purely to satisfy the `CustomFunctionRegistry`
// trait's `Sync` bound — the Mutex is never contended in practice) and the
// outer struct is `Send + Sync` by virtue of the Mutex. The native-only
// `cargo check --target host` path also compiles because js-sys ships
// stubs for non-wasm targets.

/// Concrete `CustomFunctionRegistry` impl backed by a `HashMap` of
/// `js_sys::Function`s. Exposed via `WasmWorkbook::register_custom_formula`
/// / `unregister_custom_formula`.
///
/// All lookups upper-case `name` so JS-side registration is case-
/// insensitive: `wb.registerCustomFormula("myfunc", fn)` and `=MYFUNC()`
/// resolve to the same entry. Matches Excel + the defined-name registry.
struct WasmCustomFormulaRegistry {
    inner: Mutex<HashMap<String, CustomEntry>>,
}

/// One registry slot. Sync entries hold the JS callback and dispatch
/// through `lookup` during evaluation. Async entries are a name-only
/// marker: the engine memoizes the call and enqueues a pending request,
/// and the WORKER invokes the JS callback from its own local map on its
/// own event loop — the callback never crosses into wasm, so evaluation
/// stays synchronous.
enum CustomEntry {
    Sync(js_sys::Function),
    Async,
}

impl std::fmt::Debug for WasmCustomFormulaRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.inner.lock().map(|map| map.len()).unwrap_or(0);
        write!(f, "WasmCustomFormulaRegistry({count} fns)")
    }
}

// SAFETY: js_sys::Function is not Send/Sync in general, but on wasm32 the
// runtime is single-threaded and we never hand the Mutex out across
// threads — the workbook is owned by a single Worker. The unsafe impls
// satisfy the CustomFunctionRegistry bound without a third-party
// `SendWrapper` dep.
//
// The `cfg(not(target_feature = "atomics"))` guard is a compile-time
// fuse: if a future build flips on wasm-bindgen-rayon / shared-memory
// threads (which set the `atomics` target feature), the `Send`/`Sync`
// impls disappear and `WasmCustomFormulaRegistry` will fail to satisfy
// the `CustomFunctionRegistry: Send + Sync` bound. That surfaces the
// unsoundness as a compile error at the boundary rather than silently
// allowing UB at runtime. Re-enabling threads requires re-architecting
// the registry around `SendWrapper` / a worker-bound channel.
#[cfg(not(target_feature = "atomics"))]
unsafe impl Send for WasmCustomFormulaRegistry {}
#[cfg(not(target_feature = "atomics"))]
unsafe impl Sync for WasmCustomFormulaRegistry {}

impl WasmCustomFormulaRegistry {
    fn new() -> Self {
        WasmCustomFormulaRegistry {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, name: &str, callback: js_sys::Function) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(name.to_ascii_uppercase(), CustomEntry::Sync(callback));
        }
    }

    fn register_async(&self, name: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(name.to_ascii_uppercase(), CustomEntry::Async);
        }
    }

    fn unregister(&self, name: &str) -> bool {
        self.inner
            .lock()
            .map(|mut map| map.remove(&name.to_ascii_uppercase()).is_some())
            .unwrap_or(false)
    }

    fn registered_names(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn count(&self) -> usize {
        self.inner.lock().map(|map| map.len()).unwrap_or(0)
    }
}

impl CustomFunctionRegistry for WasmCustomFormulaRegistry {
    fn lookup(&self, name: &str, args: &[Value]) -> Option<Value> {
        let key = name.to_ascii_uppercase();
        let callback = {
            let map = self.inner.lock().ok()?;
            match map.get(&key)? {
                CustomEntry::Sync(callback) => callback.clone(),
                // Async names never dispatch through lookup — the engine
                // routes them to the memoized pending path before this
                // point. Reaching here means the engine-side is_async
                // gate was bypassed; fail loudly as #NAME? rather than
                // invoking nothing.
                CustomEntry::Async => return Some(Value::Error(ValueError::InvalidName)),
            }
        };
        Some(invoke_js_custom_formula(&callback, args))
    }

    fn is_async(&self, name: &str) -> bool {
        self.inner
            .lock()
            .map(|map| {
                matches!(
                    map.get(&name.to_ascii_uppercase()),
                    Some(CustomEntry::Async)
                )
            })
            .unwrap_or(false)
    }
}

/// Marshal `args` to a JS Array and invoke `callback`, then marshal the
/// return value back to a `Value`. Centralized so the conversion rules
/// stay in one place — see CUSTOM_FORMULAS.md for the wire format.
fn invoke_js_custom_formula(callback: &js_sys::Function, args: &[Value]) -> Value {
    let js_args = js_sys::Array::new();
    for v in args {
        js_args.push(&value_to_js(v));
    }
    match callback.call1(&JsValue::undefined(), &js_args) {
        Ok(ret) => js_to_value(&ret),
        Err(err) => {
            // The JS callback threw. `ValueError` is a flat enum with no
            // string payload, so we can't carry the message into the
            // cell value — but we can surface it via `console.warn` so a
            // host devtools inspection shows the actual JS message
            // alongside the `#VALUE!` cell. The browser's default error
            // logging swallows thrown exceptions caught here, so without
            // this `warn_1` the user sees `#VALUE!` with zero context.
            let message = extract_js_error_message(&err);
            #[cfg(target_arch = "wasm32")]
            {
                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "[einfach custom formula] callback threw: {message}"
                )));
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                let _ = message; // native build: no console, drop the string
            }
            Value::Error(ValueError::InvalidValue)
        }
    }
}

/// Best-effort string extraction from a thrown JS value. JS code can
/// `throw` any value — an Error, a string, a number, an object — so we
/// try a few shapes in priority order:
///
/// 1. `js_sys::Error::message()` for proper Error instances (the common
///    case: `throw new Error("oops")`).
/// 2. `JsValue::as_string()` for plain string throws (`throw "oops"`).
/// 3. The `Debug` format for everything else.
///
/// Returned as an owned `String` so the caller can include it in a log
/// line without juggling lifetimes.
fn extract_js_error_message(err: &JsValue) -> String {
    if let Some(error) = err.dyn_ref::<js_sys::Error>() {
        if let Some(msg) = error.message().as_string() {
            return msg;
        }
    }
    if let Some(s) = err.as_string() {
        return s;
    }
    format!("{:?}", err)
}

/// Marshal `Value` → `JsValue`. Scalars round-trip via their natural JS
/// types; `Value::Array` becomes a 2-D `Array<Array<...>>`; `Value::Error`
/// becomes a plain string like `"#DIV/0!"` so the JS side has at least
/// some signal. `Value::Lambda` (which can't reach here in practice — the
/// engine never passes a Lambda into a custom call) maps to `null`.
fn value_to_js(value: &Value) -> JsValue {
    match value {
        Value::Number(n) => JsValue::from_f64(*n),
        Value::Text(s) => JsValue::from_str(s),
        Value::Boolean(b) => JsValue::from_bool(*b),
        Value::Null => JsValue::null(),
        Value::Error(e) => JsValue::from_str(&format!("{e}")),
        Value::Array(arr) => {
            let outer = js_sys::Array::new();
            for r in 0..arr.rows {
                let row = js_sys::Array::new();
                for c in 0..arr.cols {
                    let v = arr.get(r, c).cloned().unwrap_or(Value::Null);
                    row.push(&value_to_js(&v));
                }
                outer.push(&row);
            }
            outer.into()
        }
        Value::Lambda(_) => JsValue::null(),
    }
}

/// Marshal `JsValue` → `Value`. The JS callback may return any of:
///   - `number` → `Value::Number` (NaN / Infinity become `#NUM!`).
///   - `string` → `Value::Text`. The special tokens `"#NULL!"`,
///     `"#DIV/0!"`, `"#N/A"`, `"#REF!"`, `"#VALUE!"`, `"#NAME?"`,
///     `"#NUM!"`, `"#CYCLE!"`, `"#TYPE!"`, `"#ARGS!"`, `"#SPILL!"`,
///     `"#CALC!"` round-trip as the matching `ValueError` so a JS-side
///     custom function can deliberately propagate an Excel-style error.
///     `"#BUSY!"` is reserved for the async pending state and demotes to
///     `#VALUE!` (see `demote_busy_for_custom_return`).
///   - `boolean` → `Value::Boolean`.
///   - `null` / `undefined` → `Value::Null`.
///   - `{ error: string }` → `Value::Error(_)` parsed from the string
///     (same token map as above; unknown strings → `#VALUE!`).
///   - Anything else (Date, function, opaque object) → `#TYPE!`.
fn js_to_value(js: &JsValue) -> Value {
    if js.is_null() || js.is_undefined() {
        return Value::Null;
    }
    if let Some(n) = js.as_f64() {
        if n.is_nan() || n.is_infinite() {
            return Value::Error(ValueError::Overflow);
        }
        return Value::Number(n);
    }
    if let Some(b) = js.as_bool() {
        return Value::Boolean(b);
    }
    if let Some(s) = js.as_string() {
        if let Some(err) = error_token_to_value_error(&s) {
            return Value::Error(demote_busy_for_custom_return(err));
        }
        // Hard cap on string size returned from a custom-formula
        // callback. A 1 GB string would be silently stored in the
        // formula cache and balloon worker memory before any user-
        // visible signal. 1 MB is generous for any legitimate Excel-
        // style text output (the longest sensible cell text is a few
        // KB); strings beyond this are almost certainly a misuse (e.g.
        // returning a serialized JSON blob into a cell). Surface
        // `#VALUE!` with a console warning so the host can debug.
        const MAX_CUSTOM_STRING_BYTES: usize = 1_048_576;
        if s.len() > MAX_CUSTOM_STRING_BYTES {
            #[cfg(target_arch = "wasm32")]
            {
                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "[einfach custom formula] return string of {} bytes exceeds {} byte cap; surfacing #VALUE!",
                    s.len(),
                    MAX_CUSTOM_STRING_BYTES
                )));
            }
            return Value::Error(ValueError::InvalidValue);
        }
        return Value::Text(s);
    }
    // Tagged-error escape hatch: `{ error: "..." }`. Used so JS code can
    // return a structured value-or-error without picking between
    // overloading `return "#VALUE!"` (ambiguous if a user actually wants
    // the literal text `"#VALUE!"`) and throwing (which clears the
    // cell's eval frame).
    #[cfg(target_arch = "wasm32")]
    if js.is_object() {
        if let Ok(error_val) = js_sys::Reflect::get(js, &JsValue::from_str("error")) {
            if let Some(s) = error_val.as_string() {
                return Value::Error(demote_busy_for_custom_return(
                    error_token_to_value_error(&s).unwrap_or(ValueError::InvalidValue),
                ));
            }
        }
        // Plain object with no `error` key, or any other non-scalar JS
        // shape (Date, function, Promise) — surface `#TYPE!`. Custom
        // formulas are scalar-in / scalar-out in this initial cut.
        return Value::Error(ValueError::WrongType);
    }
    Value::Error(ValueError::WrongType)
}

/// Translate Excel-style error tokens back to `ValueError`. Used by both
/// the string return path (`return "#DIV/0!"`) and the tagged-object path
/// (`return { error: "#DIV/0!" }`). Unknown tokens return `None` so the
/// caller can decide whether to treat the string as text or `#VALUE!`.
fn error_token_to_value_error(s: &str) -> Option<ValueError> {
    match s {
        "#NULL!" => Some(ValueError::Null),
        "#DIV/0!" => Some(ValueError::DivisionByZero),
        "#N/A" => Some(ValueError::NotAvailable),
        "#REF!" => Some(ValueError::InvalidRef),
        "#VALUE!" => Some(ValueError::InvalidValue),
        "#NAME?" => Some(ValueError::InvalidName),
        "#NUM!" => Some(ValueError::Overflow),
        "#CYCLE!" => Some(ValueError::CyclicRef),
        "#TYPE!" => Some(ValueError::WrongType),
        "#ARGS!" => Some(ValueError::WrongArgCount),
        "#SPILL!" => Some(ValueError::Spill),
        "#CALC!" => Some(ValueError::Calc),
        "#BUSY!" => Some(ValueError::Busy),
        _ => None,
    }
}

/// `#BUSY!` is reserved for the engine's async-custom-formula pending state.
/// A callback that returns it (as `"#BUSY!"` or `{ error: "#BUSY!" }`) would
/// leave the cell permanently pending — the host would wait for a settle that
/// never comes — so the custom-return path demotes it to `#VALUE!` with a
/// console warning. Import / set_error paths keep accepting the token so
/// exported workbooks containing pending cells round-trip.
fn demote_busy_for_custom_return(err: ValueError) -> ValueError {
    if err == ValueError::Busy {
        #[cfg(target_arch = "wasm32")]
        {
            web_sys::console::warn_1(&JsValue::from_str(
                "[einfach custom formula] callbacks must not return #BUSY! (reserved for the async pending state); surfacing #VALUE!",
            ));
        }
        return ValueError::InvalidValue;
    }
    err
}

// Historical note: there used to be a `MAX_BULK_IMPORT_CELLS_PER_CALL`
// constant (750_000) and a matching `check_bulk_import_payload_size`
// pre-flight guard at the four bulk-import entry points. Both were
// installed because the pre-Phase-2 eager `Workbook::bulk_load` path
// allocated per-formula `FormulaRecord` + `cell_dependents` +
// `range_dependents` entries during import, which panicked the WASM
// linear-memory allocator at ~1M formula records. The Phase 2/3
// lazy-formula-indexing refactor (commits 40bc473 + 7d0e380) moved all
// of that work to first-read, so `bulk_load` now allocates only the
// formula source `Rc<str>` plus a `HashSet<CellAddress>` membership in
// `needs_parse`. Single-call payloads of 5M cells now complete cleanly
// at ~2.9 GB peak RSS. See `rust/excel-core/docs/CAP_REMOVAL_2026-06-11.md`
// for the bench numbers and `rust/excel-core/docs/LAZY_FORMULA_INDEXING_PLAN.md`
// §"Phase 5" for the broader arc.

/// WASM-exposed workbook. Wraps the Rust Workbook so browser demos can
/// evaluate formulas through workbook context, including cross-sheet refs.
#[wasm_bindgen]
pub struct WasmWorkbook {
    workbook: Workbook,
    /// Workbook-level ownership for opaque JS subscription tokens. Each entry
    /// points at an underlying stable-facade subscription; cross-sheet
    /// reactivity reaches that facade through the shared Store graph. The
    /// retained sheet index exists only for unsubscribe and topology remap.
    subscriptions: HashMap<u32, WorkbookCellSubscription>,
    next_token: u32,
    /// Wave 8 custom-formula registry handle. The same `Arc` is installed
    /// on the inner `Workbook` so the formula engine can reach the JS
    /// callbacks via `WorkbookEvalProvider::call_custom`. We keep a
    /// second handle here so `register_custom_formula` /
    /// `unregister_custom_formula` can mutate the map without going
    /// through the workbook's borrow.
    custom_formulas: Arc<WasmCustomFormulaRegistry>,
    /// Phase timings recorded by the most recent
    /// `bulk_import_cells_instrumented` call. `None` until the host calls
    /// the instrumented variant at least once. Stored as a flat
    /// `[f64; 12]` rather than a struct so the wasm-bindgen exposure can
    /// reach it via the simple `Vec<f64>` accessor below — no extra
    /// `serde` wire type needed for a one-shot debug surface.
    ///
    /// Layout (matches `debug_last_bulk_import_phase_ms` doc):
    ///   [0]  cell_count
    ///   [1]  formula_count
    ///   [2]  rpc_deserialize_ms
    ///   [3]  parse_only_ms
    ///   [4]  set_cell_loop_ms
    ///   [5]  set_formula_loop_ms
    ///   [6]  flush_ms
    ///   [7]  engine_total_ms
    ///   [8]  flush_parse_ms          (Phase 1 sub-slice of [6])
    ///   [9]  flush_dep_extract_ms    (Phase 1 sub-slice of [6])
    ///   [10] flush_dep_register_ms   (Phase 1 sub-slice of [6])
    ///   [11] flush_formula_record_ms (Phase 1 sub-slice of [6])
    last_bulk_import_phase_ms: Cell<Option<[f64; 12]>>,
}

#[wasm_bindgen]
impl WasmWorkbook {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        install_panic_hook();
        let custom_formulas = Arc::new(WasmCustomFormulaRegistry::new());
        let mut workbook = Workbook::new();
        // Install the registry on the inner workbook so the formula
        // engine's `WorkbookEvalProvider::call_custom` can reach it. The
        // Arc clone is cheap — same map, two handles.
        workbook.set_custom_function_registry(Some(
            custom_formulas.clone() as Arc<dyn CustomFunctionRegistry>
        ));
        WasmWorkbook {
            workbook,
            subscriptions: HashMap::new(),
            next_token: 0,
            custom_formulas,
            last_bulk_import_phase_ms: Cell::new(None),
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
        let idx = idx as usize;
        if self.workbook.remove_sheet(idx).is_none() {
            return false;
        }
        // Mirror move_sheet: keep token → (sheet_idx, sub) accurate across
        // the shift, or a later unsubscribe_cell resolves against the WRONG
        // sheet (off by one) and leaves the engine-side callback alive,
        // emitting dirty events with a pre-removal index. Tokens on the
        // removed sheet are dropped — their engine subscription died with
        // the sheet.
        self.subscriptions.retain(|_, entry| entry.sheet_idx != idx);
        for entry in self.subscriptions.values_mut() {
            if entry.sheet_idx > idx {
                entry.sheet_idx -= 1;
            }
        }
        true
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

    /// Register a workbook-level defined name. `formula` must start with
    /// `=`; the most common use is `define_name("SQUARE", "=LAMBDA(x,
    /// x*x)")` so cells across all sheets can call `=SQUARE(5)`. The
    /// result of evaluating `formula` is stored under `name`; subsequent
    /// `Expr::Name` and `Expr::FuncCall` lookups for `name` (case-
    /// insensitive) resolve through the registry.
    ///
    /// Returns a JS error string on validation / parse / eval failure:
    ///   - `"reserved-name"` when `name` collides with a built-in
    ///     function name (`SUM`, `IF`, `LAMBDA`, etc.).
    ///   - `"invalid-name"` when `name` violates
    ///     `[A-Za-z_][A-Za-z0-9_]*` (length 1..=255).
    ///   - `"parse-failed"` when `formula` doesn't tokenize.
    ///   - `"eval-failed: #DIV/0!"` (or other error code) when the
    ///     definition's eval surfaces a cell-style error.
    ///
    /// On success the workbook name-version root is published. Materialized
    /// formula-inner atoms that read the registry re-derive through their
    /// Store dependency; unread formulas stay lazy.
    #[wasm_bindgen(js_name = "defineName")]
    pub fn define_name(&mut self, name: &str, formula: &str) -> Result<(), JsValue> {
        self.workbook
            .define_name(name, formula)
            .map_err(workbook_error_to_js)
    }

    /// Remove a previously-registered name. Returns `true` if an entry
    /// was removed; `false` if no entry existed. Publishing the name-version
    /// root makes dependent formula-inner atoms re-derive to `#NAME?` (or any
    /// newly-shadowing definition).
    #[wasm_bindgen(js_name = "undefineName")]
    pub fn undefine_name(&mut self, name: &str) -> bool {
        self.workbook.undefine_name(name)
    }

    /// Enumerate the workbook's defined names in canonical (user-typed)
    /// casing, sorted alphabetically by uppercased key. Useful for the
    /// W2 name-manager dialog so it doesn't need to subscribe to every
    /// `defineName` call individually.
    #[wasm_bindgen(js_name = "definedNames")]
    pub fn defined_names(&self) -> Vec<String> {
        self.workbook.named_names().map(|s| s.to_string()).collect()
    }

    // === Excel Table registry (#32) — CRUD over the workbook-level Table
    // registry. `has_headers` is hard-`true` (MVP); the range is passed as
    // 0-based inclusive bounds (matching `clear_range`). Errors surface as
    // the stable strings from `table_error_to_js`.

    /// Define a Table over `[start..=end]` on `sheet_idx`. `name` is
    /// `Some` to use an explicit (validated) name, or `None`/`undefined`
    /// to auto-generate `Table1`, `Table2`, …. Returns the final
    /// (canonical-cased) Table name.
    #[wasm_bindgen(js_name = "createTable")]
    pub fn create_table(
        &mut self,
        sheet_idx: u32,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        name: Option<String>,
    ) -> Result<String, JsValue> {
        let range = CellRange::new(
            CellAddress::new(start_row, start_col),
            CellAddress::new(end_row, end_col),
        );
        self.workbook
            .define_table(name.as_deref(), sheet_idx as usize, range, true)
            .map_err(table_error_to_js)
    }

    /// Rename a Table, rewriting every referencing formula's text.
    #[wasm_bindgen(js_name = "renameTable")]
    pub fn rename_table(&mut self, name: &str, new_name: &str) -> Result<(), JsValue> {
        self.workbook
            .rename_table(name, new_name)
            .map_err(table_error_to_js)
    }

    /// Rename one column of a Table, rewriting every referencing formula.
    #[wasm_bindgen(js_name = "renameTableColumn")]
    pub fn rename_table_column(
        &mut self,
        name: &str,
        old_column: &str,
        new_column: &str,
    ) -> Result<(), JsValue> {
        self.workbook
            .rename_table_column(name, old_column, new_column)
            .map_err(table_error_to_js)
    }

    /// Remove a Table's registry entry (convert to range — values, formulas,
    /// and formats are untouched).
    #[wasm_bindgen(js_name = "deleteTable")]
    pub fn delete_table(&mut self, name: &str) -> Result<(), JsValue> {
        self.workbook
            .delete_table(name)
            .map_err(table_error_to_js)
    }

    /// Every registered Table as `TableJSON[]`, alphabetical by uppercased
    /// name (the engine's stable order).
    #[wasm_bindgen(js_name = "listTables")]
    pub fn list_tables(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.tables_json())
            .map_err(|err| JsValue::from_str(&format!("serialize tables: {err}")))
    }

    /// One Table as `TableJSON`, or `null` when no Table is registered under
    /// `name` (case-insensitive).
    #[wasm_bindgen(js_name = "getTable")]
    pub fn get_table(&self, name: &str) -> Result<JsValue, JsValue> {
        match self.workbook.get_table(name) {
            Some(entry) => {
                let idx = self.sheet_index_by_name(entry.sheet_name()).unwrap_or(0);
                serde_wasm_bindgen::to_value(&TableJSON::from_entry(entry, idx))
                    .map_err(|err| JsValue::from_str(&format!("serialize table: {err}")))
            }
            None => Ok(JsValue::null()),
        }
    }

    /// Capture the whole Excel Table registry as an undo before-image
    /// (design doc #32 §11/§12). Returns
    /// `{ version: 1, tables: TableJSON[] }` — the same per-Table shape
    /// `listTables` emits, wrapped in a versioned envelope.
    ///
    /// This is the missing before-image for Table DEFINITION changes:
    /// everything `createTable` / `renameTable` / `deleteTable` / the totals
    /// toggle writes into CELLS is already covered by the host's sparse-cell
    /// and format snapshots, but the registry itself (name, sheet anchor,
    /// range, header/totals flags, column names) was not. A host records
    /// this before the mutation and replays it through `restoreTables` to
    /// undo. Pure read — no epoch bump, no recompute.
    #[wasm_bindgen(js_name = "snapshotTables")]
    pub fn snapshot_tables(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&TableRegistrySnapshotJSON {
            version: 1,
            tables: self.tables_json(),
        })
            .map_err(|err| JsValue::from_str(&format!("serialize table snapshot: {err}")))
    }

    /// Replace the whole Table registry with a `snapshotTables` payload,
    /// returning the number of Tables now registered.
    ///
    /// **REPLACE, not additive** (unlike `restoreSparse`): Tables created
    /// after the snapshot are dropped and Tables deleted since are revived,
    /// which is what makes a Table-definition undo symmetric. Restoring an
    /// empty `tables` array therefore CLEARS the registry — it is not a
    /// no-op.
    ///
    /// All-or-nothing: the payload is fully validated (cap 256, name shape,
    /// the §4.2 name mutex against current defined names, same-sheet range
    /// overlap, column-count vs range width) before anything is swapped, so a
    /// rejection leaves the live registry untouched. Errors are the stable
    /// `table_error_to_js` strings plus `"unsupported-snapshot-version"` and
    /// parse messages for a malformed envelope. Only cell values/formulas are
    /// left alone — the registry is a view over them.
    ///
    /// A restore that changes the registry bumps the tables epoch, so
    /// `=SUM(Table1[Qty])` and friends re-derive against the restored
    /// geometry; a restore that reproduces the current registry exactly
    /// skips the bump.
    #[wasm_bindgen(js_name = "restoreTables")]
    pub fn restore_tables(&mut self, value: JsValue) -> Result<u32, JsValue> {
        let payload: TableRegistrySnapshotJSON = serde_wasm_bindgen::from_value(value)
            .map_err(|err| JsValue::from_str(&format!("invalid table snapshot: {err}")))?;
        self.restore_tables_json(payload)
            .map_err(|err| JsValue::from_str(&err))
    }

    /// Push the host's per-sheet MANUALLY-hidden row set as read-only SUBTOTAL
    /// 101-111 evaluation input (design doc #32 §6, CANONICAL_OWNERSHIP §7-1).
    /// `rows` is a `number[]` of 0-based hidden row indices; full-replace
    /// semantics (an empty array clears the sheet's set). The engine models no
    /// hidden state — it consumes this purely as evaluation input, and the
    /// paired epoch bump re-derives only the 101-111 formulas that read it.
    /// SUBTOTAL 1-11 deliberately ignore this set (Excel includes manually
    /// hidden rows in 1-11); filter-hidden rows go through
    /// `setEvalFilterHiddenRows` instead.
    #[wasm_bindgen(js_name = "setEvalHiddenRows")]
    pub fn set_eval_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>) {
        self.workbook
            .set_eval_hidden_rows(sheet_idx as usize, &rows);
    }

    /// Push the host's per-sheet FILTER-hidden row set as read-only evaluation
    /// input (`design-filter-hidden-rows` §6.5). Additive twin of
    /// `setEvalHiddenRows` — that method is unchanged — carrying the source
    /// distinction Excel's two SUBTOTAL layers need: `SUBTOTAL(1-11)` excludes
    /// THIS set but includes manually hidden rows, `SUBTOTAL(101-111)` excludes
    /// both. Same shape and contract as `setEvalHiddenRows`: `rows` is a
    /// `number[]` of 0-based row indices, full-replace, empty array clears,
    /// out-of-range `sheet_idx` is a silent no-op, never throws.
    #[wasm_bindgen(js_name = "setEvalFilterHiddenRows")]
    pub fn set_eval_filter_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>) {
        self.workbook
            .set_eval_filter_hidden_rows(sheet_idx as usize, &rows);
    }

    // --- Engine-owned MANUAL hidden rows (E2 of
    // `design-engine-hidden-rows.md`) --------------------------------------
    //
    // Additive. `setEvalHiddenRows` above keeps its exact signature and stays
    // the host's write path for now; these expose the state the engine has
    // begun to own, so a later slice can flip the host from "pusher" to
    // "caller" without another export-surface change.

    /// Mark `rows` (0-based) manually hidden on `sheetIdx`, additively.
    /// Returns whether anything changed. Out-of-range `sheetIdx` and rows
    /// that were already hidden are silent `false`s; never throws.
    #[wasm_bindgen(js_name = "hideRows")]
    pub fn hide_rows(&mut self, sheet_idx: u32, rows: Vec<u32>) -> bool {
        self.workbook.hide_rows(sheet_idx as usize, &rows)
    }

    /// Un-hide `rows` (0-based) on `sheetIdx`. Rows that were not hidden are
    /// ignored. Returns whether anything changed; never throws.
    #[wasm_bindgen(js_name = "unhideRows")]
    pub fn unhide_rows(&mut self, sheet_idx: u32, rows: Vec<u32>) -> bool {
        self.workbook.unhide_rows(sheet_idx as usize, &rows)
    }

    /// The manually hidden rows on `sheetIdx` as a `number[]`, ascending.
    /// Empty for an out-of-range sheet.
    #[wasm_bindgen(js_name = "listHiddenRows")]
    pub fn list_hidden_rows(&self, sheet_idx: u32) -> Vec<u32> {
        self.workbook.list_hidden_rows(sheet_idx as usize)
    }

    /// Capture every sheet's manually hidden rows as an undo before-image.
    /// Twin of `snapshotTables`: pure read, no epoch bump, whole-workbook
    /// REPLACE on the way back through `restoreHidden`. Sheets with nothing
    /// hidden are omitted.
    #[wasm_bindgen(js_name = "snapshotHidden")]
    pub fn snapshot_hidden(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&HiddenRowsSnapshotJSON {
            version: 1,
            hidden: self.hidden_rows_json(),
        })
        .map_err(|err| JsValue::from_str(&format!("serialize hidden snapshot: {err}")))
    }

    /// Replace every sheet's manually hidden rows with a `snapshotHidden`
    /// payload, returning how many sheets ended up with at least one hidden
    /// row. Restoring an empty `hidden` array CLEARS everything — that is the
    /// point of REPLACE, not a no-op. Entries for sheets that no longer exist
    /// are dropped silently. A restore that reproduces the current state
    /// fires no epoch and costs no recompute.
    #[wasm_bindgen(js_name = "restoreHidden")]
    pub fn restore_hidden(&mut self, value: JsValue) -> Result<u32, JsValue> {
        let payload: HiddenRowsSnapshotJSON = serde_wasm_bindgen::from_value(value)
            .map_err(|err| JsValue::from_str(&format!("invalid hidden snapshot: {err}")))?;
        self.restore_hidden_json(payload)
            .map_err(|err| JsValue::from_str(&err))
    }

    // --- Engine-owned FILTER (E3 of `design-engine-hidden-rows.md`) -------
    //
    // Additive. `setEvalFilterHiddenRows` above keeps its exact signature
    // and stays the host's write path for now; these expose the state the
    // engine has begun to own, so a later slice can flip the host from
    // "pusher" to "caller" without another export-surface change.
    //
    // All three commands follow the `sortRange` convention: success and
    // every rejection come back inside the `Ok` arm as a plain object
    // discriminated by `ok`, so a structured refusal is never a thrown
    // exception. Only a serialization failure throws.

    /// Apply `{ rules: ColumnFilterRule[] }` to `sheetIdx`: run the
    /// predicate ONCE and commit both the rules and the rows they hid.
    ///
    /// Returns `{ ok: true, hiddenRows, scannedRows, predicateCells }`, or
    /// `{ ok: false, code, message? }`. `code: "source-too-large"` is the
    /// engine-side twin of the adapter's `FILTER_SORT_SOURCE_TOO_LARGE` —
    /// the filter does NOT activate and nothing is truncated.
    ///
    /// Visibility is a SNAPSHOT taken here. Later cell edits do not move
    /// it; `reapplyFilter` is the refresh path.
    #[wasm_bindgen(js_name = "applyFilter")]
    pub fn apply_filter(&mut self, sheet_idx: u32, payload: JsValue) -> Result<JsValue, JsValue> {
        let payload: ApplyFilterPayloadJSON = match serde_wasm_bindgen::from_value(payload) {
            Ok(payload) => payload,
            Err(err) => {
                return Ok(sort_error_to_js("invalid-payload", None, Some(&err.to_string())))
            }
        };
        let rules: Vec<ColumnFilterRule> = payload
            .rules
            .into_iter()
            .map(ColumnFilterRuleJSON::into_rule)
            .collect();
        Self::filter_result_to_js(self.workbook.apply_filter(sheet_idx as usize, &rules))
    }

    /// `Data -> Reapply` (Excel `Ctrl+Alt+L`): re-run `sheetIdx`'s ALREADY
    /// COMMITTED rules against current cell values. Carries no rules of its
    /// own, so it can never change WHAT is filtered — only which rows
    /// currently satisfy it.
    #[wasm_bindgen(js_name = "reapplyFilter")]
    pub fn reapply_filter(&mut self, sheet_idx: u32) -> Result<JsValue, JsValue> {
        Self::filter_result_to_js(self.workbook.reapply_filter(sheet_idx as usize))
    }

    /// Drop `sheetIdx`'s filter — rules and derived rows both. Scan-free.
    #[wasm_bindgen(js_name = "clearFilter")]
    pub fn clear_filter(&mut self, sheet_idx: u32) -> Result<JsValue, JsValue> {
        Self::filter_result_to_js(self.workbook.clear_filter(sheet_idx as usize))
    }

    /// Read `sheetIdx`'s committed filter as
    /// `{ rules: ColumnFilterRule[], hiddenRows: number[] }`.
    ///
    /// A WHOLE-SHEET read, deliberately not window-bounded: a host has to
    /// know about hidden rows OUTSIDE the visible window to expand that
    /// window correctly, so answering with a windowed subset would be
    /// circular. Called on sheet activation and after a restore — never per
    /// frame, per scroll, or per revision.
    #[wasm_bindgen(js_name = "getFilter")]
    pub fn get_filter(&self, sheet_idx: u32) -> Result<JsValue, JsValue> {
        let sheet_idx = sheet_idx as usize;
        let entry = SheetFilterStateJSON {
            sheet: sheet_idx as u32,
            rules: self
                .workbook
                .filter_rules(sheet_idx)
                .iter()
                .map(ColumnFilterRuleJSON::from_rule)
                .collect(),
            hidden_rows: self.workbook.filter_hidden_rows(sheet_idx),
        };
        serde_wasm_bindgen::to_value(&entry)
            .map_err(|err| JsValue::from_str(&format!("serialize filter: {err}")))
    }

    /// Capture every sheet's filter state as an undo before-image. Twin of
    /// `snapshotHidden`: pure read, no epoch bump, whole-workbook REPLACE on
    /// the way back through `restoreFilters`. Sheets with no filter are
    /// omitted.
    #[wasm_bindgen(js_name = "snapshotFilters")]
    pub fn snapshot_filters(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&FilterSnapshotJSON {
            version: 1,
            filters: self.filters_json(),
        })
        .map_err(|err| JsValue::from_str(&format!("serialize filter snapshot: {err}")))
    }

    /// Replace every sheet's filter state with a `snapshotFilters` payload,
    /// returning how many sheets ended up with a filter. Restoring an empty
    /// `filters` array CLEARS everything — that is the point of REPLACE, not
    /// a no-op. Entries for sheets that no longer exist are dropped
    /// silently, and no predicate is re-run.
    #[wasm_bindgen(js_name = "restoreFilters")]
    pub fn restore_filters(&mut self, value: JsValue) -> Result<u32, JsValue> {
        let payload: FilterSnapshotJSON = serde_wasm_bindgen::from_value(value)
            .map_err(|err| JsValue::from_str(&format!("invalid filter snapshot: {err}")))?;
        self.restore_filters_json(payload)
            .map_err(|err| JsValue::from_str(&err))
    }

    /// Toggle a Table's totals row (design doc #32 §7). `enabled == true`
    /// grows the Table by one row and writes a default `=SUBTOTAL(109, …)`
    /// (SUM) in the last column — unless the row below is occupied, which
    /// rejects with `"totals-row-blocked"`. `enabled == false` clears the
    /// totals cells and shrinks the Table. Idempotent per state.
    #[wasm_bindgen(js_name = "setTableTotalsRow")]
    pub fn set_table_totals_row(&mut self, name: &str, enabled: bool) -> Result<(), JsValue> {
        self.workbook
            .set_table_totals_row(name, enabled)
            .map_err(table_error_to_js)
    }

    /// Set one totals-row column's aggregate (design doc #32 §7). `func` is a
    /// camelCase id: `"none"` (clears the cell) / `"average"` / `"count"`
    /// (COUNTA) / `"countNums"` (COUNT) / `"max"` / `"min"` / `"sum"` /
    /// `"stdDev"` / `"var"`. Non-`none` ids write `=SUBTOTAL(1xx, Table[Col])`
    /// with the 101-111 hidden-excluding code. Requires the totals row to be
    /// enabled first (`"no-totals-row"` otherwise); unknown `func` yields
    /// `"invalid-totals-function"`.
    #[wasm_bindgen(js_name = "setTableTotalFunction")]
    pub fn set_table_total_function(
        &mut self,
        name: &str,
        column: &str,
        func: &str,
    ) -> Result<(), JsValue> {
        let parsed = TotalsFunction::from_id(func)
            .ok_or_else(|| JsValue::from_str("invalid-totals-function"))?;
        self.workbook
            .set_table_total_function(name, column, parsed)
            .map_err(table_error_to_js)
    }

    pub fn clear_cell(&mut self, sheet_idx: u32, addr: &str) {
        self.workbook.clear_cell(sheet_idx as usize, addr);
    }

    // Structural ops route through the WORKBOOK wrappers (not
    // `sheet_mut(..).insert_row`) so registered Excel Tables anchored to the
    // sheet follow the edit and their `tables_epoch` fires (design doc #32
    // §4.3 item c). For a table-less workbook these wrappers are behaviorally
    // identical to the old direct-sheet path.
    pub fn insert_row(&mut self, sheet_idx: u32, at: u32, count: u32) {
        self.workbook.insert_rows(sheet_idx as usize, at, count);
    }

    pub fn delete_row(&mut self, sheet_idx: u32, at: u32, count: u32) {
        self.workbook.delete_rows(sheet_idx as usize, at, count);
    }

    pub fn insert_col(&mut self, sheet_idx: u32, at: u32, count: u32) {
        self.workbook.insert_columns(sheet_idx as usize, at, count);
    }

    pub fn delete_col(&mut self, sheet_idx: u32, at: u32, count: u32) {
        self.workbook.delete_columns(sheet_idx as usize, at, count);
    }

    pub fn get_display(&self, sheet_idx: u32, addr: &str) -> String {
        let val = self.workbook_value(sheet_idx, addr);
        value_to_display(&val)
    }

    pub fn get_number(&self, sheet_idx: u32, addr: &str) -> f64 {
        // Funnel through `collapse_array_for_js` so spill anchors return
        // their [0][0] element instead of NaN at the JS boundary.
        match collapse_array_for_js(&self.workbook_value(sheet_idx, addr)).into_owned() {
            Value::Number(n) => n,
            _ => f64::NAN,
        }
    }

    pub fn get_type(&self, sheet_idx: u32, addr: &str) -> String {
        value_to_cell_type(&self.workbook_value(sheet_idx, addr))
    }

    pub fn is_error(&self, sheet_idx: u32, addr: &str) -> bool {
        self.workbook_value(sheet_idx, addr).is_error()
    }

    /// Workbook variant of `WasmSheet::spill_info`. See that method for
    /// JS-side semantics. Returns `null` for an unknown sheet index.
    #[wasm_bindgen(js_name = "spillInfo")]
    pub fn spill_info(&self, sheet_idx: u32, addr: &str) -> JsValue {
        let Some(parsed) = CellAddress::parse(addr) else {
            return JsValue::null();
        };
        let Some(sheet) = self.workbook.sheet(sheet_idx as usize) else {
            return JsValue::null();
        };
        match sheet.spill_info(parsed) {
            Some((rows, cols)) => {
                let arr = js_sys::Uint32Array::new_with_length(2);
                arr.copy_from(&[rows, cols]);
                arr.into()
            }
            None => JsValue::null(),
        }
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

    /// Set a cell to a numeric value through the workbook. The shared Store
    /// propagates local and cross-sheet formula dependencies and publishes
    /// changed stable facades to subscribers.
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

    /// Clear a cell through the workbook. Local and cross-sheet formulas that
    /// read the cell re-derive through the shared Store graph.
    #[wasm_bindgen(js_name = "clearCellAt")]
    pub fn clear_cell_at(&mut self, sheet_idx: usize, addr: &str) {
        self.workbook.clear_cell(sheet_idx, addr);
    }

    /// Set a cell's formula through the workbook. Returns `true` if the
    /// formula parsed and installed cleanly, `false` if parse failed
    /// (cell becomes `#VALUE!`) or a cycle was detected (cell becomes
    /// `#CYCLE!`).
    ///
    /// The legacy `set_formula(sheet_idx: u32, ...)` routes through the same
    /// workbook method. This `usize`-typed alias is retained for generated
    /// bindings and worker callers.
    #[wasm_bindgen(js_name = "setFormulaAt")]
    pub fn set_formula_at(&mut self, sheet_idx: usize, addr: &str, src: &str) -> bool {
        self.workbook.set_formula(sheet_idx, addr, src)
    }

    // === Dynamic-array spill: fallible setters ===
    //
    // These mirror the infallible `set_cell_*` / `setFormulaAt` /
    // `clearCellAt` entries above but surface `SheetError::SpillCellWrite`
    // across the WASM boundary so the JS layer can show a "cannot edit
    // spill" toast and restore the cell display. The result shape is:
    //
    //   { ok: true } | { ok: false, code: 'spill-write', anchor: 'A1' }
    //
    // `code: 'invalid-address'` is also returned for unparseable addrs;
    // the legacy infallible path silently no-ops in that case.

    #[wasm_bindgen(js_name = "trySetCellNumber")]
    pub fn try_set_cell_number(
        &mut self,
        sheet_idx: usize,
        addr: &str,
        value: f64,
    ) -> Result<JsValue, JsValue> {
        try_set_cell_result(
            self.workbook
                .try_set_cell(sheet_idx, addr, Value::Number(value)),
        )
    }

    #[wasm_bindgen(js_name = "trySetCellText")]
    pub fn try_set_cell_text(
        &mut self,
        sheet_idx: usize,
        addr: &str,
        value: &str,
    ) -> Result<JsValue, JsValue> {
        try_set_cell_result(self.workbook.try_set_cell(
            sheet_idx,
            addr,
            Value::Text(value.to_string()),
        ))
    }

    #[wasm_bindgen(js_name = "trySetCellBoolean")]
    pub fn try_set_cell_boolean(
        &mut self,
        sheet_idx: usize,
        addr: &str,
        value: bool,
    ) -> Result<JsValue, JsValue> {
        try_set_cell_result(
            self.workbook
                .try_set_cell(sheet_idx, addr, Value::Boolean(value)),
        )
    }

    #[wasm_bindgen(js_name = "trySetCellError")]
    pub fn try_set_cell_error(
        &mut self,
        sheet_idx: usize,
        addr: &str,
        value: &str,
    ) -> Result<JsValue, JsValue> {
        let err = value_error_from_display(value);
        try_set_cell_result(
            self.workbook
                .try_set_cell(sheet_idx, addr, Value::Error(err)),
        )
    }

    #[wasm_bindgen(js_name = "tryClearCellAt")]
    pub fn try_clear_cell_at(&mut self, sheet_idx: usize, addr: &str) -> Result<JsValue, JsValue> {
        try_set_cell_result(self.workbook.try_clear_cell(sheet_idx, addr))
    }

    /// Returns the formula install outcome plus an optional spill-write
    /// rejection. JS shape:
    ///   { ok: true, installed: true } | { ok: true, installed: false }
    ///     | { ok: false, code: 'spill-write', anchor: 'A1' }
    /// `installed: false` corresponds to parse failure (`#VALUE!`) or
    /// cycle detection (`#CYCLE!`) — the cell value already reflects
    /// that, and the caller can pick it up via a follow-up snapshot.
    #[wasm_bindgen(js_name = "trySetFormulaAt")]
    pub fn try_set_formula_at(
        &mut self,
        sheet_idx: usize,
        addr: &str,
        src: &str,
    ) -> Result<JsValue, JsValue> {
        match self.workbook.try_set_formula(sheet_idx, addr, src) {
            Ok(installed) => {
                let obj = js_sys::Object::new();
                js_sys::Reflect::set(&obj, &JsValue::from_str("ok"), &JsValue::TRUE).ok();
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("installed"),
                    &JsValue::from_bool(installed),
                )
                .ok();
                Ok(obj.into())
            }
            Err(err) => Ok(sheet_error_to_js(err)),
        }
    }

    /// Look up the spill anchor for a non-anchor spilled cell. Returns
    /// the anchor address as a `"A1"`-style string, or `null` when
    /// `addr` is the anchor itself, a plain cell, or an empty cell.
    /// Used by the JS UI to draw the spill outline relative to the
    /// anchor even when the anchor cell is outside the visible window.
    #[wasm_bindgen(js_name = "spillAnchor")]
    pub fn spill_anchor(&self, sheet_idx: u32, addr: &str) -> JsValue {
        match self.workbook.spill_anchor(sheet_idx as usize, addr) {
            Some(anchor) => JsValue::from_str(&anchor.to_string()),
            None => JsValue::null(),
        }
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
    /// The callback subscribes to the sheet's stable cell facade. Local and
    /// cross-sheet dependencies both settle through the workbook-scoped Store;
    /// this map only owns the opaque token and sheet-remap lifecycle.
    pub fn subscribe_cell(&mut self, sheet_name: &str, addr: &str, cb: js_sys::Function) -> u32 {
        let Some(sheet_idx) = self.workbook.index_of(sheet_name) else {
            // Unknown sheet — hand back a token that is never inserted,
            // mirroring `unsubscribe_cell`'s idempotent posture. Caller
            // can `unsubscribe_cell(token)` safely as a no-op.
            let token = self.next_token;
            self.next_token = self.next_token.wrapping_add(1);
            return token;
        };
        if CellAddress::parse(addr).is_none() {
            let token = self.next_token;
            self.next_token = self.next_token.wrapping_add(1);
            return token;
        }

        let token = self.next_token;
        self.next_token = self.next_token.wrapping_add(1);

        let listener = JsCallbackListener { callback: cb };
        let Some(sheet) = self.workbook.sheet_mut(sheet_idx) else {
            return token;
        };
        let sub = sheet.subscribe_cell_boxed(addr, Box::new(listener));
        self.subscriptions
            .insert(token, WorkbookCellSubscription { sheet_idx, sub });
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

    /// Wave 8: register a JS callback as a workbook-scope custom formula.
    /// After this call, `=MYFUNC(...)` in any cell resolves through the
    /// registry: the engine evaluates the args eagerly, then invokes the
    /// callback with a JS Array of marshaled args. Lookup is case-
    /// insensitive (the engine receives upper-cased names from the
    /// formula parser; we upper-case `name` here to match).
    ///
    /// JS signature contract:
    ///   `(args: Array<number|string|boolean|null>) => number | string |`
    ///   `  boolean | null | { error: "#DIV/0!" | ... }`
    /// If the callback throws, the cell surfaces `#VALUE!`. If it returns
    /// a Date, function, or other non-scalar object, the cell surfaces
    /// `#TYPE!`. NaN / Infinity return values are folded to `#NUM!`.
    ///
    /// Registering over an existing name silently replaces the callback and
    /// publishes the custom-registry Store root. Materialized formulas that
    /// consulted the registry re-derive; unread formulas remain lazy.
    #[wasm_bindgen(js_name = "registerCustomFormula")]
    pub fn register_custom_formula(&mut self, name: String, callback: js_sys::Function) {
        self.custom_formulas.register(&name, callback);
        self.workbook
            .invalidate_all_formulas_for_custom_function_change();
    }

    /// Register `name` as an ASYNC custom formula. Name-only: the JS
    /// callback stays in the worker's local map and never crosses into
    /// wasm. During evaluation the engine memoizes per (name, args),
    /// holds the cell at `#BUSY!`, and enqueues a pending request; the
    /// host drains with `drainAsyncCustomRequests`, awaits the callback,
    /// and settles with `resolveAsyncCustomCall`. Registering over an
    /// existing name (sync or async) replaces it and publishes the
    /// registry root like `registerCustomFormula`.
    #[wasm_bindgen(js_name = "registerCustomFormulaAsync")]
    pub fn register_custom_formula_async(&mut self, name: String) {
        self.custom_formulas.register_async(&name);
        self.workbook
            .invalidate_all_formulas_for_custom_function_change();
    }

    /// Drain the async custom-formula request queue accumulated since the
    /// last drain. Returns `Array<{ callId: number, name: string,
    /// args: Array<number|string|boolean|null|any[][]> }>` — args marshal
    /// with the same rules as sync callback invocation (ranges arrive as
    /// 2-D row-major arrays). call_id is a u64 exposed as f64: safe below
    /// 2^53 calls. Call after any mutation entry point; empty queue
    /// returns an empty array at negligible cost.
    #[wasm_bindgen(js_name = "drainAsyncCustomRequests")]
    pub fn drain_async_custom_requests(&mut self) -> JsValue {
        let arr = js_sys::Array::new();
        for call in self.workbook.take_pending_async_custom_calls() {
            let obj = js_sys::Object::new();
            let _ = js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("callId"),
                &JsValue::from_f64(call.call_id as f64),
            );
            let _ = js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("name"),
                &JsValue::from_str(&call.name),
            );
            let args = js_sys::Array::new();
            for v in &call.args {
                args.push(&value_to_js(v));
            }
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("args"), &args);
            arr.push(&obj);
        }
        arr.into()
    }

    /// Settle an async custom-formula call. `value` marshals with the
    /// same rules as a sync callback's return (`js_to_value`): scalars,
    /// error tokens / `{ error }` objects; `#BUSY!` demotes to `#VALUE!`.
    /// The worker maps callback throw/reject to `{ error: "#VALUE!" }`
    /// and calls this same entry — there is no separate reject API.
    /// Returns `false` when the call is unknown or stale (registry
    /// changed while the Promise was in flight); the value is dropped.
    #[wasm_bindgen(js_name = "resolveAsyncCustomCall")]
    pub fn resolve_async_custom_call(&mut self, call_id: f64, value: JsValue) -> bool {
        let settled = js_to_value(&value);
        self.workbook
            .resolve_async_custom_call(call_id as u64, settled)
            .unwrap_or(false)
    }

    /// Remove a previously-registered custom formula. Returns `true` if
    /// an entry was removed; `false` if no entry existed. The registry Store
    /// root is published only when removal succeeds, so materialized formulas
    /// that consulted it re-derive and may surface `#NAME?`.
    #[wasm_bindgen(js_name = "unregisterCustomFormula")]
    pub fn unregister_custom_formula(&mut self, name: &str) -> bool {
        let removed = self.custom_formulas.unregister(name);
        if removed {
            self.workbook
                .invalidate_all_formulas_for_custom_function_change();
        }
        removed
    }

    /// Number of currently-registered custom formulas. Debug probe so
    /// JS tests can assert their register / unregister calls landed.
    #[wasm_bindgen(js_name = "customFormulaCount")]
    pub fn custom_formula_count(&self) -> u32 {
        self.custom_formulas.count() as u32
    }

    /// List of registered custom-formula names (upper-cased). Stable
    /// alphabetical ordering not guaranteed — `HashMap::keys()` order.
    /// Used by hosts that want to render a "registered formulas"
    /// inspector. Returns a `JsValue::Array<String>`.
    #[wasm_bindgen(js_name = "customFormulaNames")]
    pub fn custom_formula_names(&self) -> JsValue {
        let arr = js_sys::Array::new();
        for n in self.custom_formulas.registered_names() {
            arr.push(&JsValue::from_str(&n));
        }
        arr.into()
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
        // No per-call payload cap. The pre-Phase-2 path needed one to
        // dodge a WASM allocator panic on the eager formula-install
        // loop; the Phase 2/3 lazy `bulk_load` makes single-call 5M+
        // payloads finish cleanly. See `CAP_REMOVAL_2026-06-11.md`.
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
                // Typed loader entries (A-9 follow-up): no per-cell
                // `to_string_repr` → re-parse round trip.
                let addr = CellAddress::new(cell.row, cell.col);
                match kind {
                    "number" => match &cell.value {
                        Some(BulkImportValueJSON::Number(n)) if n.is_finite() => {
                            loader.set_cell_at(cell.sheet, addr, Value::Number(*n));
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
                            loader.set_cell_at(cell.sheet, addr, Value::Text(s.clone()));
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
                            loader.set_cell_at(cell.sheet, addr, Value::Boolean(*b));
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
                            loader.set_cell_at(
                                cell.sheet,
                                addr,
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
                            if loader.set_formula_at(cell.sheet, addr, s) {
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
                        loader.clear_cell_at(cell.sheet, addr);
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

    /// STORAGE_PRIMARY Phase 6.2: storage-primary bulk install. The
    /// payload deserializes straight into the per-sheet
    /// `HashMap<CellAddress, _>` maps and `Workbook::install_workbook_bulk`
    /// swaps them into each sheet — no per-cell engine API calls, no
    /// parse, no dep extraction, no ops queue. Formulas hydrate lazily
    /// on first read.
    ///
    /// Wire shape (see `SheetBulkInstallJSON`) — the addr string is
    /// `"R:C"` (zero-based) or A1 form; formula pair values are raw
    /// source text:
    /// ```ts
    /// type WorkbookBulkPayload = Array<{
    ///   sheet: number,
    ///   primitives: Array<[string, number|string|boolean|null|{error:string}]>,
    ///   formulas:   Array<[string, string]>,
    /// }>
    /// ```
    ///
    /// Returns `Array<{ sheet, primitivesInstalled, formulasInstalled,
    /// crossSheetParsed }>`. `crossSheetParsed` is a compatibility field and
    /// is always zero because Store evaluates parked formulas lazily. Each
    /// listed sheet is fully REPLACED. The legacy `bulk_import_cells` path
    /// stays available until Phase 6.4.
    pub fn bulk_install_workbook(&mut self, payload: JsValue) -> Result<JsValue, JsValue> {
        let sheets: Vec<SheetBulkInstallJSON> = serde_wasm_bindgen::from_value(payload)
            .map_err(|err| JsValue::from_str(&format!("invalid bulk install payload: {err}")))?;

        let sheet_indexes: Vec<usize> = sheets.iter().map(|s| s.sheet).collect();
        let engine_payload: Vec<(
            usize,
            HashMap<CellAddress, Value>,
            HashMap<CellAddress, String>,
        )> = sheets
            .into_iter()
            .map(|s| (s.sheet, s.primitives.0, s.formulas.0))
            .collect();

        let stats = self
            .workbook
            .install_workbook_bulk(engine_payload)
            .map_err(|err| JsValue::from_str(&format!("bulk install rejected: {err}")))?;

        let stats_json: Vec<BulkInstallStatsJSON> = sheet_indexes
            .into_iter()
            .zip(stats)
            .map(|(sheet, s)| BulkInstallStatsJSON {
                sheet,
                primitives_installed: s.primitives_installed as u32,
                formulas_installed: s.formulas_installed as u32,
                cross_sheet_parsed: s.cross_sheet_parsed as u32,
            })
            .collect();
        serde_wasm_bindgen::to_value(&stats_json)
            .map_err(|err| JsValue::from_str(&format!("serialize install stats: {err}")))
    }

    /// **Instrumented variant** of [`Self::bulk_import_cells`]: same end
    /// effect on the workbook, but records phase timings on the
    /// `WasmWorkbook` that the host can read back via
    /// `debug_last_bulk_import_phase_ms()`.
    ///
    /// Decomposition matches `bulk_import_trace::BulkImportPhaseTimings`
    /// plus two extras measured here (deserialize / normalize cost):
    ///
    /// - `rpc_deserialize_ms`: `serde_wasm_bindgen::from_value` cost
    ///   (the JS → Rust translation of the cells array). Combined with
    ///   the host-side `postMessage` cost the bench measures, this
    ///   gives the full "RPC boundary" picture.
    /// - `parse_only_ms`: isolated parser-only pass across formula
    ///   strings.
    /// - `set_cell_loop_ms`: time the engine spent storing primitives.
    /// - `set_formula_loop_ms`: time the engine spent installing formulas
    ///   (parse, cycle check, structural metadata, and storage).
    /// - `flush_ms`: implicit `WorkbookLoader::flush` (storage replay, shared
    ///   Store propagation, structural maintenance, and subscriber dedup).
    ///
    /// **Behavior preservation**: the per-cell write ORDER differs from
    /// the production `bulk_import_cells` (primitives first, then
    /// formulas, instead of caller order). For the perf bench this is
    /// fine because seed cells and formula cells live in disjoint
    /// columns. Hosts that need order-preserving import MUST use
    /// `bulk_import_cells`, not this instrumented variant.
    ///
    /// Invalid cells (bad kind / coords / value type) are silently
    /// dropped here — the stats path is bypassed because this is a
    /// debug-only entry point and the goal is to measure engine cost
    /// over the WELL-FORMED batch. Hosts that want issue accounting
    /// should call the non-instrumented variant.
    #[wasm_bindgen(js_name = "bulkImportCellsInstrumented")]
    pub fn bulk_import_cells_instrumented(&mut self, cells: JsValue) -> Result<JsValue, JsValue> {
        use einfach_excel_core::bulk_import_trace::{
            run_bulk_import_with_phase_timings, BulkImportCellInput, BulkImportCellKind,
        };

        // ---- Phase: rpc_deserialize -----------------------------------
        // Measure the JsValue → Vec<WorkbookImportCellJSON> cost. This
        // is the post-postMessage half of the "RPC boundary" — the JS
        // side measures the wall-clock from call → return and the
        // difference (wall − engine_total − deserialize − parse_only)
        // approximates the structured-clone + wasm-bindgen marshaling
        // overhead that this method does NOT cover.
        let t_de_start = js_sys::Date::now();
        let raw_cells: Vec<WorkbookImportCellJSON> = serde_wasm_bindgen::from_value(cells)
            .map_err(|err| JsValue::from_str(&format!("invalid import cells: {err}")))?;
        let t_de_end = js_sys::Date::now();
        let rpc_deserialize_ms = t_de_end - t_de_start;

        // ---- Normalize raw cells → typed engine inputs ----------------
        // Off the timer: this is per-cell validation that does NOT
        // belong to any engine phase. The cost is roughly proportional
        // to cell_count but doesn't fluctuate with workbook size, so
        // omitting it from the breakdown is safe.
        let sheet_count = self.workbook.sheet_count();
        let mut inputs: Vec<BulkImportCellInput> = Vec::with_capacity(raw_cells.len());
        for cell in raw_cells.into_iter() {
            let kind_str = match &cell.kind {
                BulkImportKindJSON::Text(k) => k.clone(),
                BulkImportKindJSON::Invalid => continue,
            };
            if cell.sheet >= sheet_count {
                continue;
            }
            // Coordinates come pre-validated by the JS host (row/col are
            // u32); we just wrap them. No string round-trip needed.
            let addr = CellAddress::new(cell.row, cell.col);
            let mapped = match kind_str.as_str() {
                "number" => match &cell.value {
                    Some(BulkImportValueJSON::Number(n)) if n.is_finite() => {
                        Some(BulkImportCellKind::Number(*n))
                    }
                    _ => None,
                },
                "text" => match &cell.value {
                    Some(BulkImportValueJSON::Text(s)) => Some(BulkImportCellKind::Text(s.clone())),
                    _ => None,
                },
                "boolean" => match &cell.value {
                    Some(BulkImportValueJSON::Boolean(b)) => Some(BulkImportCellKind::Boolean(*b)),
                    _ => None,
                },
                "error" => match &cell.value {
                    Some(BulkImportValueJSON::Text(s)) => {
                        Some(BulkImportCellKind::Error(value_error_from_display(s)))
                    }
                    _ => None,
                },
                "formula" => match &cell.value {
                    Some(BulkImportValueJSON::Text(s)) => {
                        Some(BulkImportCellKind::Formula(s.clone()))
                    }
                    _ => None,
                },
                "null" => Some(BulkImportCellKind::Null),
                _ => None,
            };
            if let Some(k) = mapped {
                inputs.push(BulkImportCellInput {
                    sheet_idx: cell.sheet,
                    addr,
                    kind: k,
                });
            }
        }

        // ---- Phase: engine work (driver records its own phase split) -
        let timings =
            run_bulk_import_with_phase_timings(&mut self.workbook, &inputs, js_sys::Date::now);

        // ---- Stash for the debug accessor ------------------------------
        self.last_bulk_import_phase_ms.set(Some([
            timings.cell_count as f64,
            timings.formula_count as f64,
            rpc_deserialize_ms,
            timings.parse_only_ms,
            timings.set_cell_loop_ms,
            timings.set_formula_loop_ms,
            timings.flush_ms,
            timings.engine_total_ms,
            timings.flush_parse_ms,
            timings.flush_dep_extract_ms,
            timings.flush_dep_register_ms,
            timings.flush_formula_record_ms,
        ]));

        // ---- Return a thin success object (NOT the full stats wire) ---
        // Bench only needs to know the call succeeded; the breakdown is
        // read separately. Mirroring the full stats here would defeat the
        // purpose of isolating engine cost from serialize cost.
        Ok(JsValue::from_f64(timings.engine_total_ms))
    }

    /// Read back the phase timings recorded by the most recent
    /// [`Self::bulk_import_cells_instrumented`] call. Returns a flat
    /// `Vec<f64>` indexed as:
    ///
    /// | Index | Field |
    /// |---:|---|
    /// | 0  | cell_count |
    /// | 1  | formula_count |
    /// | 2  | rpc_deserialize_ms |
    /// | 3  | parse_only_ms |
    /// | 4  | set_cell_loop_ms |
    /// | 5  | set_formula_loop_ms |
    /// | 6  | flush_ms |
    /// | 7  | engine_total_ms |
    /// | 8  | flush_parse_ms          (Phase 1 sub-slice of flush_ms) |
    /// | 9  | flush_dep_extract_ms    (Phase 1 sub-slice of flush_ms) |
    /// | 10 | flush_dep_register_ms   (Phase 1 sub-slice of flush_ms) |
    /// | 11 | flush_formula_record_ms (Phase 1 sub-slice of flush_ms) |
    ///
    /// Indices [8..=11] are retained compatibility buckets that decompose
    /// per-formula `install_parsed_formula` work inside the implicit flush.
    /// The dependency-extract bucket now measures structural metadata and the
    /// registration bucket stays near zero. Their sum should be no greater
    /// than `flush_ms`; the remainder is Store propagation, structural work,
    /// and subscriber dedup.
    ///
    /// Returns an empty `Vec<f64>` if no instrumented bulk import has
    /// run yet on this workbook.
    #[wasm_bindgen(js_name = "debugLastBulkImportPhaseMs")]
    pub fn debug_last_bulk_import_phase_ms(&self) -> Vec<f64> {
        match self.last_bulk_import_phase_ms.get() {
            Some(arr) => arr.to_vec(),
            None => Vec::new(),
        }
    }

    /// Atom-delegation diagnostics aggregated across every sheet. This is a
    /// measurement-only debug surface; hydrated formula/static-range metadata
    /// is O(formula_count), while the legacy point-fanout fields stay zero.
    ///
    /// Returns a JS object with these fields (camelCase):
    /// - `totalFormulaCount` — sum of `formula_cells.len()` over sheets
    /// - `totalPointDepEdges` — always zero; Store owns point dependencies
    /// - `totalRangeDepEntries` — materialized Store geometry roots
    /// - `maxFanout` / `avgFanout` — always zero; no address fanout index
    /// - `rangeFormulaCount` — hydrated formulas with static range metadata
    #[wasm_bindgen(js_name = "debugDepGraphStats")]
    pub fn debug_dep_graph_stats(&self) -> Result<JsValue, JsValue> {
        let mut total = DepGraphStatsJSON::default();
        for sheet_idx in 0..self.workbook.sheet_count() {
            let Some(sheet) = self.workbook.sheet(sheet_idx) else {
                continue;
            };
            let s: DepGraphStats = sheet.debug_dep_graph_stats();
            total.total_formula_count = total.total_formula_count.saturating_add(s.formula_count);
            total.total_point_dep_edges = total
                .total_point_dep_edges
                .saturating_add(s.total_point_dep_edges);
            total.total_range_dep_entries = total
                .total_range_dep_entries
                .saturating_add(s.total_range_dep_entries);
            if s.max_fanout > total.max_fanout {
                total.max_fanout = s.max_fanout;
            }
            total.range_formula_count = total
                .range_formula_count
                .saturating_add(s.range_formula_count);
        }
        total.avg_fanout = 0.0;
        serde_wasm_bindgen::to_value(&total)
            .map_err(|err| JsValue::from_str(&format!("serialize dep graph stats: {err}")))
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
    ///
    /// **Contract: ADDITIVE merge onto the live workbook** (audit B-7).
    /// There is no teardown and no subscription reset — records are
    /// applied on top of whatever the workbook already holds, and a
    /// `"null"`-kind record explicitly clears its cell. The legacy
    /// sheet-store relies on this for large-range-clear undo: it
    /// snapshots only the range's non-empty cells, clears, and undoes
    /// by restoring that sparse snapshot onto the live workbook.
    ///
    /// W2.3 (audit B-1) verdict: because of this additive contract,
    /// `restore_sparse` deliberately STAYS on the legacy per-cell
    /// `WorkbookLoader` path — the storage-primary
    /// `install_workbook_bulk` is a full-sheet REPLACE and would
    /// silently destroy unrelated live content. Routing it would need
    /// the additive install variant Phase 6.4 deferred. The fresh-shell
    /// restore (`restore_persistence_v1`) IS routed storage-primary.
    pub fn restore_sparse(&mut self, cells: JsValue) -> Result<u32, JsValue> {
        // Routes through `Workbook::bulk_load`, which Phase 2/3 made
        // lazy — see `CAP_REMOVAL_2026-06-11.md`. No per-call payload
        // cap is needed.
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

    /// Persist a sparse row-height fact on a workbook sheet. Empty rows are not
    /// materialized; this only updates sheet metadata.
    pub fn set_row_height(&mut self, sheet_idx: u32, row_index: u32, height_px: u32) -> bool {
        let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) else {
            return false;
        };
        if height_px == 0 {
            sheet.clear_row_height(row_index);
        } else {
            sheet.set_row_height(row_index, height_px);
        }
        true
    }

    /// Persist a sparse column-width fact on a workbook sheet. Empty columns are
    /// not materialized; this only updates sheet metadata.
    pub fn set_col_width(&mut self, sheet_idx: u32, col_index: u32, width_px: u32) -> bool {
        let Some(sheet) = self.workbook.sheet_mut(sheet_idx as usize) else {
            return false;
        };
        if width_px == 0 {
            sheet.clear_col_width(col_index);
        } else {
            sheet.set_col_width(col_index, width_px);
        }
        true
    }

    /// Snapshot row/column size metadata for the requested visible window.
    pub fn snapshot_viewport_sizes(
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
        serde_wasm_bindgen::to_value(&ViewportSizeSnapshotJSON::from_sheet_range(
            sheet,
            range,
            Some(sheet_idx),
        ))
        .map_err(|err| JsValue::from_str(&format!("serialize viewport size snapshot: {err}")))
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

    /// Physically sort a range (design-engine-sort S2). Payload:
    /// `{ range, keys: [{ col, direction, caseSensitive }], excludedRows }`
    /// where `range` is an A1 string or a zero-based bounds object. Returns
    /// the `SortRangeReport` witness on success and a structured
    /// `{ ok: false, code, anchor?, message? }` object for every rejection —
    /// engine gates (`invalid-range`, `empty-keys`, `key-out-of-range`,
    /// `spill-in-range`) and payload-parse failures (`invalid-payload`).
    /// The `Err` arm is reserved for a catastrophic report serialization.
    #[wasm_bindgen(js_name = "sortRange")]
    pub fn sort_range(&mut self, sheet_idx: u32, payload: JsValue) -> Result<JsValue, JsValue> {
        let payload: SortRangePayloadJSON = match serde_wasm_bindgen::from_value(payload) {
            Ok(payload) => payload,
            Err(err) => {
                return Ok(sort_error_to_js("invalid-payload", None, Some(&err.to_string())))
            }
        };
        let range = match payload.range.into_range() {
            Ok(range) => range,
            Err(msg) => return Ok(sort_error_to_js("invalid-payload", None, Some(&msg))),
        };
        let keys: Vec<SortKey> = payload
            .keys
            .into_iter()
            .map(SortKeyWireJSON::into_key)
            .collect();
        match self
            .workbook
            .sort_range(sheet_idx as usize, range, &keys, &payload.excluded_rows)
        {
            Ok(report) => serde_wasm_bindgen::to_value(&SortRangeReportJSON::from_report(&report))
                .map_err(|err| JsValue::from_str(&format!("serialize sort report: {err}"))),
            Err(err) => Ok(sort_range_error_to_js(err)),
        }
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

    /// Resolve a sheet name to its 0-based index for the Table DTO. Used only
    /// by `listTables` / `getTable`, where the Table anchors by sheet name.
    fn sheet_index_by_name(&self, name: &str) -> Option<u32> {
        (0..self.workbook.sheet_count())
            .find(|&idx| self.workbook.name(idx) == Some(name))
            .map(|idx| idx as u32)
    }

    /// Every registered Table as a wire DTO. Shared by `listTables`,
    /// `snapshotTables`, and the persistence-v1 envelope.
    fn tables_json(&self) -> Vec<TableJSON> {
        self.workbook
            .list_tables()
            .into_iter()
            .map(|entry| {
                let idx = self.sheet_index_by_name(entry.sheet_name()).unwrap_or(0);
                TableJSON::from_entry(entry, idx)
            })
            .collect()
    }

    /// Parse a wire snapshot into the engine type. Separated from
    /// `restore_tables_json` so the persistence path can validate the payload
    /// BEFORE it swaps in a fresh workbook.
    fn table_snapshot_from_json(
        tables: Vec<TableJSON>,
    ) -> Result<TableRegistrySnapshot, String> {
        let entries = tables
            .into_iter()
            .map(TableJSON::into_entry)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(TableRegistrySnapshot::from_entries(entries))
    }

    fn restore_tables_json(
        &mut self,
        payload: TableRegistrySnapshotJSON,
    ) -> Result<u32, String> {
        if payload.version != 1 {
            return Err("unsupported-snapshot-version".into());
        }
        let snapshot = Self::table_snapshot_from_json(payload.tables)?;
        self.workbook
            .restore_tables(snapshot)
            .map(|count| count as u32)
            .map_err(|err| table_error_id(err).to_string())
    }

    fn snapshot_persistence_v1_json(&self) -> WorkbookPersistenceV1JSON {
        let mut sheets = Vec::with_capacity(self.workbook.sheet_count());
        let mut formats = Vec::with_capacity(self.workbook.sheet_count());
        let mut sizes = Vec::new();

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

            let size_snapshot = ViewportSizeSnapshotJSON::from_full_sheet(sheet, sheet_idx as u32);
            if !size_snapshot.is_empty() {
                sizes.push(size_snapshot);
            }
        }

        WorkbookPersistenceV1JSON {
            version: 1,
            sheets,
            cells: self.snapshot_sparse_cells(),
            formats,
            sizes,
            tables: self.tables_json(),
            hidden: self.hidden_rows_json(),
            filters: self.filters_json(),
        }
    }

    /// The engine-owned manual hidden sets as wire elements, shared by
    /// `snapshotHidden` and the persistence-v1 envelope.
    fn hidden_rows_json(&self) -> Vec<SheetHiddenRowsJSON> {
        self.workbook
            .snapshot_hidden()
            .sheets()
            .iter()
            .map(SheetHiddenRowsJSON::from_entry)
            .collect()
    }

    /// The engine-owned filter state as wire elements, shared by
    /// `snapshotFilters` and the persistence-v1 envelope.
    fn filters_json(&self) -> Vec<SheetFilterStateJSON> {
        self.workbook
            .snapshot_filters()
            .sheets()
            .iter()
            .map(SheetFilterStateJSON::from_entry)
            .collect()
    }

    fn filter_snapshot_from_json(filters: Vec<SheetFilterStateJSON>) -> FilterSnapshot {
        FilterSnapshot::from_sheets(
            filters
                .into_iter()
                .map(SheetFilterStateJSON::into_entry)
                .collect(),
        )
    }

    fn restore_filters_json(&mut self, payload: FilterSnapshotJSON) -> Result<u32, String> {
        if payload.version != 1 {
            return Err("unsupported-snapshot-version".into());
        }
        self.workbook
            .restore_filters(Self::filter_snapshot_from_json(payload.filters))
            .map_err(|_| "mutation-during-custom-call".to_string())
    }

    fn filter_result_to_js(
        result: Result<FilterApplyReport, FilterError>,
    ) -> Result<JsValue, JsValue> {
        match result {
            Ok(report) => serde_wasm_bindgen::to_value(&FilterApplyReportJSON {
                ok: true,
                hidden_rows: report.hidden_rows,
                scanned_rows: report.scanned_rows,
                predicate_cells: report.predicate_cells,
            })
            .map_err(|err| JsValue::from_str(&format!("serialize filter report: {err}"))),
            Err(err) => Ok(filter_error_to_js(err)),
        }
    }

    fn hidden_snapshot_from_json(hidden: Vec<SheetHiddenRowsJSON>) -> HiddenRowsSnapshot {
        HiddenRowsSnapshot::from_sheets(
            hidden
                .into_iter()
                .map(SheetHiddenRowsJSON::into_entry)
                .collect(),
        )
    }

    fn restore_hidden_json(&mut self, payload: HiddenRowsSnapshotJSON) -> Result<u32, String> {
        if payload.version != 1 {
            return Err("unsupported-snapshot-version".into());
        }
        self.workbook
            .restore_hidden(Self::hidden_snapshot_from_json(payload.hidden))
            .map_err(|_| "mutation-during-custom-call".to_string())
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

        // No per-call payload cap. The cells route through the
        // storage-primary `install_workbook_bulk` (audit B-1 / W2.3):
        // per-sheet primitive/formula maps swap straight into the fresh
        // shell, formulas park as source text and hydrate lazily on
        // first read. See `STORAGE_PRIMARY_PLAN.md`.

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

        let mut size_snapshots = Vec::with_capacity(payload.sizes.len());
        for snapshot in payload.sizes {
            let sheet_idx = snapshot
                .sheet
                .ok_or_else(|| "size snapshot is missing sheet index".to_string())?
                as usize;
            if sheet_idx >= sheet_count {
                return Err(format!(
                    "size snapshot references missing sheet: {sheet_idx}"
                ));
            }
            let (row_heights, col_widths) = snapshot.into_size_facts()?;
            size_snapshots.push((sheet_idx, row_heights, col_widths));
        }

        // Parse the Table registry BEFORE the workbook is swapped, so a
        // malformed range string joins the other reject-without-mutating
        // failures rather than stranding a half-restored workbook.
        let table_snapshot = Self::table_snapshot_from_json(payload.tables)?;
        let hidden_snapshot = Self::hidden_snapshot_from_json(payload.hidden);
        let filter_snapshot = Self::filter_snapshot_from_json(payload.filters);

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

        // W2.3 (audit B-1): fresh-shell restore is exactly the
        // full-sheet-replace shape `install_workbook_bulk` implements —
        // group the records into per-sheet primitive/formula maps and
        // install in ONE engine call. No per-cell loader ceremony, no
        // eager parse (the `!`-prefilter inside the install covers
        // cross-sheet edges), formulas hydrate lazily on first read.
        // Measured (bench_restore_persistence_v1_50k_plus_50k, native
        // release, 50k primitives + 50k formulas): legacy loader
        // 67.5 ms → 29.4 ms storage-primary (0.67 → 0.29 µs/cell); the
        // 6.x bench history puts the wasm32 multiplier higher still.
        let (install_payload, restored_cells) =
            sparse_cells_to_install_payload(payload.cells, sheet_count);
        if !install_payload.is_empty() {
            self.workbook
                .install_workbook_bulk(install_payload)
                .map_err(|err| format!("persistence restore install failed: {err}"))?;
        }
        let mut restored_formats = 0u32;
        for (sheet_idx, snapshot) in format_snapshots {
            let sheet = self
                .workbook
                .sheet_mut(sheet_idx)
                .ok_or_else(|| format!("invalid sheet index: {sheet_idx}"))?;
            restored_formats += sheet.restore_format_range_snapshot(snapshot) as u32;
        }
        for (sheet_idx, row_heights, col_widths) in size_snapshots {
            let sheet = self
                .workbook
                .sheet_mut(sheet_idx)
                .ok_or_else(|| format!("invalid sheet index: {sheet_idx}"))?;
            for (row_index, height_px) in row_heights {
                sheet.set_row_height(row_index, height_px);
            }
            for (col_index, width_px) in col_widths {
                sheet.set_col_width(col_index, width_px);
            }
        }

        // Registry last: entries anchor by sheet NAME, so every sheet must
        // already exist and be named. REPLACE semantics make this exact —
        // the fresh workbook starts empty, so restore installs precisely the
        // captured set.
        let restored_tables = self
            .workbook
            .restore_tables(table_snapshot)
            .map_err(|err| format!("persistence restore tables failed: {}", table_error_id(err)))?
            as u32;

        // Hidden rows last as well, and for the same reason as the registry:
        // every sheet must exist first. REPLACE semantics are exact against
        // the fresh workbook, and entries for sheets the payload does not
        // contain are dropped by `restore_hidden` rather than failing here.
        let restored_hidden_sheets = self
            .workbook
            .restore_hidden(hidden_snapshot)
            .map_err(|_| "persistence restore hidden rows failed".to_string())?;

        // Filters last, for the same reason as the registry and the hidden
        // sets: every sheet must exist first. REPLACE is exact against the
        // fresh workbook, and it installs the REMEMBERED visibility rather
        // than re-running the predicate — a restore must not evaluate.
        let restored_filter_sheets = self
            .workbook
            .restore_filters(filter_snapshot)
            .map_err(|_| "persistence restore filters failed".to_string())?;

        let stats = WorkbookPersistenceRestoreStatsJSON {
            restored_cells,
            restored_formats,
            sheets: payload.sheets.len() as u32,
            restored_tables,
            restored_hidden_sheets,
            restored_filter_sheets,
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
                // Typed loader entries (A-9 follow-up): the record already
                // holds row/col, so no `to_string_repr` → re-parse round
                // trip per cell.
                let addr = CellAddress::new(cell.row, cell.col);
                match cell.kind.as_str() {
                    "number" => {
                        if let Some(ImportValueJSON::Number(n)) = cell.value {
                            if n.is_finite() {
                                loader.set_cell_at(cell.sheet, addr, Value::Number(n));
                                restored += 1;
                            }
                        }
                    }
                    "text" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            loader.set_cell_at(cell.sheet, addr, Value::Text(s));
                            restored += 1;
                        }
                    }
                    "boolean" => {
                        if let Some(ImportValueJSON::Boolean(b)) = cell.value {
                            loader.set_cell_at(cell.sheet, addr, Value::Boolean(b));
                            restored += 1;
                        }
                    }
                    "error" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            loader.set_cell_at(
                                cell.sheet,
                                addr,
                                Value::Error(value_error_from_display(&s)),
                            );
                            restored += 1;
                        }
                    }
                    "formula" => {
                        if let Some(ImportValueJSON::Text(s)) = cell.value {
                            if loader.set_formula_at(cell.sheet, addr, &s) {
                                restored += 1;
                            }
                        }
                    }
                    "null" => {
                        loader.clear_cell_at(cell.sheet, addr);
                        restored += 1;
                    }
                    _ => {}
                }
            }
        });
        restored
    }
}

/// Group sparse cell records into the per-sheet primitive/formula maps
/// `Workbook::install_workbook_bulk` consumes (audit B-1 / W2.3). The
/// twin of the JS-side 6.3 conversion in `worker-runtime.ts`
/// (`buildBulkInstallPayload`) and the `bulk_install_workbook` wire
/// deserializer, for callers that already hold typed `SparseCellJSON`
/// records.
///
/// Returns `(payload, restored)` where `restored` counts records that
/// passed validation — matching the legacy loader's per-record count.
/// Semantics notes (fresh-shell callers only):
/// - records for out-of-range sheets are skipped, like the legacy path;
/// - LAST record wins per address (a later record overwrites an earlier
///   one across both maps, mirroring loader write order);
/// - `"null"` records clear the address from both maps. On the fresh
///   shell this is a no-op unless an earlier record wrote the address;
/// - a malformed formula parks as source text and surfaces `#VALUE!` on
///   first read (the legacy loader wrote `#VALUE!` eagerly — same
///   observable value, deferred).
#[allow(clippy::type_complexity)]
fn sparse_cells_to_install_payload(
    cells: Vec<SparseCellJSON>,
    sheet_count: usize,
) -> (
    Vec<(
        usize,
        HashMap<CellAddress, Value>,
        HashMap<CellAddress, String>,
    )>,
    u32,
) {
    let mut per_sheet: Vec<(HashMap<CellAddress, Value>, HashMap<CellAddress, String>)> =
        (0..sheet_count).map(|_| Default::default()).collect();
    let mut touched: Vec<bool> = vec![false; sheet_count];
    let mut restored = 0u32;

    for cell in cells {
        if cell.sheet >= sheet_count {
            continue;
        }
        let addr = CellAddress::new(cell.row, cell.col);
        let (primitives, formulas) = &mut per_sheet[cell.sheet];
        let value = match cell.kind.as_str() {
            "number" => match cell.value {
                Some(ImportValueJSON::Number(n)) if n.is_finite() => Value::Number(n),
                _ => continue,
            },
            "text" => match cell.value {
                Some(ImportValueJSON::Text(s)) => Value::Text(s),
                _ => continue,
            },
            "boolean" => match cell.value {
                Some(ImportValueJSON::Boolean(b)) => Value::Boolean(b),
                _ => continue,
            },
            "error" => match cell.value {
                Some(ImportValueJSON::Text(s)) => Value::Error(value_error_from_display(&s)),
                _ => continue,
            },
            "formula" => match cell.value {
                Some(ImportValueJSON::Text(s)) => {
                    primitives.remove(&addr);
                    formulas.insert(addr, s);
                    touched[cell.sheet] = true;
                    restored += 1;
                    continue;
                }
                _ => continue,
            },
            "null" => {
                primitives.remove(&addr);
                formulas.remove(&addr);
                restored += 1;
                continue;
            }
            _ => continue,
        };
        formulas.remove(&addr);
        primitives.insert(addr, value);
        touched[cell.sheet] = true;
        restored += 1;
    }

    let payload = per_sheet
        .into_iter()
        .enumerate()
        .filter(|(sheet_idx, _)| touched[*sheet_idx])
        .map(|(sheet_idx, (primitives, formulas))| (sheet_idx, primitives, formulas))
        .collect();
    (payload, restored)
}

/// Convert a `Result<(), SheetError>` from a workbook try-set into the
/// `{ ok, code?, anchor? }` JS object shape used by the WASM-facing
/// `trySetCell*` exports.
fn try_set_cell_result(result: Result<(), SheetError>) -> Result<JsValue, JsValue> {
    match result {
        Ok(()) => {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &JsValue::from_str("ok"), &JsValue::TRUE).ok();
            Ok(obj.into())
        }
        Err(err) => Ok(sheet_error_to_js(err)),
    }
}

/// Serialize a `SheetError` to the JS-facing `{ ok: false, code, anchor? }`
/// object so callers can match on `code` rather than parsing a message
/// string. The `anchor` field is only present for `SpillCellWrite`.
fn sheet_error_to_js(err: SheetError) -> JsValue {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from_str("ok"), &JsValue::FALSE).ok();
    match err {
        SheetError::SpillCellWrite { anchor } => {
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("code"),
                &JsValue::from_str("spill-write"),
            )
            .ok();
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("anchor"),
                &JsValue::from_str(&anchor.to_string()),
            )
            .ok();
        }
        SheetError::InvalidAddress => {
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("code"),
                &JsValue::from_str("invalid-address"),
            )
            .ok();
        }
        SheetError::MutationDuringCustomCall => {
            // Wave 8 codex-review fix #1. Host code attempted to write
            // through the workbook from inside a custom-formula JS
            // callback. See `CUSTOM_FORMULAS.md` § "No mutations during
            // callback" for the contract.
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("code"),
                &JsValue::from_str("mutation-during-custom-call"),
            )
            .ok();
        }
    }
    obj.into()
}

/// Map a `WorkbookError` to a JS-side string code the caller can match
/// on. Plain strings (not the structured object that `sheet_error_to_js`
/// returns) because `defineName` / `undefineName` are infallible-by-
/// design from the host's perspective: the error space is small,
/// deterministic, and reported synchronously, so a tag is enough.
///
/// The eval-failed variant includes the wrapped `ValueError`'s display
/// form (`"eval-failed: #DIV/0!"`) so the host can show the cell-style
/// code without re-decoding a numeric enum.
fn workbook_error_to_js(err: WorkbookError) -> JsValue {
    let msg = match err {
        WorkbookError::ReservedName => "reserved-name".to_string(),
        WorkbookError::InvalidName => "invalid-name".to_string(),
        WorkbookError::ParseFailed => "parse-failed".to_string(),
        WorkbookError::EvalFailed(e) => format!("eval-failed: {}", e),
        WorkbookError::MutationDuringCustomCall => "mutation-during-custom-call".to_string(),
        // #32 Excel Table T1: defined-name/Table shared-namespace conflict.
        // Non-export compile-fix for the new `WorkbookError` variant — this
        // internal error-formatting helper is not part of the wasm export
        // surface, so no snapshot regeneration is needed.
        WorkbookError::NameConflict => "name-conflict".to_string(),
    };
    JsValue::from_str(&msg)
}

/// Build the `{ ok: false, code, anchor?, message? }` rejection object for
/// `sortRange`. Mirrors `sheet_error_to_js` so the JS side matches on `code`
/// rather than parsing a message string.
fn sort_error_to_js(code: &str, anchor: Option<&str>, message: Option<&str>) -> JsValue {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from_str("ok"), &JsValue::FALSE).ok();
    js_sys::Reflect::set(&obj, &JsValue::from_str("code"), &JsValue::from_str(code)).ok();
    if let Some(anchor) = anchor {
        js_sys::Reflect::set(&obj, &JsValue::from_str("anchor"), &JsValue::from_str(anchor)).ok();
    }
    if let Some(message) = message {
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("message"),
            &JsValue::from_str(message),
        )
        .ok();
    }
    obj.into()
}

/// Map a `SortRangeError` to the structured `sortRange` rejection object.
/// Codes are kebab-case, matching the `sheet_error_to_js` family; the
/// spill rejection carries its anchor address.
fn sort_range_error_to_js(err: SortRangeError) -> JsValue {
    match err {
        SortRangeError::InvalidRange => sort_error_to_js("invalid-range", None, None),
        SortRangeError::EmptyKeys => sort_error_to_js("empty-keys", None, None),
        SortRangeError::KeyOutOfRange => sort_error_to_js("key-out-of-range", None, None),
        SortRangeError::SpillIntersectsRange { anchor } => {
            sort_error_to_js("spill-in-range", Some(&anchor.to_string()), None)
        }
    }
}

/// Collapse a spill-anchor `Value::Array` to its top-left scalar before
/// crossing into JS. The JS layer never observes the `Array` variant —
/// spilled cells already return scalars through their derived atoms, and
/// the anchor cell renders the [0][0] element exactly like Excel does
/// when copying an array-formula anchor. This is the Phase 1 boundary
/// contract: see `rust/excel-core/src/sheet.rs` § "Spill infrastructure".
fn collapse_array_for_js(val: &Value) -> std::borrow::Cow<'_, Value> {
    match val {
        Value::Array(arr) => std::borrow::Cow::Owned(arr.get(0, 0).cloned().unwrap_or(Value::Null)),
        _ => std::borrow::Cow::Borrowed(val),
    }
}

/// Delegates to `einfach_excel_core::value_to_display`.
///
/// The body used to live here. E3 moved it into the engine and left this
/// one-liner behind on purpose: `Workbook::apply_filter` has to compare its
/// predicate against the SAME string this boundary emits, because that
/// string is what the host's TypeScript predicate
/// (`solid/excel/src-vnext/adapter/filter-predicate.ts`) reads today over
/// `readSparseRange`. Two separately-maintained formatters would have been
/// a silent drift channel between the two engines; delegation makes them
/// the same function, not merely the same intent.
fn value_to_display(val: &Value) -> String {
    einfach_excel_core::value_to_display(val)
}

fn value_to_cell_type(val: &Value) -> String {
    let val = collapse_array_for_js(val);
    match &*val {
        Value::Number(_) => "number",
        Value::Text(_) => "text",
        Value::Boolean(_) => "boolean",
        Value::Null => "null",
        Value::Error(_) => "error",
        // Unreachable: collapsed above.
        Value::Array(_) => "null",
        // Lambda is not a persistable cell type — surface as "null".
        Value::Lambda(_) => "null",
    }
    .into()
}

fn sparse_cell_from_value(sheet: usize, addr: CellAddress, val: &Value) -> Option<SparseCellJSON> {
    let val = collapse_array_for_js(val);
    let (kind, value) = match &*val {
        Value::Number(n) => ("number", Some(ImportValueJSON::Number(*n))),
        Value::Text(s) => ("text", Some(ImportValueJSON::Text(s.clone()))),
        Value::Boolean(b) => ("boolean", Some(ImportValueJSON::Boolean(*b))),
        Value::Error(e) => ("error", Some(ImportValueJSON::Text(format!("{}", e)))),
        Value::Null => return None,
        // Unreachable: collapsed above.
        Value::Array(_) => return None,
        // Lambdas don't make it into the sparse-cell export.
        Value::Lambda(_) => return None,
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
    error_token_to_value_error(value).unwrap_or(ValueError::InvalidValue)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

    #[test]
    fn async_registry_entry_is_flagged_and_never_sync_dispatched() {
        let registry = WasmCustomFormulaRegistry::new();
        registry.register_async("slow");
        // Case-insensitive flag, name-only entry.
        assert!(registry.is_async("SLOW"));
        assert!(registry.is_async("slow"));
        assert!(!registry.is_async("OTHER"));
        assert_eq!(registry.count(), 1);
        // Defensive: a bypassed sync dispatch of an async name fails
        // loudly as #NAME? instead of silently invoking nothing.
        assert_eq!(
            registry.lookup("SLOW", &[]),
            Some(Value::Error(ValueError::InvalidName))
        );
        // Unregister clears the flag.
        assert!(registry.unregister("SLOW"));
        assert!(!registry.is_async("SLOW"));
    }

    #[test]
    fn busy_token_roundtrip_and_custom_return_demotion() {
        // Import / set_error paths accept the token so pending cells round-trip…
        assert_eq!(error_token_to_value_error("#BUSY!"), Some(ValueError::Busy));
        assert_eq!(value_error_from_display("#BUSY!"), ValueError::Busy);
        // …but a custom-formula callback returning it demotes to #VALUE!
        // (returning #BUSY! would leave the cell permanently pending).
        assert_eq!(
            demote_busy_for_custom_return(ValueError::Busy),
            ValueError::InvalidValue
        );
        assert_eq!(
            demote_busy_for_custom_return(ValueError::Spill),
            ValueError::Spill
        );
    }

    // === Excel Table registry wire (#32 T3) ===
    //
    // The `#[wasm_bindgen]`-exported CRUD methods touch `JsValue` in their
    // signatures, so they can only be exercised through a JS runtime — the
    // full create → formula → rename → delete round-trip lives in the WASM
    // e2e (T8) and the engine round-trip in `excel-core/tests/table_shift.rs`.
    // What is unit-testable natively is the wire mapping this crate owns:
    // `TableJSON::from_entry` (range → A1 string, columns, flags, sheet
    // index passthrough).

    #[test]
    fn table_json_from_entry_maps_fields() {
        let mut wb = Workbook::new();
        wb.add_sheet("Data");
        let sd = wb.index_of("Data").unwrap();
        wb.set_cell(sd, "A1", Value::Text("Region".into()));
        wb.set_cell(sd, "B1", Value::Text("Sales".into()));
        wb.define_table(
            Some("Revenue"),
            sd,
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(2, 1)),
            true,
        )
        .expect("define table");

        // Case-insensitive lookup returns the canonical-cased entry.
        let entry = wb.get_table("revenue").expect("entry");
        let json = TableJSON::from_entry(entry, sd as u32);
        assert_eq!(json.name, "Revenue");
        assert_eq!(json.sheet, "Data");
        assert_eq!(json.sheet_index, sd as u32);
        assert_eq!(json.range, "A1:B3", "range emitted as an A1 span");
        assert!(json.has_headers);
        assert!(!json.has_totals);
        assert_eq!(
            json.columns,
            vec!["Region".to_string(), "Sales".to_string()],
            "column display names read from the header row"
        );
    }

    // === Table registry snapshot / restore wire (#32 §11/§12) ===

    /// Build a `WasmWorkbook` holding one Table `Inventory` at A1:C4 on
    /// Sheet1 (headers Name/Qty/Price + 3 data rows).
    fn workbook_with_inventory_table() -> WasmWorkbook {
        let mut wb = WasmWorkbook::new();
        for (a1, v) in [("A1", "Name"), ("B1", "Qty"), ("C1", "Price")] {
            wb.workbook.set_cell(0, a1, Value::Text(v.into()));
        }
        for (i, qty) in [1.0f64, 2.0, 3.0].iter().enumerate() {
            let r = i + 2;
            wb.workbook
                .set_cell(0, &format!("B{r}"), Value::Number(*qty));
        }
        wb.workbook
            .define_table(
                Some("Inventory"),
                0,
                CellRange::new(CellAddress::new(0, 0), CellAddress::new(3, 2)),
                true,
            )
            .expect("define table");
        wb
    }

    fn snapshot_tables_json(wb: &WasmWorkbook) -> TableRegistrySnapshotJSON {
        TableRegistrySnapshotJSON {
            version: 1,
            tables: wb.tables_json(),
        }
    }

    #[test]
    fn wasm_table_snapshot_restore_round_trips_the_registry() {
        let mut wb = workbook_with_inventory_table();
        let before = snapshot_tables_json(&wb);
        assert_eq!(before.version, 1);
        assert_eq!(before.tables.len(), 1);

        wb.workbook.delete_table("Inventory").expect("delete");
        wb.workbook
            .define_table(
                Some("Other"),
                0,
                CellRange::new(CellAddress::new(10, 0), CellAddress::new(11, 0)),
                true,
            )
            .expect("other");

        assert_eq!(wb.restore_tables_json(before), Ok(1));
        let entry = wb.workbook.get_table("Inventory").expect("revived");
        assert_eq!(entry.range().end.row, 3);
        assert_eq!(entry.columns(), ["Name", "Qty", "Price"]);
        assert!(
            wb.workbook.get_table("Other").is_none(),
            "REPLACE drops post-snapshot tables"
        );
    }

    #[test]
    fn wasm_table_restore_preserves_totals_flag_and_grown_range() {
        let mut wb = workbook_with_inventory_table();
        wb.workbook
            .set_table_totals_row("Inventory", true)
            .expect("totals on");
        let with_totals = snapshot_tables_json(&wb);
        assert!(with_totals.tables[0].has_totals);
        assert_eq!(with_totals.tables[0].range, "A1:C5");

        wb.workbook
            .set_table_totals_row("Inventory", false)
            .expect("totals off");
        assert!(!wb.workbook.get_table("Inventory").unwrap().has_totals());

        assert_eq!(wb.restore_tables_json(with_totals), Ok(1));
        let entry = wb.workbook.get_table("Inventory").expect("entry");
        assert!(entry.has_totals(), "flag restored");
        assert_eq!(entry.range().end.row, 4, "grown range restored");
    }

    // === Engine-owned MANUAL hidden rows (E2 of
    // `design-engine-hidden-rows.md`) ===

    /// A1:A5 = 1..5 with `C1 = SUBTOTAL(109, A1:A5)` on sheet 0, plus a
    /// second sheet so the per-sheet keying is exercised.
    fn workbook_with_hidden_rows() -> WasmWorkbook {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Second");
        for i in 0..5u32 {
            wb.set_number(0, &format!("A{}", i + 1), (i + 1) as f64);
        }
        assert!(wb.set_formula(0, "C1", "=SUBTOTAL(109, A1:A5)"));
        wb
    }

    /// **Counterexample.** Hidden rows must survive a persistence round trip.
    ///
    /// Until the engine owned the set there was nothing on this side of the
    /// boundary to serialize: `snapshot_persistence_v1` had no hidden field
    /// and `restore_persistence_v1` builds a FRESH `Workbook`, so every
    /// save/load silently un-hid every row. This fails on the unfixed engine
    /// with a WRONG SUBTOTAL — 15 instead of 9 — not with an error.
    #[test]
    fn wasm_persistence_v1_round_trips_manually_hidden_rows() {
        let mut source = workbook_with_hidden_rows();
        assert!(source.hide_rows(0, vec![1, 3])); // A2 = 2, A4 = 4
        assert!(source.hide_rows(1, vec![7]));
        assert_eq!(source.get_number(0, "C1"), 9.0); // 15 - 2 - 4

        let envelope = source.snapshot_persistence_v1_json();
        assert_eq!(envelope.hidden.len(), 2, "both sheets carried");

        let mut restored = WasmWorkbook::new();
        let stats = restored
            .restore_persistence_v1_json(envelope)
            .expect("restore");
        assert_eq!(stats.restored_hidden_sheets, 2);
        assert_eq!(restored.list_hidden_rows(0), vec![1, 3]);
        assert_eq!(restored.list_hidden_rows(1), vec![7]);
        assert_eq!(
            restored.get_number(0, "C1"),
            9.0,
            "SUBTOTAL 101-111 must still exclude the restored hidden rows"
        );
    }

    /// A workbook with nothing hidden serializes byte-identically to a
    /// pre-E2 payload — the `skip_serializing_if` half of the backward
    /// compatibility argument — and a payload with no `hidden` key restores
    /// as "nothing hidden" rather than failing.
    #[test]
    fn wasm_persistence_v1_hidden_field_is_backward_compatible_both_ways() {
        let source = workbook_with_hidden_rows();
        let envelope = source.snapshot_persistence_v1_json();
        assert!(envelope.hidden.is_empty());
        let json = serde_json::to_string(&envelope).expect("serialize");
        assert!(
            !json.contains("\"hidden\""),
            "an unhidden workbook must not emit the key: {json}"
        );

        // A payload that predates the field (no `hidden` key at all).
        let legacy: WorkbookPersistenceV1JSON =
            serde_json::from_str(&json).expect("deserialize legacy");
        let mut restored = WasmWorkbook::new();
        let stats = restored
            .restore_persistence_v1_json(legacy)
            .expect("restore");
        assert_eq!(stats.restored_hidden_sheets, 0);
        assert!(restored.list_hidden_rows(0).is_empty());
    }

    /// The `snapshotHidden` / `restoreHidden` undo envelope round-trips, and
    /// an empty one CLEARS rather than no-ops (REPLACE semantics).
    #[test]
    fn wasm_hidden_snapshot_restore_round_trip() {
        let mut wb = workbook_with_hidden_rows();
        assert!(wb.hide_rows(0, vec![1]));
        assert_eq!(wb.get_number(0, "C1"), 13.0);

        let before = HiddenRowsSnapshotJSON {
            version: 1,
            hidden: wb.hidden_rows_json(),
        };

        assert!(wb.hide_rows(0, vec![3]));
        assert_eq!(wb.get_number(0, "C1"), 9.0);

        assert_eq!(wb.restore_hidden_json(before), Ok(1));
        assert_eq!(wb.list_hidden_rows(0), vec![1]);
        assert_eq!(wb.get_number(0, "C1"), 13.0);

        let empty = HiddenRowsSnapshotJSON {
            version: 1,
            hidden: vec![],
        };
        assert_eq!(wb.restore_hidden_json(empty), Ok(0));
        assert!(wb.list_hidden_rows(0).is_empty());
        assert_eq!(wb.get_number(0, "C1"), 15.0);
    }

    /// A future envelope version is rejected loudly, mirroring
    /// `restoreTables`.
    #[test]
    fn wasm_hidden_restore_rejects_unsupported_version_without_mutating() {
        let mut wb = workbook_with_hidden_rows();
        assert!(wb.hide_rows(0, vec![1]));
        let bad = HiddenRowsSnapshotJSON {
            version: 2,
            hidden: vec![],
        };
        assert_eq!(
            wb.restore_hidden_json(bad),
            Err("unsupported-snapshot-version".into())
        );
        assert_eq!(wb.list_hidden_rows(0), vec![1], "rejected without mutating");
    }

    /// The wasm hide/unhide/list surface reports change and degrades quietly
    /// on an out-of-range sheet.
    #[test]
    fn wasm_hide_unhide_list_surface() {
        let mut wb = workbook_with_hidden_rows();
        assert!(wb.hide_rows(0, vec![3, 1]));
        assert_eq!(wb.list_hidden_rows(0), vec![1, 3]);
        assert!(!wb.hide_rows(0, vec![1]), "already hidden");
        assert!(wb.unhide_rows(0, vec![1]));
        assert_eq!(wb.list_hidden_rows(0), vec![3]);
        assert!(!wb.unhide_rows(0, vec![1]), "not hidden");

        assert!(!wb.hide_rows(99, vec![0]));
        assert!(!wb.unhide_rows(99, vec![0]));
        assert!(wb.list_hidden_rows(99).is_empty());
    }

    // === Engine-owned FILTER (E3 of `design-engine-hidden-rows.md`) ===

    /// A1:A5 = 1..5 (row 0 is the filter layout's header) with
    /// `C1 = SUBTOTAL(9, A1:A5)` — the 1-11 layer, which reads the FILTER
    /// set — plus a second sheet so per-sheet keying is exercised.
    fn workbook_with_filter() -> WasmWorkbook {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Second");
        for i in 0..5u32 {
            wb.set_number(0, &format!("A{}", i + 1), (i + 1) as f64);
        }
        assert!(wb.set_formula(0, "C1", "=SUBTOTAL(9, A1:A5)"));
        wb
    }

    fn keep_list(values: &[&str]) -> ColumnFilterRule {
        ColumnFilterRule::List {
            col_index: 0,
            values: values.iter().map(|v| (*v).to_string()).collect(),
        }
    }

    /// **Counterexample.** Filter state must survive a persistence round
    /// trip.
    ///
    /// `restore_persistence_v1` builds a FRESH `Workbook`, so before the
    /// engine owned the filter there was nothing on this side of the
    /// boundary to serialize and every save/load silently un-filtered every
    /// row. Fails on the unfixed engine with a WRONG SUBTOTAL — 15 instead
    /// of 9 — not with an error.
    #[test]
    fn wasm_persistence_v1_round_trips_filter_state() {
        let mut source = workbook_with_filter();
        source
            .workbook
            .apply_filter(0, &[keep_list(&["3", "5"])])
            .expect("apply");
        assert_eq!(source.workbook.filter_hidden_rows(0), vec![1, 3]); // A2 = 2, A4 = 4
        assert_eq!(source.get_number(0, "C1"), 9.0); // 15 - 2 - 4

        let envelope = source.snapshot_persistence_v1_json();
        let filter_entries = envelope.filters.len();
        let mut restored = WasmWorkbook::new();
        let stats = restored
            .restore_persistence_v1_json(envelope)
            .expect("restore");
        // Product consequence first: the number a user reads.
        assert_eq!(
            restored.get_number(0, "C1"),
            9.0,
            "SUBTOTAL 1-11 must still exclude the restored filter-hidden rows"
        );
        assert_eq!(restored.workbook.filter_hidden_rows(0), vec![1, 3]);
        assert_eq!(
            restored.workbook.filter_rules(0),
            vec![keep_list(&["3", "5"])],
            "the rules come back too, so Reapply still has something to reapply"
        );
        assert_eq!(stats.restored_filter_sheets, 1);
        assert_eq!(
            restored.workbook.debug_filter_scan_count(0),
            0,
            "a restore installs the remembered answer; it must not re-run the predicate"
        );
        assert_eq!(filter_entries, 1, "one sheet carried a filter");
    }

    /// An unfiltered workbook serializes byte-identically to a pre-E3
    /// payload, and a payload with no `filters` key restores as "no filter"
    /// rather than failing.
    #[test]
    fn wasm_persistence_v1_filters_field_is_backward_compatible_both_ways() {
        let source = workbook_with_filter();
        let envelope = source.snapshot_persistence_v1_json();
        assert!(envelope.filters.is_empty());
        let json = serde_json::to_string(&envelope).expect("serialize");
        assert!(
            !json.contains("\"filters\""),
            "an unfiltered workbook must not emit the key: {json}"
        );

        let legacy: WorkbookPersistenceV1JSON =
            serde_json::from_str(&json).expect("deserialize legacy");
        let mut restored = WasmWorkbook::new();
        let stats = restored
            .restore_persistence_v1_json(legacy)
            .expect("restore");
        assert_eq!(stats.restored_filter_sheets, 0);
        assert!(restored.workbook.filter_rules(0).is_empty());
    }

    /// The `snapshotFilters` / `restoreFilters` undo envelope round-trips,
    /// and an empty one CLEARS rather than no-ops (REPLACE semantics).
    #[test]
    fn wasm_filter_snapshot_restore_round_trip() {
        let mut wb = workbook_with_filter();
        wb.workbook
            .apply_filter(0, &[keep_list(&["3", "5"])])
            .expect("apply");
        assert_eq!(wb.get_number(0, "C1"), 9.0);

        let before = FilterSnapshotJSON {
            version: 1,
            filters: wb.filters_json(),
        };

        wb.workbook.apply_filter(0, &[keep_list(&["5"])]).expect("apply");
        // Only A5 matches; A1 stays visible as the header row.
        assert_eq!(wb.get_number(0, "C1"), 6.0); // 15 - 2 - 3 - 4

        assert_eq!(wb.restore_filters_json(before), Ok(1));
        assert_eq!(wb.workbook.filter_hidden_rows(0), vec![1, 3]);
        assert_eq!(wb.get_number(0, "C1"), 9.0);

        let empty = FilterSnapshotJSON {
            version: 1,
            filters: vec![],
        };
        assert_eq!(wb.restore_filters_json(empty), Ok(0));
        assert!(wb.workbook.filter_rules(0).is_empty());
        assert_eq!(wb.get_number(0, "C1"), 15.0);
    }

    /// A future envelope version is rejected loudly, mirroring
    /// `restoreTables` / `restoreHidden`.
    #[test]
    fn wasm_filter_restore_rejects_unsupported_version_without_mutating() {
        let mut wb = workbook_with_filter();
        wb.workbook.apply_filter(0, &[keep_list(&["3"])]).expect("apply");
        let bad = FilterSnapshotJSON {
            version: 2,
            filters: vec![],
        };
        assert_eq!(
            wb.restore_filters_json(bad),
            Err("unsupported-snapshot-version".into())
        );
        assert_eq!(
            wb.workbook.filter_rules(0),
            vec![keep_list(&["3"])],
            "rejected without mutating"
        );
    }

    /// The rule wire is a cross-LANGUAGE contract: these objects are the
    /// same shape the TypeScript `ColumnFilterRule` union already carries
    /// (`spreadsheet-ui-core/src/filter-sort/types.ts`), so a host passes
    /// its existing rule objects straight through with no mapping layer.
    /// Asserted at the JSON-TEXT level because that is what actually
    /// crosses; a struct-level check would not catch a renamed key.
    #[test]
    fn wasm_column_filter_rule_wire_matches_the_typescript_shape() {
        let rules = vec![
            ColumnFilterRuleJSON::from_rule(&ColumnFilterRule::Equals {
                col_index: 2,
                value: "abc".into(),
                case_sensitive: true,
            }),
            ColumnFilterRuleJSON::from_rule(&ColumnFilterRule::Contains {
                col_index: 0,
                value: "x".into(),
                case_sensitive: false,
            }),
            ColumnFilterRuleJSON::from_rule(&ColumnFilterRule::Range {
                col_index: 1,
                min: Some(1.0),
                max: None,
            }),
            ColumnFilterRuleJSON::from_rule(&ColumnFilterRule::List {
                col_index: 3,
                values: vec!["a".into()],
            }),
        ];
        let json = serde_json::to_string(&rules).expect("serialize");
        assert_eq!(
            json,
            "[{\"kind\":\"equals\",\"colIndex\":2,\"value\":\"abc\",\"caseSensitive\":true},\
             {\"kind\":\"contains\",\"colIndex\":0,\"value\":\"x\"},\
             {\"kind\":\"range\",\"colIndex\":1,\"min\":1.0},\
             {\"kind\":\"list\",\"colIndex\":3,\"values\":[\"a\"]}]",
            "an absent `caseSensitive` means false and an absent bound means unbounded, \
             exactly as the optional TypeScript fields do"
        );

        // ...and it reads back what the host would send, including the
        // optional keys left out.
        let parsed: Vec<ColumnFilterRuleJSON> = serde_json::from_str(
            "[{\"kind\":\"equals\",\"colIndex\":2,\"value\":\"abc\"},\
              {\"kind\":\"range\",\"colIndex\":1,\"max\":9}]",
        )
        .expect("deserialize");
        let back: Vec<ColumnFilterRule> = parsed
            .into_iter()
            .map(ColumnFilterRuleJSON::into_rule)
            .collect();
        assert_eq!(
            back,
            vec![
                ColumnFilterRule::Equals {
                    col_index: 2,
                    value: "abc".into(),
                    case_sensitive: false,
                },
                ColumnFilterRule::Range {
                    col_index: 1,
                    min: None,
                    max: Some(9.0),
                },
            ]
        );
    }

    /// **The value-getter identity, measured rather than argued.**
    ///
    /// Design §5.2 names the real cross-engine fork: not the predicate but
    /// the VALUE GETTER. On the worker path the host's TypeScript predicate
    /// compares against `snapshot.display`, which this boundary produces
    /// with `value_to_display`. If `Workbook::apply_filter` fed its
    /// predicate from any other rendering, the sink-down would silently
    /// change which rows a filter hides.
    ///
    /// So: for one cell of every shape the engine can hold, take the string
    /// the WIRE emits and use it verbatim as a case-SENSITIVE `equals` rule.
    /// Every such row must survive. A one-character difference anywhere in
    /// the two renderings hides the row instead, and the assertion names
    /// which shape drifted.
    #[test]
    fn the_predicate_compares_against_the_same_bytes_the_wire_carries() {
        let mut wb = WasmWorkbook::new();
        wb.set_text(0, "A1", "header");
        // Row 1..: one cell shape each. Row 6 is deliberately left EMPTY —
        // the sparse scan never visits it, so its "" comes from the host's
        // `?? ''` fallback rather than from the formatter, and that is the
        // one place the two renderings could disagree by construction.
        wb.set_number(0, "A2", 42.0); // integer-valued double -> "42"
        wb.set_number(0, "A3", 1.5); // fractional -> "1.5"
        wb.set_text(0, "A4", "Mixed Case Text");
        wb.set_boolean(0, "A5", true); // -> "TRUE"
        assert!(wb.set_formula(0, "A7", "=1/0")); // -> "#DIV/0!"
        assert!(wb.set_formula(0, "A8", "=2*21")); // formula result -> "42"
        wb.set_number(0, "A9", 1e20); // beyond the integer cutoff
        wb.set_text(0, "A10", ""); // explicitly empty text

        for row in 1..10u32 {
            let addr = format!("A{}", row + 1);
            let wire = wb.get_cell_display(0, &addr);
            let report = wb
                .workbook
                .apply_filter(
                    0,
                    &[ColumnFilterRule::Equals {
                        col_index: 0,
                        value: wire.clone(),
                        case_sensitive: true,
                    }],
                )
                .expect("apply");
            assert!(
                !report.hidden_rows.contains(&row),
                "row {row} ({addr}) renders as {wire:?} on the wire, but the engine \
                 predicate compared against something else"
            );
        }

        // Non-vacuity: a string that is NOT any cell's rendering hides
        // every judged row, so the loop above is not passing trivially.
        let report = wb
            .workbook
            .apply_filter(
                0,
                &[ColumnFilterRule::Equals {
                    col_index: 0,
                    value: "not-a-rendering".into(),
                    case_sensitive: true,
                }],
            )
            .expect("apply");
        assert_eq!(report.hidden_rows.len(), 9);
    }

    /// The structured rejection reaches JS as `{ ok: false, code, message }`
    /// inside the `Ok` arm, never as a thrown exception — the `sortRange`
    /// convention.
    #[test]
    fn wasm_filter_source_too_large_is_a_structured_rejection() {
        let mut wb = workbook_with_filter();
        wb.set_text(0, "A50001", "far");
        let err = wb
            .workbook
            .apply_filter(0, &[keep_list(&["3"])])
            .unwrap_err();
        assert_eq!(
            err,
            FilterError::SourceTooLarge {
                rows: 50_001,
                columns: 1,
                predicate_cells: 50_001,
            }
        );
        assert!(
            wb.workbook.filter_rules(0).is_empty(),
            "an over-budget source must not activate the filter"
        );
    }

    #[test]
    fn wasm_table_restore_of_an_empty_envelope_clears_the_registry() {
        let mut wb = workbook_with_inventory_table();
        let empty = TableRegistrySnapshotJSON {
            version: 1,
            tables: vec![],
        };
        assert_eq!(wb.restore_tables_json(empty), Ok(0));
        assert_eq!(wb.workbook.table_count(), 0);
    }

    #[test]
    fn wasm_table_restore_rejects_unsupported_version_without_mutating() {
        let mut wb = workbook_with_inventory_table();
        let bad = TableRegistrySnapshotJSON {
            version: 2,
            tables: vec![],
        };
        assert_eq!(
            wb.restore_tables_json(bad),
            Err("unsupported-snapshot-version".into())
        );
        assert_eq!(wb.workbook.table_count(), 1, "registry untouched");
    }

    #[test]
    fn wasm_table_restore_surfaces_engine_error_ids_and_parse_failures() {
        let mut wb = workbook_with_inventory_table();

        // Engine-side rejection keeps the stable `table_error_to_js` id.
        let malformed = TableRegistrySnapshotJSON {
            version: 1,
            tables: vec![TableJSON {
                name: "Broken".into(),
                sheet: "Sheet1".into(),
                sheet_index: 0,
                range: "A1:C4".into(),
                has_headers: true,
                has_totals: false,
                columns: vec!["only-one".into()],
            }],
        };
        assert_eq!(
            wb.restore_tables_json(malformed),
            Err("malformed-snapshot".into())
        );

        // Wire-side parse failure is reported before the engine is reached.
        let unparseable = TableRegistrySnapshotJSON {
            version: 1,
            tables: vec![TableJSON {
                name: "Broken".into(),
                sheet: "Sheet1".into(),
                sheet_index: 0,
                range: "not-a-cell".into(),
                has_headers: true,
                has_totals: false,
                columns: vec!["a".into()],
            }],
        };
        assert!(wb
            .restore_tables_json(unparseable)
            .unwrap_err()
            .contains("invalid table range cell"));

        assert_eq!(wb.workbook.table_count(), 1, "both rejections were inert");
    }

    #[test]
    fn wasm_table_json_round_trips_through_into_entry() {
        let wb = workbook_with_inventory_table();
        let json = wb.tables_json().into_iter().next().expect("one table");
        let entry = json.into_entry().expect("parse");
        assert_eq!(entry.name(), "Inventory");
        assert_eq!(entry.sheet_name(), "Sheet1");
        assert_eq!(entry.range().start, CellAddress::new(0, 0));
        assert_eq!(entry.range().end, CellAddress::new(3, 2));
        assert!(entry.has_headers());
        assert_eq!(entry.columns(), ["Name", "Qty", "Price"]);
    }

    #[test]
    fn wasm_persistence_v1_carries_the_table_registry_through_a_restore() {
        let source = workbook_with_inventory_table();
        let envelope = source.snapshot_persistence_v1_json();
        assert_eq!(envelope.tables.len(), 1, "registry rides along");
        assert_eq!(envelope.tables[0].name, "Inventory");

        // A FRESH workbook — this is the shape `restore_persistence_v1`
        // builds internally, and the case where a missing registry made the
        // restore lossy.
        let mut restored = WasmWorkbook::new();
        let stats = restored.restore_persistence_v1_json(envelope).unwrap();
        assert_eq!(stats.restored_tables, 1);

        let entry = restored.workbook.get_table("Inventory").expect("entry");
        assert_eq!(entry.sheet_name(), "Sheet1");
        assert_eq!(entry.columns(), ["Name", "Qty", "Price"]);

        // The decisive check: a structured reference resolves after restore.
        restored
            .workbook
            .set_formula(0, "E1", "=SUM(Inventory[Qty])");
        assert_eq!(restored.workbook.get_cell("Sheet1", "E1"), Value::Number(6.0));
    }

    #[test]
    fn wasm_persistence_v1_payload_without_tables_field_still_restores() {
        // Backward compatibility: payloads written before the field existed
        // deserialize with an empty registry rather than failing.
        let json = r#"{"version":1,"sheets":[{"idx":0,"name":"Sheet1"}],"cells":[]}"#;
        let payload: WorkbookPersistenceV1JSON =
            serde_json::from_str(json).expect("legacy payload parses");
        assert!(payload.tables.is_empty());

        let mut wb = workbook_with_inventory_table();
        let stats = wb.restore_persistence_v1_json(payload).unwrap();
        assert_eq!(stats.restored_tables, 0);
        assert_eq!(
            wb.workbook.table_count(),
            0,
            "fresh workbook + empty registry"
        );
    }

    #[test]
    fn wasm_persistence_v1_omits_the_tables_key_for_a_table_less_workbook() {
        let wb = WasmWorkbook::new();
        let envelope = wb.snapshot_persistence_v1_json();
        let json = serde_json::to_string(&envelope).expect("serialize");
        assert!(
            !json.contains("\"tables\""),
            "wire stays byte-identical for table-less workbooks: {json}"
        );
    }

    // === sortRange wire helpers (S2) ===

    #[test]
    fn sort_range_wire_parses_a1_string() {
        let range = SortRangeWireJSON::A1("A1:B3".into())
            .into_range()
            .unwrap()
            .normalize();
        assert_eq!(range.start, CellAddress::new(0, 0));
        assert_eq!(range.end, CellAddress::new(2, 1));
    }

    #[test]
    fn sort_range_wire_single_cell_a1_is_one_by_one() {
        let range = SortRangeWireJSON::A1("C5".into()).into_range().unwrap();
        assert_eq!(range.start, CellAddress::new(4, 2));
        assert_eq!(range.end, CellAddress::new(4, 2));
    }

    #[test]
    fn sort_range_wire_parses_bounds_object() {
        let range = SortRangeWireJSON::Bounds {
            start_row: 1,
            start_col: 2,
            end_row: 4,
            end_col: 3,
        }
        .into_range()
        .unwrap();
        assert_eq!(range.start, CellAddress::new(1, 2));
        assert_eq!(range.end, CellAddress::new(4, 3));
    }

    #[test]
    fn sort_range_wire_rejects_garbage_a1() {
        assert!(SortRangeWireJSON::A1("not-a-cell".into())
            .into_range()
            .is_err());
    }

    #[test]
    fn sort_key_wire_direction_and_case_defaults() {
        // Missing direction → ascending; caseSensitive default false.
        let k = SortKeyWireJSON {
            col: 3,
            direction: None,
            case_sensitive: false,
        }
        .into_key();
        assert_eq!(k.col, 3);
        assert_eq!(k.direction, SortDirection::Ascending);
        assert!(!k.case_sensitive);

        // Both short and long descending spellings map to Descending.
        for spelling in ["desc", "descending"] {
            let k = SortKeyWireJSON {
                col: 0,
                direction: Some(spelling.into()),
                case_sensitive: true,
            }
            .into_key();
            assert_eq!(k.direction, SortDirection::Descending, "{spelling}");
            assert!(k.case_sensitive);
        }

        // Unknown spelling falls back to ascending (never panics).
        let k = SortKeyWireJSON {
            col: 0,
            direction: Some("sideways".into()),
            case_sensitive: false,
        }
        .into_key();
        assert_eq!(k.direction, SortDirection::Ascending);
    }

    #[test]
    fn sort_range_report_json_maps_permutation_to_pairs() {
        let report = SortRangeReport {
            moved_rows: 2,
            moved_cells: 3,
            row_permutation: vec![(0, 1), (1, 0)],
        };
        let json = SortRangeReportJSON::from_report(&report);
        assert!(json.ok);
        assert_eq!(json.moved_rows, 2);
        assert_eq!(json.moved_cells, 3);
        assert_eq!(json.row_permutation, vec![[0, 1], [1, 0]]);
    }

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
    fn wasm_calc_error_token_round_trips() {
        assert_eq!(error_token_to_value_error("#NULL!"), Some(ValueError::Null));
        assert_eq!(
            error_token_to_value_error("#N/A"),
            Some(ValueError::NotAvailable)
        );
        assert_eq!(error_token_to_value_error("#CALC!"), Some(ValueError::Calc));
        assert_eq!(value_error_from_display("#NULL!"), ValueError::Null);
        assert_eq!(value_error_from_display("#N/A"), ValueError::NotAvailable);
        assert_eq!(value_error_from_display("#CALC!"), ValueError::Calc);
        assert_eq!(value_to_display(&Value::Error(ValueError::Calc)), "#CALC!");

        let mut sheet = WasmSheet::new();
        sheet.set_error("A1", "#CALC!");
        assert!(sheet.is_error("A1"));
        assert_eq!(sheet.get_display("A1"), "#CALC!");
        sheet.set_error("A2", "#N/A");
        assert!(sheet.is_error("A2"));
        assert_eq!(sheet.get_display("A2"), "#N/A");
        sheet.set_error("A3", "#NULL!");
        assert!(sheet.is_error("A3"));
        assert_eq!(sheet.get_display("A3"), "#NULL!");
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
        assert_eq!(wb.debug_formula_cache_state(0, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(2, "C2"), "clean");
        assert_eq!(wb.debug_formula_cache_state(1, "C2"), "clean");
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
            ..Default::default()
        };
        source.workbook.sheet_mut(0).unwrap().set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(2, 0)),
            number_fmt.clone().into_format(),
        );
        let custom_fmt = CellFormatJSON {
            number_format: Some(NumberFormatJSON {
                kind: "custom".into(),
                digits: None,
                symbol: None,
                pattern: Some("#,##0.0\" kg\"".into()),
                thousands: None,
            }),
            ..Default::default()
        };
        source.workbook.sheet_mut(1).unwrap().set_format_range(
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(0, 0)),
            custom_fmt.into_format(),
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

        let restored_custom_fmt =
            restored
                .workbook
                .sheet(1)
                .unwrap()
                .snapshot_format_range(CellRange::new(
                    CellAddress::new(0, 0),
                    CellAddress::new(0, 0),
                ));
        assert_eq!(restored_custom_fmt.range_formats.len(), 1);
        match &restored_custom_fmt.range_formats[0].fmt.number_format {
            NumberFormat::Custom(pattern) => assert_eq!(pattern, "#,##0.0\" kg\""),
            other => panic!("expected custom number format, got {other:?}"),
        }
        assert_eq!(
            restored.workbook.sheet(1).unwrap().formatted_display("A1"),
            "100.0 kg"
        );
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
            ..Default::default()
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
    fn wasm_workbook_viewport_size_facts_roundtrip_without_cells() {
        let mut source = WasmWorkbook::new();
        assert!(source.set_row_height(0, 3, 44));
        assert!(source.set_col_width(0, 2, 128));

        let envelope = source.snapshot_persistence_v1_json();
        assert_eq!(envelope.cells.len(), 0);
        assert_eq!(envelope.sheets[0].row_count, None);
        assert_eq!(envelope.sheets[0].col_count, None);
        assert_eq!(envelope.sizes.len(), 1);
        assert_eq!(envelope.sizes[0].row_heights[0].row_index, 3);
        assert_eq!(envelope.sizes[0].row_heights[0].height_px, 44);
        assert_eq!(envelope.sizes[0].col_widths[0].col_index, 2);
        assert_eq!(envelope.sizes[0].col_widths[0].width_px, 128);

        let mut restored = WasmWorkbook::new();
        let stats = restored.restore_persistence_v1_json(envelope).unwrap();
        assert_eq!(stats.restored_cells, 0);

        let snapshot = ViewportSizeSnapshotJSON::from_sheet_range(
            restored.workbook.sheet(0).unwrap(),
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(10, 10)),
            Some(0),
        );
        assert_eq!(snapshot.row_heights.len(), 1);
        assert_eq!(snapshot.row_heights[0].row_index, 3);
        assert_eq!(snapshot.row_heights[0].height_px, 44);
        assert_eq!(snapshot.col_widths.len(), 1);
        assert_eq!(snapshot.col_widths[0].col_index, 2);
        assert_eq!(snapshot.col_widths[0].width_px, 128);
    }

    #[test]
    fn wasm_workbook_snapshot_viewport_sizes_filters_window() {
        let mut wb = WasmWorkbook::new();
        let _ = wb.add_sheet("Second");
        assert!(wb.set_row_height(1, 1, 24));
        assert!(wb.set_row_height(1, 9, 48));
        assert!(wb.set_col_width(1, 2, 120));
        assert!(wb.set_col_width(1, 8, 240));

        let snapshot = ViewportSizeSnapshotJSON::from_sheet_range(
            wb.workbook.sheet(1).unwrap(),
            CellRange::new(CellAddress::new(0, 0), CellAddress::new(4, 4)),
            Some(1),
        );
        assert_eq!(snapshot.sheet, Some(1));
        assert_eq!(snapshot.row_heights.len(), 1);
        assert_eq!(snapshot.row_heights[0].row_index, 1);
        assert_eq!(snapshot.col_widths.len(), 1);
        assert_eq!(snapshot.col_widths[0].col_index, 2);
    }

    #[test]
    fn wasm_workbook_restore_persistence_v1_rejects_bad_size_without_mutating_workbook() {
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
            formats: vec![],
            sizes: vec![ViewportSizeSnapshotJSON {
                sheet: Some(0),
                start_row: 0,
                start_col: 0,
                end_row: 2,
                end_col: 2,
                row_heights: vec![ViewportRowHeightJSON {
                    row_index: 10,
                    height_px: 40,
                }],
                col_widths: vec![],
            }],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
        };

        assert!(wb.restore_persistence_v1_json(payload).is_err());
        assert_eq!(wb.sheet_name(0), "Keep");
        assert_eq!(wb.get_number(0, "A1"), 7.0);
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
            sizes: vec![],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
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
            sizes: vec![],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
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
            sizes: vec![],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
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
            sizes: vec![],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
        };

        let stats = wb.restore_persistence_v1_json(payload).unwrap();
        assert_eq!(stats.sheets, 1);
        assert_eq!(wb.next_token, 0);
        assert!(wb.subscriptions.is_empty());
    }

    /// Build a persistence-v1 envelope with `n` number primitives in
    /// column A and `n` formulas (`=A{row}+1`) in column B, all on one
    /// sheet. Shared by the storage-primary restore pin + bench.
    fn persistence_v1_workload(n: u32) -> WorkbookPersistenceV1JSON {
        let mut cells = Vec::with_capacity(2 * n as usize);
        for row in 0..n {
            cells.push(SparseCellJSON {
                sheet: 0,
                addr: CellAddress::new(row, 0).to_string(),
                row,
                col: 0,
                kind: "number".into(),
                value: Some(ImportValueJSON::Number(row as f64)),
            });
            cells.push(SparseCellJSON {
                sheet: 0,
                addr: CellAddress::new(row, 1).to_string(),
                row,
                col: 1,
                kind: "formula".into(),
                value: Some(ImportValueJSON::Text(format!("=A{}+1", row + 1))),
            });
        }
        WorkbookPersistenceV1JSON {
            version: 1,
            sheets: vec![WorkbookPersistenceSheetMetaJSON {
                idx: 0,
                name: "Data".into(),
                row_count: Some(n),
                col_count: Some(2),
            }],
            cells,
            formats: vec![],
            sizes: vec![],
            tables: vec![],
            hidden: vec![],
            filters: vec![],
        }
    }

    /// Audit B-1 (W2.3): `restore_persistence_v1` routes through the
    /// storage-primary `install_workbook_bulk` — a 1k-formula restore
    /// leaves the dep graph EMPTY (no eager parse, no eager dep
    /// install) and evaluates nothing until first read.
    #[test]
    fn wasm_workbook_restore_persistence_v1_storage_primary_lazy() {
        let payload = persistence_v1_workload(1_000);

        let mut restored = WasmWorkbook::new();
        let stats = restored.restore_persistence_v1_json(payload).unwrap();
        assert_eq!(stats.restored_cells, 2_000);
        assert_eq!(stats.sheets, 1);

        // Lazy contract: nothing parsed eagerly into the dep graph,
        // nothing evaluated.
        let sheet = restored.workbook.sheet(0).unwrap();
        assert_eq!(sheet.debug_point_dependency_key_count(), 0);
        assert_eq!(restored.debug_formula_eval_count(0), 0);

        // Values are correct on first read (hydrate-on-read).
        assert_eq!(restored.get_number(0, "A500"), 499.0);
        assert_eq!(restored.get_number(0, "B500"), 500.0);
        assert_eq!(restored.get_number(0, "B1000"), 1000.0);
        assert_eq!(restored.debug_formula_cache_state(0, "B1"), "dirty");
    }

    /// Quick timing for the B-1 reroute. Run with:
    /// `cargo test -p einfach-wasm --release bench_restore_persistence_v1 -- --ignored --nocapture`
    #[test]
    #[ignore = "bench — run manually with --ignored --nocapture"]
    fn bench_restore_persistence_v1_50k_plus_50k() {
        let payload = persistence_v1_workload(50_000);
        let mut restored = WasmWorkbook::new();
        let start = std::time::Instant::now();
        let stats = restored.restore_persistence_v1_json(payload).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(stats.restored_cells, 100_000);
        let per_cell_us = elapsed.as_secs_f64() * 1e6 / 100_000.0;
        println!(
            "restore_persistence_v1 50k primitives + 50k formulas: {elapsed:?} ({per_cell_us:.2} us/cell)"
        );
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
        wb.subscriptions
            .insert(202, WorkbookCellSubscription { sheet_idx: 1, sub });

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

    #[cfg(target_arch = "wasm32")]
    #[derive(serde::Serialize)]
    struct TestBulkImportCell {
        sheet: usize,
        row: u32,
        col: u32,
        kind: &'static str,
        value: TestBulkImportValue,
    }

    #[cfg(target_arch = "wasm32")]
    #[derive(serde::Serialize)]
    #[serde(untagged)]
    enum TestBulkImportValue {
        Number(f64),
        Text(String),
    }

    #[cfg(target_arch = "wasm32")]
    #[derive(serde::Deserialize)]
    struct TestBulkImportStats {
        accepted: u32,
        formulas: u32,
        #[serde(rename = "rejectedFormulas")]
        rejected_formulas: u32,
        errors: u32,
    }

    #[cfg(target_arch = "wasm32")]
    #[wasm_bindgen_test::wasm_bindgen_test]
    fn wasm_workbook_bulk_import_many_formulas_stays_lazy_until_read() {
        const FORMULA_COUNT: u32 = 1_000;

        let mut cells = Vec::with_capacity((FORMULA_COUNT * 2) as usize);
        for row in 0..FORMULA_COUNT {
            let spreadsheet_row = row + 1;
            cells.push(TestBulkImportCell {
                sheet: 0,
                row,
                col: 0,
                kind: "number",
                value: TestBulkImportValue::Number(spreadsheet_row as f64),
            });
            cells.push(TestBulkImportCell {
                sheet: 0,
                row,
                col: 1,
                kind: "formula",
                value: TestBulkImportValue::Text(format!("=A{spreadsheet_row}+1")),
            });
        }

        let import_value =
            serde_wasm_bindgen::to_value(&cells).expect("serialize bulk import cells");
        let mut wb = WasmWorkbook::new();
        let stats_value = wb
            .bulk_import_cells(import_value)
            .expect("bulk import cells should succeed");
        let stats: TestBulkImportStats =
            serde_wasm_bindgen::from_value(stats_value).expect("deserialize import stats");

        assert_eq!(stats.accepted, FORMULA_COUNT * 2);
        assert_eq!(stats.formulas, FORMULA_COUNT);
        assert_eq!(stats.rejected_formulas, 0);
        assert_eq!(stats.errors, 0);
        assert_eq!(wb.debug_formula_count(), FORMULA_COUNT);
        assert_eq!(wb.debug_formula_eval_count_total(), 0);

        let targets = [
            ("B1", "2"),
            ("B250", "251"),
            ("B500", "501"),
            ("B1000", "1001"),
        ];
        for (idx, (addr, expected)) in targets.iter().enumerate() {
            assert_eq!(wb.get_display(0, addr), *expected);
            assert_eq!(wb.debug_formula_eval_count_total(), (idx + 1) as u32);
        }

        assert_eq!(wb.debug_formula_cache_state(0, "B999"), "dirty");
        assert_eq!(wb.get_display(0, "A1000"), "1000");
        assert_eq!(wb.debug_formula_eval_count_total(), targets.len() as u32);
    }

    // Note: pre-flight payload-size guard tests
    // (`wasm_workbook_bulk_import_cells_refuses_oversized_payload` +
    // `_accepts_under_cap_payload`) were removed alongside the
    // `MAX_BULK_IMPORT_CELLS_PER_CALL` cap they covered — see
    // `rust/excel-core/docs/CAP_REMOVAL_2026-06-11.md`. With the cap gone
    // there is no oversized-payload error path to assert; the WASM
    // linear-memory ceiling is the only remaining bound and it manifests
    // as a runtime allocation failure, not a structured `Result::Err`.
}
