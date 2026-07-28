/// A cell address in a spreadsheet, e.g. "A1" → (row=0, col=0).
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct CellAddress {
    pub row: u32,
    pub col: u32,
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
}
