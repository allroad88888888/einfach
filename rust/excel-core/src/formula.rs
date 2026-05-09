use crate::cell::CellAddress;

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
    /// Cell range: A1:B3 (for function args)
    Range {
        start: CellAddress,
        end: CellAddress,
    },
    /// Cross-sheet reference: `Sheet1!A1`. Resolution requires a Workbook
    /// scope at eval time; standalone Sheet eval treats it as #REF!.
    SheetRef { sheet: String, addr: CellAddress },
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
            c if c.is_ascii_digit() || c == '.' => self.parse_number(),
            c if c.is_ascii_alphabetic() => self.parse_identifier(),
            _ => None,
        }
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
    fn parse_identifier(&mut self) -> Option<Expr> {
        let start = self.pos;
        // Read alphanumeric chars
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() {
                self.advance();
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

        // Check for cross-sheet reference: `Name!A1` (Excel syntax).
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
                });
            }
            return Some(Expr::CellRef(addr));
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
                }],
            }
        );
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
