/// A cell address in a spreadsheet, e.g. "A1" → (row=0, col=0).
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct CellAddress {
    pub row: u32,
    pub col: u32,
}

/// A cell reference with optional absolute row/column markers.
#[derive(Clone, Hash, Eq, PartialEq, Debug)]
pub struct CellReference {
    pub addr: CellAddress,
    pub abs_col: bool,
    pub abs_row: bool,
    pub invalid: bool,
    pub sheet_name: Option<String>,
}

impl CellAddress {
    pub fn new(row: u32, col: u32) -> Self {
        CellAddress { row, col }
    }

    /// Parse a cell reference like "A1", "B2", "AA100".
    /// Column letters are case-insensitive. Row numbers are 1-based.
    pub fn parse(s: &str) -> Option<CellAddress> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }

        // Split into letter part and number part
        let mut col_end = 0;
        for (i, c) in s.char_indices() {
            if c.is_ascii_alphabetic() {
                col_end = i + 1;
            } else {
                break;
            }
        }

        if col_end == 0 {
            return None; // no column letters
        }

        let col_str = &s[..col_end];
        let row_str = &s[col_end..];

        if row_str.is_empty() {
            return None; // no row number
        }

        let row_num: u32 = row_str.parse().ok()?;
        if row_num == 0 {
            return None; // row numbers are 1-based
        }

        let col = col_letters_to_index(col_str)?;

        Some(CellAddress {
            row: row_num - 1, // convert to 0-based
            col,
        })
    }

    /// Convert back to string representation like "A1".
    pub fn to_string_repr(&self) -> String {
        let col_str = col_index_to_letters(self.col);
        format!("{}{}", col_str, self.row + 1) // convert back to 1-based
    }
}

impl CellReference {
    pub fn new(row: u32, col: u32) -> Self {
        Self {
            addr: CellAddress::new(row, col),
            abs_col: false,
            abs_row: false,
            invalid: false,
            sheet_name: None,
        }
    }

    pub fn from_addr(addr: CellAddress) -> Self {
        Self {
            addr,
            abs_col: false,
            abs_row: false,
            invalid: false,
            sheet_name: None,
        }
    }

    pub fn invalid() -> Self {
        Self {
            addr: CellAddress::new(0, 0),
            abs_col: false,
            abs_row: false,
            invalid: true,
            sheet_name: None,
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        let s = input.trim();
        if s.is_empty() {
            return None;
        }

        let chars: Vec<char> = s.chars().collect();
        let mut pos = 0;
        let abs_col = if chars.get(pos) == Some(&'$') {
            pos += 1;
            true
        } else {
            false
        };

        let col_start = pos;
        while let Some(ch) = chars.get(pos) {
            if ch.is_ascii_alphabetic() {
                pos += 1;
            } else {
                break;
            }
        }

        if pos == col_start {
            return None;
        }

        let abs_row = if chars.get(pos) == Some(&'$') {
            pos += 1;
            true
        } else {
            false
        };

        let row_start = pos;
        while let Some(ch) = chars.get(pos) {
            if ch.is_ascii_digit() {
                pos += 1;
            } else {
                return None;
            }
        }

        if row_start == pos || pos != chars.len() {
            return None;
        }

        let col_str: String = chars[col_start..row_start - usize::from(abs_row)]
            .iter()
            .collect();
        let row_str: String = chars[row_start..pos].iter().collect();
        let row_num: u32 = row_str.parse().ok()?;
        if row_num == 0 {
            return None;
        }

        Some(Self {
            addr: CellAddress {
                row: row_num - 1,
                col: col_letters_to_index(&col_str)?,
            },
            abs_col,
            abs_row,
            invalid: false,
            sheet_name: None,
        })
    }

    pub fn shift(&self, row_delta: i32, col_delta: i32) -> Self {
        fn shift_axis(value: u32, delta: i32, absolute: bool) -> Option<u32> {
            if absolute {
                return Some(value);
            }

            let shifted = i64::from(value) + i64::from(delta);
            if shifted < 0 {
                None
            } else {
                Some(shifted as u32)
            }
        }

        if self.invalid {
            return self.clone();
        }

        let Some(row) = shift_axis(self.addr.row, row_delta, self.abs_row) else {
            return Self::invalid();
        };
        let Some(col) = shift_axis(self.addr.col, col_delta, self.abs_col) else {
            return Self::invalid();
        };

        Self {
            addr: CellAddress { row, col },
            abs_col: self.abs_col,
            abs_row: self.abs_row,
            invalid: false,
            sheet_name: self.sheet_name.clone(),
        }
    }

    pub fn to_string_repr(&self) -> String {
        if self.invalid {
            return "#REF!".into();
        }

        format!(
            "{}{}{}{}{}",
            self.sheet_name
                .as_ref()
                .map(|name| format!("{name}!"))
                .unwrap_or_default(),
            if self.abs_col { "$" } else { "" },
            col_index_to_letters(self.addr.col),
            if self.abs_row { "$" } else { "" },
            self.addr.row + 1
        )
    }

    pub fn is_invalid(&self) -> bool {
        self.invalid
    }
}

impl std::fmt::Display for CellAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_string_repr())
    }
}

/// Convert column letters to 0-based index: "A"→0, "B"→1, ..., "Z"→25, "AA"→26
fn col_letters_to_index(s: &str) -> Option<u32> {
    let mut result: u32 = 0;
    for c in s.chars() {
        let digit = c.to_ascii_uppercase() as u32 - 'A' as u32;
        if digit > 25 {
            return None;
        }
        result = result * 26 + digit + 1;
    }
    Some(result - 1) // convert to 0-based
}

/// Convert 0-based column index to letters: 0→"A", 25→"Z", 26→"AA"
fn col_index_to_letters(mut col: u32) -> String {
    let mut result = String::new();
    loop {
        result.push((b'A' + (col % 26) as u8) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    result.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_a1() {
        let addr = CellAddress::parse("A1").unwrap();
        assert_eq!(addr.row, 0);
        assert_eq!(addr.col, 0);
    }

    #[test]
    fn parse_b2() {
        let addr = CellAddress::parse("B2").unwrap();
        assert_eq!(addr.row, 1);
        assert_eq!(addr.col, 1);
    }

    #[test]
    fn parse_z26() {
        let addr = CellAddress::parse("Z26").unwrap();
        assert_eq!(addr.row, 25);
        assert_eq!(addr.col, 25);
    }

    #[test]
    fn parse_aa1() {
        let addr = CellAddress::parse("AA1").unwrap();
        assert_eq!(addr.row, 0);
        assert_eq!(addr.col, 26);
    }

    #[test]
    fn parse_ab3() {
        let addr = CellAddress::parse("AB3").unwrap();
        assert_eq!(addr.row, 2);
        assert_eq!(addr.col, 27);
    }

    #[test]
    fn parse_case_insensitive() {
        let addr = CellAddress::parse("a1").unwrap();
        assert_eq!(addr.row, 0);
        assert_eq!(addr.col, 0);
    }

    #[test]
    fn parse_invalid_empty() {
        assert!(CellAddress::parse("").is_none());
    }

    #[test]
    fn parse_invalid_no_row() {
        assert!(CellAddress::parse("A").is_none());
    }

    #[test]
    fn parse_invalid_no_col() {
        assert!(CellAddress::parse("123").is_none());
    }

    #[test]
    fn parse_invalid_zero_row() {
        assert!(CellAddress::parse("A0").is_none());
    }

    #[test]
    fn roundtrip_a1() {
        let addr = CellAddress::new(0, 0);
        assert_eq!(addr.to_string_repr(), "A1");
        assert_eq!(CellAddress::parse("A1").unwrap(), addr);
    }

    #[test]
    fn roundtrip_aa1() {
        let addr = CellAddress::new(0, 26);
        assert_eq!(addr.to_string_repr(), "AA1");
        assert_eq!(CellAddress::parse("AA1").unwrap(), addr);
    }

    #[test]
    fn roundtrip_z100() {
        let addr = CellAddress::new(99, 25);
        assert_eq!(addr.to_string_repr(), "Z100");
        assert_eq!(CellAddress::parse("Z100").unwrap(), addr);
    }

    #[test]
    fn col_letters_large() {
        // AZ = 51
        let addr = CellAddress::parse("AZ1").unwrap();
        assert_eq!(addr.col, 51);
        assert_eq!(CellAddress::new(0, 51).to_string_repr(), "AZ1");
    }

    #[test]
    fn display_trait() {
        let addr = CellAddress::new(0, 0);
        assert_eq!(format!("{}", addr), "A1");
    }

    #[test]
    fn parse_absolute_reference() {
        let reference = CellReference::parse("$B$3").unwrap();
        assert_eq!(reference.addr, CellAddress::new(2, 1));
        assert!(reference.abs_col);
        assert!(reference.abs_row);
    }

    #[test]
    fn parse_mixed_reference() {
        let reference = CellReference::parse("$C4").unwrap();
        assert_eq!(reference.addr, CellAddress::new(3, 2));
        assert!(reference.abs_col);
        assert!(!reference.abs_row);
    }

    #[test]
    fn parse_absolute_reference_is_case_insensitive() {
        let reference = CellReference::parse("$aa$10").unwrap();
        assert_eq!(reference.addr, CellAddress::new(9, 26));
        assert!(reference.abs_col);
        assert!(reference.abs_row);
    }

    #[test]
    fn parse_invalid_absolute_reference_shapes() {
        assert!(CellReference::parse("$").is_none());
        assert!(CellReference::parse("$A").is_none());
        assert!(CellReference::parse("A$").is_none());
        assert!(CellReference::parse("$A$0").is_none());
    }

    #[test]
    fn to_string_repr_preserves_absolute_axes() {
        let reference = CellReference {
            addr: CellAddress::new(6, 27),
            abs_col: true,
            abs_row: false,
            invalid: false,
            sheet_name: None,
        };
        assert_eq!(reference.to_string_repr(), "$AB7");
    }

    #[test]
    fn shift_relative_reference() {
        let shifted = CellReference::parse("B2").unwrap().shift(2, 1);
        assert_eq!(shifted.to_string_repr(), "C4");
    }

    #[test]
    fn shift_absolute_reference_preserves_locked_axes() {
        let shifted = CellReference::parse("$B2").unwrap().shift(3, 5);
        assert_eq!(shifted.to_string_repr(), "$B5");
    }

    #[test]
    fn shift_mixed_reference_moves_only_relative_axis() {
        let shifted = CellReference::parse("C$4").unwrap().shift(5, 2);
        assert_eq!(shifted.to_string_repr(), "E$4");
    }

    #[test]
    fn shift_past_sheet_origin_marks_reference_invalid() {
        let shifted = CellReference::parse("A1").unwrap().shift(-1, 0);
        assert!(shifted.is_invalid());
        assert_eq!(shifted.to_string_repr(), "#REF!");
    }
}
