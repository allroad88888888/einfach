use einfach_core::Value;

use crate::cell::CellAddress;
use crate::sheet::Sheet;

/// Parse a CSV string into rows of fields. Handles double-quote escaping
/// per RFC 4180: a field starts with `"`, ends at the next unescaped `"`,
/// and pairs of `""` inside become a single `"`.
///
/// Line endings: `\n` or `\r\n`. Empty trailing newline is dropped.
pub fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_field = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current_field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current_field.push(c);
            }
        } else {
            match c {
                '"' if current_field.is_empty() => in_quotes = true,
                ',' => {
                    current_row.push(std::mem::take(&mut current_field));
                }
                '\n' => {
                    current_row.push(std::mem::take(&mut current_field));
                    rows.push(std::mem::take(&mut current_row));
                }
                '\r' => {
                    // Skip CR; the LF that follows handles row break.
                    if chars.peek() != Some(&'\n') {
                        // Lone CR = row break (old Mac).
                        current_row.push(std::mem::take(&mut current_field));
                        rows.push(std::mem::take(&mut current_row));
                    }
                }
                _ => current_field.push(c),
            }
        }
    }
    // Flush trailing field / row that didn't end with a newline.
    if !current_field.is_empty() || !current_row.is_empty() {
        current_row.push(current_field);
        rows.push(current_row);
    }
    rows
}

/// Serialize a 2D grid of values to CSV. Quotes fields that contain `,`,
/// `"`, `\r`, or `\n`. Doubles internal `"` characters per RFC 4180.
pub fn to_csv(rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        for (j, field) in row.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str(&escape_field(field));
        }
        if i + 1 < rows.len() {
            out.push('\n');
        }
    }
    out
}

fn escape_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        let inner = s.replace('"', "\"\"");
        format!("\"{}\"", inner)
    } else {
        s.to_string()
    }
}

/// Import a CSV string into the sheet, starting at top-left = `origin`.
/// Each field is parsed: bare numbers via `parse::<f64>()`, leading `=`
/// becomes a formula, otherwise stored as text. Existing cells in the
/// target rectangle are overwritten.
pub fn import_csv(sheet: &mut Sheet, input: &str, origin: CellAddress) {
    let rows = parse_csv(input);
    for (r, row) in rows.iter().enumerate() {
        for (c, field) in row.iter().enumerate() {
            let addr = CellAddress::new(origin.row + r as u32, origin.col + c as u32);
            let addr_str = addr.to_string_repr();
            if field.starts_with('=') {
                let _ = sheet.set_formula(&addr_str, field);
            } else if field.is_empty() {
                // Skip empties so partial CSVs don't blanket-overwrite.
            } else if let Ok(n) = field.parse::<f64>() {
                sheet.set_cell(&addr_str, Value::Number(n));
            } else {
                sheet.set_cell(&addr_str, Value::Text(field.clone()));
            }
        }
    }
}

/// Export a rectangular region of the sheet as CSV. Formula cells emit
/// their computed display string (consistent with what the user sees).
/// To export the formula source instead, callers can iterate themselves
/// using `Sheet::get_formula`.
pub fn export_csv(sheet: &mut Sheet, top_left: CellAddress, bottom_right: CellAddress) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for r in top_left.row..=bottom_right.row {
        let mut row: Vec<String> = Vec::new();
        for c in top_left.col..=bottom_right.col {
            let addr = CellAddress::new(r, c).to_string_repr();
            let val = sheet.get_cell(&addr);
            row.push(value_to_csv_field(&val));
        }
        rows.push(row);
    }
    to_csv(&rows)
}

fn value_to_csv_field(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        Value::Text(s) => s.clone(),
        Value::Boolean(true) => "TRUE".into(),
        Value::Boolean(false) => "FALSE".into(),
        Value::Null => String::new(),
        Value::Error(e) => format!("{}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple() {
        let rows = parse_csv("a,b,c\n1,2,3");
        assert_eq!(rows, vec![vec!["a", "b", "c"], vec!["1", "2", "3"]]);
    }

    #[test]
    fn parse_with_quotes_and_commas() {
        let rows = parse_csv("\"hello, world\",42\n");
        assert_eq!(rows, vec![vec!["hello, world", "42"]]);
    }

    #[test]
    fn parse_escaped_quote() {
        let rows = parse_csv("\"she said \"\"hi\"\"\"\n");
        assert_eq!(rows, vec![vec!["she said \"hi\""]]);
    }

    #[test]
    fn to_csv_quotes_fields_containing_comma() {
        let s = to_csv(&[vec!["plain".into(), "with,comma".into()]]);
        assert_eq!(s, "plain,\"with,comma\"");
    }

    #[test]
    fn roundtrip() {
        let original = vec![
            vec!["name".into(), "note".into()],
            vec!["alice".into(), "hello, world".into()],
        ];
        let s = to_csv(&original);
        let parsed = parse_csv(&s);
        assert_eq!(parsed, original);
    }

    #[test]
    fn import_export_through_sheet() {
        let mut sheet = Sheet::new();
        import_csv(&mut sheet, "1,2,3\n4,5,6\n", CellAddress::new(0, 0));
        assert_eq!(sheet.get_cell("A1"), Value::Number(1.0));
        assert_eq!(sheet.get_cell("C2"), Value::Number(6.0));

        let exported = export_csv(&mut sheet, CellAddress::new(0, 0), CellAddress::new(1, 2));
        assert_eq!(exported, "1,2,3\n4,5,6");
    }

    #[test]
    fn import_recognizes_formula() {
        let mut sheet = Sheet::new();
        import_csv(&mut sheet, "10,20,=A1+B1", CellAddress::new(0, 0));
        assert_eq!(sheet.get_cell("C1"), Value::Number(30.0));
    }
}
