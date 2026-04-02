use crate::cell::CellAddress;

/// AST node for a formula expression.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// A literal number, e.g. 42, 3.14
    Number(f64),
    /// A literal string, e.g. "hello"
    Text(String),
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
    FuncCall {
        name: String,
        args: Vec<Expr>,
    },
    /// Cell range: A1:B3 (for function args)
    Range {
        start: CellAddress,
        end: CellAddress,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinOperator {
    Add,
    Sub,
    Mul,
    Div,
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

    /// expr = term (('+' | '-') term)*
    fn parse_expr(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_term()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('+') => {
                    self.advance();
                    let right = self.parse_term()?;
                    left = Expr::BinOp {
                        op: BinOperator::Add,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('-') => {
                    self.advance();
                    let right = self.parse_term()?;
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

    /// term = unary (('*' | '/') unary)*
    fn parse_term(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_unary()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') => {
                    self.advance();
                    let right = self.parse_unary()?;
                    left = Expr::BinOp {
                        op: BinOperator::Mul,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('/') => {
                    self.advance();
                    let right = self.parse_unary()?;
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
