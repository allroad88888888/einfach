use crate::cell::CellAddress;

/// Which axes of an `Expr::Range` are unbounded (Excel-style `A:A`, `1:1`).
///
/// Phase 2 Track G: whole-column refs like `A:A` and whole-row refs like
/// `1:1` need to evaluate without materializing every cell in the
/// nominal coordinate space. We keep the AST shape as
/// `Range { start: CellAddress, end: CellAddress }` (so all dense paths
/// stay unchanged) and carry the unboundedness as a discriminator:
///
/// - `None` — fully bounded range, e.g. `A1:B3`. `start` / `end` are the
///   user-supplied corners.
/// - `Rows` — whole-column range, e.g. `A:A` or `A:C`. `start.row` and
///   `end.row` are sentinels (`0` and `u32::MAX`); `start.col` / `end.col`
///   carry the user-supplied column corners.
/// - `Cols` — whole-row range, e.g. `1:1` or `1:3`. `start.col` and
///   `end.col` are sentinels (`0` and `u32::MAX`); `start.row` / `end.row`
///   carry the user-supplied row corners.
/// - `Both` — whole-sheet range. Not produced by the parser yet but
///   reserved so a future `A:XFD` shorthand has a place to land.
///
/// `shift::map_addrs` and `shift::shift_refs` are invariant on the
/// unbounded axis (inserting a row inside column A doesn't move the
/// `A:A` corners); `render_formula` round-trips the original syntax.
/// Dependency registration goes through `collect_range_refs`, which
/// emits a canonical `CellRange` covering the entire sheet on the
/// unbounded axis — Track E's `RangeDependentIndex` then routes it
/// into `wide_ranges` (any range > 4096 rows or cols is wide).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RangeBounds {
    None,
    Rows,
    Cols,
    Both,
}

impl RangeBounds {
    pub fn rows_unbounded(self) -> bool {
        matches!(self, RangeBounds::Rows | RangeBounds::Both)
    }
    pub fn cols_unbounded(self) -> bool {
        matches!(self, RangeBounds::Cols | RangeBounds::Both)
    }
}

/// AST node for a formula expression.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// A literal number, e.g. 42, 3.14
    Number(f64),
    /// A literal string, e.g. "hello"
    Text(String),
    /// Literal TRUE / FALSE.
    Bool(bool),
    /// A cell reference, e.g. A1
    CellRef(CellAddress),
    /// Binary operation: left op right
    BinOp {
        op: BinOperator,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// Unary negation: -expr
    Negate(Box<Expr>),
    /// Function call: name(arg1, arg2, ...)
    FuncCall { name: String, args: Vec<Expr> },
    /// Cell range: `A1:B3` (bounded), `A:A` / `A:C` (whole columns),
    /// `1:1` / `1:3` (whole rows). For unbounded axes, `start` / `end`
    /// carry sentinel coordinates (`0` and `u32::MAX`) on that axis —
    /// see [`RangeBounds`] for details.
    Range {
        start: CellAddress,
        end: CellAddress,
        unbounded: RangeBounds,
    },
    /// Cross-sheet reference: `Sheet1!A1`. Resolution requires a Workbook
    /// scope at eval time; standalone Sheet eval treats it as #REF!.
    SheetRef { sheet: String, addr: CellAddress },
    /// Cross-sheet range: `Sheet1!A1:B3`. Kept distinct from `Range` so
    /// sheet-local dependency walkers never register the source addresses on
    /// the formula's own sheet.
    SheetRange {
        sheet: String,
        start: CellAddress,
        end: CellAddress,
        unbounded: RangeBounds,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinOperator {
    Add,
    Sub,
    Mul,
    Div,
    /// Exponent (`^`).
    Pow,
    /// String concatenation (`&`).
    Concat,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
}

/// Parse a formula string. Must start with '='.
/// Returns None if parsing fails.
pub fn parse_formula(input: &str) -> Option<Expr> {
    let input = input.trim();
    if !input.starts_with('=') {
        return None;
    }
    let mut parser = Parser::new(&input[1..]);
    let expr = parser.parse_expr()?;
    if parser.pos < parser.chars.len() {
        return None; // leftover input
    }
    Some(expr)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn new(input: &str) -> Self {
        Parser {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied()?;
        self.pos += 1;
        Some(c)
    }

    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, expected: char) -> Option<()> {
        self.skip_whitespace();
        if self.peek() == Some(expected) {
            self.advance();
            Some(())
        } else {
            None
        }
    }

    /// Top-level: comparisons (=, <>, <, <=, >, >=) — lowest precedence.
    fn parse_expr(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_concat()?;

        loop {
            self.skip_whitespace();
            let op = match (self.peek(), self.peek_at(1)) {
                (Some('<'), Some('>')) => {
                    self.advance();
                    self.advance();
                    BinOperator::NotEq
                }
                (Some('<'), Some('=')) => {
                    self.advance();
                    self.advance();
                    BinOperator::LtEq
                }
                (Some('>'), Some('=')) => {
                    self.advance();
                    self.advance();
                    BinOperator::GtEq
                }
                (Some('<'), _) => {
                    self.advance();
                    BinOperator::Lt
                }
                (Some('>'), _) => {
                    self.advance();
                    BinOperator::Gt
                }
                (Some('='), _) => {
                    self.advance();
                    BinOperator::Eq
                }
                _ => break,
            };
            let right = self.parse_concat()?;
            left = Expr::BinOp {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Some(left)
    }

    /// concat = add_sub ('&' add_sub)* — left-assoc, between comparison and add/sub.
    fn parse_concat(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_add_sub()?;

        loop {
            self.skip_whitespace();
            if self.peek() == Some('&') {
                self.advance();
                let right = self.parse_add_sub()?;
                left = Expr::BinOp {
                    op: BinOperator::Concat,
                    left: Box::new(left),
                    right: Box::new(right),
                };
            } else {
                break;
            }
        }
        Some(left)
    }

    /// add_sub = mul_div (('+' | '-') mul_div)*
    fn parse_add_sub(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_mul_div()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('+') => {
                    self.advance();
                    let right = self.parse_mul_div()?;
                    left = Expr::BinOp {
                        op: BinOperator::Add,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('-') => {
                    self.advance();
                    let right = self.parse_mul_div()?;
                    left = Expr::BinOp {
                        op: BinOperator::Sub,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                _ => break,
            }
        }
        Some(left)
    }

    /// mul_div = pow (('*' | '/') pow)*
    fn parse_mul_div(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_pow()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') => {
                    self.advance();
                    let right = self.parse_pow()?;
                    left = Expr::BinOp {
                        op: BinOperator::Mul,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('/') => {
                    self.advance();
                    let right = self.parse_pow()?;
                    left = Expr::BinOp {
                        op: BinOperator::Div,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                _ => break,
            }
        }
        Some(left)
    }

    /// pow = unary ('^' pow)? — right-associative
    fn parse_pow(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let left = self.parse_unary()?;
        self.skip_whitespace();
        if self.peek() == Some('^') {
            self.advance();
            let right = self.parse_pow()?;
            Some(Expr::BinOp {
                op: BinOperator::Pow,
                left: Box::new(left),
                right: Box::new(right),
            })
        } else {
            Some(left)
        }
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    /// unary = '-' unary | primary
    fn parse_unary(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        if self.peek() == Some('-') {
            self.advance();
            let expr = self.parse_unary()?;
            Some(Expr::Negate(Box::new(expr)))
        } else {
            self.parse_primary()
        }
    }

    /// primary = number | string | func_call | cell_ref_or_range | '(' expr ')'
    fn parse_primary(&mut self) -> Option<Expr> {
        self.skip_whitespace();

        match self.peek()? {
            '(' => {
                self.advance();
                let expr = self.parse_expr()?;
                self.expect(')')?;
                Some(expr)
            }
            '"' => self.parse_string(),
            c if c.is_ascii_digit() || c == '.' => {
                // Disambiguate `<digits>:<digits>` (whole-row range) from a
                // plain number. We scan a digit run; if the next non-digit
                // char is ':' followed by another digit run, treat as a
                // whole-row range. Otherwise fall back to parse_number,
                // which handles fractional / scientific via '.'.
                if c.is_ascii_digit() {
                    if let Some(range) = self.try_parse_whole_row_range() {
                        return Some(range);
                    }
                }
                self.parse_number()
            }
            c if c.is_ascii_alphabetic() => self.parse_identifier(),
            _ => None,
        }
    }

    /// Speculative parse for `<digits>:<digits>` whole-row syntax. On
    /// success consumes both digit runs and returns the range. On
    /// failure rolls back to the original position so `parse_number`
    /// can take over.
    fn try_parse_whole_row_range(&mut self) -> Option<Expr> {
        let save = self.pos;
        // Scan first digit run.
        let s1 = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }
        if self.pos == s1 {
            return None;
        }
        let first: String = self.chars[s1..self.pos].iter().collect();
        // Must see ':' immediately (no whitespace — `1 :1` is intentionally
        // not the Excel whole-row syntax; this keeps decimals like
        // `1.5` from accidentally matching when a future change moves
        // the dispatch).
        if self.peek() != Some(':') {
            self.pos = save;
            return None;
        }
        let colon_at = self.pos;
        self.advance();
        // Scan second digit run.
        let s2 = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }
        if self.pos == s2 {
            // Not `digit:digit` — could be `1:A1` or similar nonsense.
            // Roll back. Note: the parser doesn't currently accept
            // anything else starting with `<digits>:`, so this is a
            // simple failure mode (returns None and parse fails).
            self.pos = save;
            return None;
        }
        let second: String = self.chars[s2..self.pos].iter().collect();
        // After the second digit run we must NOT be followed by letters
        // — that would mean the user wrote `1:A1`, which isn't a valid
        // construct in either bounded or unbounded range syntax.
        if self
            .peek()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
        {
            self.pos = save;
            return None;
        }

        let start_row: u32 = first.parse().ok()?;
        let end_row: u32 = second.parse().ok()?;
        if start_row == 0 || end_row == 0 {
            // Excel rows are 1-based; reject `0:0`.
            self.pos = save;
            return None;
        }
        let _ = colon_at;
        Some(Expr::Range {
            start: CellAddress::new(start_row - 1, 0),
            end: CellAddress::new(end_row - 1, u32::MAX),
            unbounded: RangeBounds::Cols,
        })
    }

    fn parse_number(&mut self) -> Option<Expr> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' {
                self.advance();
            } else {
                break;
            }
        }
        let s: String = self.chars[start..self.pos].iter().collect();
        let n: f64 = s.parse().ok()?;
        Some(Expr::Number(n))
    }

    fn parse_string(&mut self) -> Option<Expr> {
        self.advance(); // skip opening "
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c == '"' {
                let s: String = self.chars[start..self.pos].iter().collect();
                self.advance(); // skip closing "
                return Some(Expr::Text(s));
            }
            self.advance();
        }
        None // unterminated string
    }

    /// Identifier: could be a function name (followed by '(') or a cell reference.
    ///
    /// We allow `.` between identifier chars so Excel 2010+ dotted function
    /// names like `RANK.EQ` / `STDEV.P` / `PERCENTILE.INC` parse as a single
    /// name. The rule: after the first alpha char, accept
    /// `[A-Za-z0-9_]`. A `.` is only consumed when the very next char is
    /// itself a valid identifier char (alpha / digit / underscore) — this
    /// keeps a trailing `RANK.` from being absorbed (the `.` is left for
    /// the caller, which will then fail to parse the formula), and
    /// `RANK..EQ` won't be eaten as one identifier either. Numbers like
    /// `1.5` route through `parse_number` instead, because identifiers
    /// must start with an alpha char — so the decimal-separator role of
    /// `.` is unaffected.
    fn parse_identifier(&mut self) -> Option<Expr> {
        let start = self.pos;
        // Read alphanumerics + underscore. Allow '.' only when followed by
        // another identifier char (see doc above).
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == '_' {
                self.advance();
            } else if c == '.' {
                match self.peek_at(1) {
                    Some(next) if next.is_ascii_alphanumeric() || next == '_' => {
                        self.advance();
                    }
                    _ => break,
                }
            } else {
                break;
            }
        }
        let ident: String = self.chars[start..self.pos].iter().collect();

        self.skip_whitespace();

        // Check for TRUE / FALSE literals (case-insensitive). Excel treats
        // these as bare identifiers (no parens needed) — they shouldn't be
        // tried as cell addresses or function names.
        let upper = ident.to_ascii_uppercase();
        if upper == "TRUE" {
            return Some(Expr::Bool(true));
        }
        if upper == "FALSE" {
            return Some(Expr::Bool(false));
        }

        // Check if it's a function call
        if self.peek() == Some('(') {
            self.advance(); // skip '('
            let args = self.parse_func_args()?;
            self.expect(')')?;
            return Some(Expr::FuncCall {
                name: ident.to_ascii_uppercase(),
                args,
            });
        }

        // Check for cross-sheet reference: `Name!A1` / `Name!A1:B3`
        // (Excel syntax).
        // The bang `!` unambiguously marks the preceding identifier as a
        // sheet name — it's not a token in any other formula context. The
        // identifier ALWAYS becomes a sheet name when '!' follows, even if
        // the same chars would also parse as a cell address.
        if self.peek() == Some('!') {
            self.advance(); // skip '!'
            let addr_start = self.pos;
            while let Some(c) = self.peek() {
                if c.is_ascii_alphanumeric() {
                    self.advance();
                } else {
                    break;
                }
            }
            let addr_str: String = self.chars[addr_start..self.pos].iter().collect();
            let addr = CellAddress::parse(&addr_str)?;
            self.skip_whitespace();
            if self.peek() == Some(':') {
                self.advance();
                self.skip_whitespace();
                let end_start = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let end_str: String = self.chars[end_start..self.pos].iter().collect();
                let end = CellAddress::parse(&end_str)?;
                return Some(Expr::SheetRange {
                    sheet: ident,
                    start: addr,
                    end,
                    unbounded: RangeBounds::None,
                });
            }
            return Some(Expr::SheetRef { sheet: ident, addr });
        }

        // Check if it's a cell reference (with possible range)
        if let Some(addr) = CellAddress::parse(&ident) {
            self.skip_whitespace();
            // Check for range operator ':'
            if self.peek() == Some(':') {
                self.advance();
                self.skip_whitespace();
                let range_start = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let end_ident: String = self.chars[range_start..self.pos].iter().collect();
                let end_addr = CellAddress::parse(&end_ident)?;
                return Some(Expr::Range {
                    start: addr,
                    end: end_addr,
                    unbounded: RangeBounds::None,
                });
            }
            return Some(Expr::CellRef(addr));
        }

        // Whole-column range: `A:A` / `A:C`. The identifier is all letters
        // and is followed by ':' + another all-letters identifier. The
        // column part of `CellAddress::parse("A1")` is what we want, so
        // we synthesize a `<col>1` string to reuse the parser.
        if ident.chars().all(|c| c.is_ascii_alphabetic()) && self.peek() == Some(':') {
            let save = self.pos;
            self.advance(); // consume ':'
            self.skip_whitespace();
            let end_start = self.pos;
            while let Some(c) = self.peek() {
                if c.is_ascii_alphabetic() {
                    self.advance();
                } else {
                    break;
                }
            }
            let end_letters: String = self.chars[end_start..self.pos].iter().collect();
            // The right side must be ALL letters AND not be followed by a
            // digit (which would make it a cell address like `B3`). If
            // either condition fails, roll back so the identifier-as-
            // cell-address path can try again — though `CellAddress::
            // parse(letters_only)` already returned None above, so the
            // identifier branch will fall through to `None` like before.
            if !end_letters.is_empty() && self.peek().map(|c| !c.is_ascii_digit()).unwrap_or(true) {
                let start_col = CellAddress::parse(&format!("{}1", ident))?.col;
                let end_col = CellAddress::parse(&format!("{}1", end_letters))?.col;
                return Some(Expr::Range {
                    start: CellAddress::new(0, start_col),
                    end: CellAddress::new(u32::MAX, end_col),
                    unbounded: RangeBounds::Rows,
                });
            }
            // Roll back — letters:digits isn't valid here (that's the
            // already-handled `A1:B2` path).
            self.pos = save;
        }

        None // unknown identifier
    }

    fn parse_func_args(&mut self) -> Option<Vec<Expr>> {
        let mut args = Vec::new();
        self.skip_whitespace();

        if self.peek() == Some(')') {
            return Some(args); // no args
        }

        // First try to parse range-aware args
        args.push(self.parse_func_arg()?);

        loop {
            self.skip_whitespace();
            if self.peek() == Some(',') {
                self.advance();
                args.push(self.parse_func_arg()?);
            } else {
                break;
            }
        }
        Some(args)
    }

    fn parse_func_arg(&mut self) -> Option<Expr> {
        // Function args can be regular expressions (which include ranges in identifiers)
        self.parse_expr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_number() {
        assert_eq!(parse_formula("=42"), Some(Expr::Number(42.0)));
    }

    #[test]
    fn parse_decimal() {
        assert_eq!(parse_formula("=3.14"), Some(Expr::Number(3.14)));
    }

    #[test]
    fn parse_cell_ref() {
        assert_eq!(
            parse_formula("=A1"),
            Some(Expr::CellRef(CellAddress::new(0, 0)))
        );
    }

    #[test]
    fn parse_addition() {
        assert_eq!(
            parse_formula("=A1+B1"),
            Some(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
            })
        );
    }

    #[test]
    fn parse_multiplication_before_addition() {
        // =A1+B1*2 should be A1 + (B1 * 2)
        let result = parse_formula("=A1+B1*2").unwrap();
        assert_eq!(
            result,
            Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                right: Box::new(Expr::BinOp {
                    op: BinOperator::Mul,
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
                    right: Box::new(Expr::Number(2.0)),
                }),
            }
        );
    }

    #[test]
    fn parse_parentheses() {
        // =(A1+B1)*2
        let result = parse_formula("=(A1+B1)*2").unwrap();
        assert_eq!(
            result,
            Expr::BinOp {
                op: BinOperator::Mul,
                left: Box::new(Expr::BinOp {
                    op: BinOperator::Add,
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                    right: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
                }),
                right: Box::new(Expr::Number(2.0)),
            }
        );
    }

    #[test]
    fn parse_negation() {
        assert_eq!(
            parse_formula("=-A1"),
            Some(Expr::Negate(Box::new(Expr::CellRef(CellAddress::new(
                0, 0
            )))))
        );
    }

    #[test]
    fn parse_division() {
        assert_eq!(
            parse_formula("=A1/B1"),
            Some(Expr::BinOp {
                op: BinOperator::Div,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
            })
        );
    }

    #[test]
    fn parse_spaces() {
        assert_eq!(
            parse_formula("= A1 + B1 "),
            Some(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
            })
        );
    }

    #[test]
    fn parse_func_call() {
        let result = parse_formula("=SUM(A1,B1)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![
                    Expr::CellRef(CellAddress::new(0, 0)),
                    Expr::CellRef(CellAddress::new(0, 1)),
                ],
            }
        );
    }

    #[test]
    fn parse_func_call_case_insensitive() {
        let result = parse_formula("=sum(A1)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::CellRef(CellAddress::new(0, 0))],
            }
        );
    }

    #[test]
    fn parse_range() {
        let result = parse_formula("=SUM(A1:B3)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(2, 1),
                    unbounded: RangeBounds::None,
                }],
            }
        );
    }

    #[test]
    fn parse_whole_col_range() {
        // `A:A` — start row sentinel 0, end row sentinel u32::MAX,
        // both cols pointing at column A (col index 0).
        let result = parse_formula("=SUM(A:A)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(u32::MAX, 0),
                    unbounded: RangeBounds::Rows,
                }],
            }
        );
    }

    #[test]
    fn parse_whole_col_range_multi_col() {
        // `A:C` — three columns wide, every row.
        let result = parse_formula("=SUM(A:C)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(u32::MAX, 2),
                    unbounded: RangeBounds::Rows,
                }],
            }
        );
    }

    #[test]
    fn parse_whole_row_range() {
        // `1:1` — row 1 (0-based row 0), every column.
        let result = parse_formula("=SUM(1:1)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(0, u32::MAX),
                    unbounded: RangeBounds::Cols,
                }],
            }
        );
    }

    #[test]
    fn parse_whole_row_range_multi_row() {
        // `1:3` — rows 1 through 3, every column.
        let result = parse_formula("=SUM(1:3)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(2, u32::MAX),
                    unbounded: RangeBounds::Cols,
                }],
            }
        );
    }

    #[test]
    fn parse_whole_col_range_bare_expr() {
        // `=A:A` (no wrapper function) is valid range syntax. The
        // standalone Range expression evaluates to InvalidValue at the
        // top level (per eval_expr_with_provider), but it must parse.
        let result = parse_formula("=A:A").unwrap();
        assert!(matches!(
            result,
            Expr::Range {
                unbounded: RangeBounds::Rows,
                ..
            }
        ));
    }

    #[test]
    fn parse_complex_formula() {
        // =(A1+B1)/2
        let result = parse_formula("=(A1+B1)/2").unwrap();
        assert_eq!(
            result,
            Expr::BinOp {
                op: BinOperator::Div,
                left: Box::new(Expr::BinOp {
                    op: BinOperator::Add,
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 0))),
                    right: Box::new(Expr::CellRef(CellAddress::new(0, 1))),
                }),
                right: Box::new(Expr::Number(2.0)),
            }
        );
    }

    #[test]
    fn parse_no_equals_returns_none() {
        assert!(parse_formula("A1+B1").is_none());
    }

    #[test]
    fn parse_empty_returns_none() {
        assert!(parse_formula("=").is_none());
    }

    #[test]
    fn parse_string_literal() {
        assert_eq!(
            parse_formula("=\"hello\""),
            Some(Expr::Text("hello".into()))
        );
    }

    #[test]
    fn parse_cross_sheet_ref() {
        let result = parse_formula("=Sheet2!A1").unwrap();
        assert_eq!(
            result,
            Expr::SheetRef {
                sheet: "Sheet2".into(),
                addr: CellAddress::new(0, 0),
            }
        );
    }

    #[test]
    fn parse_cross_sheet_range() {
        let result = parse_formula("=SUM(Sheet2!A1:A100)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::SheetRange {
                    sheet: "Sheet2".into(),
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(99, 0),
                    unbounded: RangeBounds::None,
                }],
            }
        );
    }

    #[test]
    fn parse_cross_sheet_range_rejects_missing_end() {
        assert!(parse_formula("=SUM(Sheet2!A1:)").is_none());
    }

    #[test]
    fn parse_cross_sheet_in_expression() {
        // Cross-sheet ref inside a binop. Sheet2!A1 + 5
        let result = parse_formula("=Sheet2!A1+5").unwrap();
        assert_eq!(
            result,
            Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::SheetRef {
                    sheet: "Sheet2".into(),
                    addr: CellAddress::new(0, 0),
                }),
                right: Box::new(Expr::Number(5.0)),
            }
        );
    }

    #[test]
    fn cell_address_takes_precedence_over_sheet_ref() {
        // `A1` alone is a cell ref, not a sheet name. The bang disambiguates.
        let result = parse_formula("=A1").unwrap();
        assert!(matches!(result, Expr::CellRef(_)));
    }

    #[test]
    fn parse_dotted_func_name() {
        // Excel 2010+ dotted aliases like RANK.EQ must parse as a single
        // function name (the dot is part of the identifier, not a stray
        // token between two refs).
        let result = parse_formula("=RANK.EQ(1,A1:A3)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "RANK.EQ".into(),
                args: vec![
                    Expr::Number(1.0),
                    Expr::Range {
                        start: CellAddress::new(0, 0),
                        end: CellAddress::new(2, 0),
                        unbounded: RangeBounds::None,
                    },
                ],
            }
        );
    }

    #[test]
    fn parse_dotted_func_name_multi_dot() {
        // PERCENTILE.INC is the canonical 2010+ rename of PERCENTILE.
        let result = parse_formula("=PERCENTILE.INC(A1:A3,0.5)").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "PERCENTILE.INC".into(),
                args: vec![
                    Expr::Range {
                        start: CellAddress::new(0, 0),
                        end: CellAddress::new(2, 0),
                        unbounded: RangeBounds::None,
                    },
                    Expr::Number(0.5),
                ],
            }
        );
    }

    #[test]
    fn parse_decimal_regression() {
        // The dotted-identifier rule must NOT break decimal numbers, which
        // are routed through `parse_number` because identifiers must start
        // with an alpha char.
        assert_eq!(parse_formula("=1.5"), Some(Expr::Number(1.5)));
        assert_eq!(parse_formula("=0.25"), Some(Expr::Number(0.25)));
    }

    #[test]
    fn parse_trailing_dot_in_identifier_rejected() {
        // `RANK.` (trailing dot with no continuation) must NOT parse as an
        // identifier called `RANK.`. The parser stops before the `.`,
        // leaving it for the caller — there's nothing else `.` can be at
        // the start of a token, so the formula as a whole fails to parse.
        assert!(parse_formula("=RANK.").is_none());
        // Even inside a function-call expression, the lone dot is fatal:
        assert!(parse_formula("=RANK.(1,A1:A3)").is_none());
    }

    #[test]
    fn parse_consecutive_dots_in_identifier_rejected() {
        // `RANK..EQ` — the second dot has no preceding identifier char so
        // the rule stops the identifier at `RANK` and the second `.` is
        // not consumed → formula fails to parse.
        assert!(parse_formula("=RANK..EQ(1,A1:A3)").is_none());
    }

    #[test]
    fn parse_nested_func() {
        let result = parse_formula("=SUM(A1,SUM(B1,C1))").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![
                    Expr::CellRef(CellAddress::new(0, 0)),
                    Expr::FuncCall {
                        name: "SUM".into(),
                        args: vec![
                            Expr::CellRef(CellAddress::new(0, 1)),
                            Expr::CellRef(CellAddress::new(0, 2)),
                        ],
                    },
                ],
            }
        );
    }
}
