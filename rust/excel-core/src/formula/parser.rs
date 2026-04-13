use einfach_core::ValueError;

use crate::cell::CellReference;

use super::{BinOperator, Expr};

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
        return None;
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
        self.parse_comparison()
    }

    /// comparison = concat (('=' | '<>' | '<' | '<=' | '>' | '>=') concat)?
    fn parse_comparison(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_concat()?;

        loop {
            self.skip_whitespace();
            let op = if self.starts_with("<=") {
                self.pos += 2;
                Some(BinOperator::LessOrEqual)
            } else if self.starts_with(">=") {
                self.pos += 2;
                Some(BinOperator::GreaterOrEqual)
            } else if self.starts_with("<>") {
                self.pos += 2;
                Some(BinOperator::NotEqual)
            } else if self.peek() == Some('<') {
                self.advance();
                Some(BinOperator::Less)
            } else if self.peek() == Some('>') {
                self.advance();
                Some(BinOperator::Greater)
            } else if self.peek() == Some('=') {
                self.advance();
                Some(BinOperator::Equal)
            } else {
                None
            };

            let Some(op) = op else {
                break;
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

    /// concat = add_sub ('&' add_sub)*
    fn parse_concat(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_add_sub()?;

        loop {
            self.skip_whitespace();
            if self.peek() != Some('&') {
                break;
            }
            self.advance();
            let right = self.parse_add_sub()?;
            left = Expr::BinOp {
                op: BinOperator::Concat,
                left: Box::new(left),
                right: Box::new(right),
            };
        }

        Some(left)
    }

    /// add_sub = term (('+' | '-') term)*
    fn parse_add_sub(&mut self) -> Option<Expr> {
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

    /// term = power (('*' | '/') power)*
    fn parse_term(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let mut left = self.parse_power()?;

        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') => {
                    self.advance();
                    let right = self.parse_power()?;
                    left = Expr::BinOp {
                        op: BinOperator::Mul,
                        left: Box::new(left),
                        right: Box::new(right),
                    };
                }
                Some('/') => {
                    self.advance();
                    let right = self.parse_power()?;
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

    /// power = unary ('^' power)?
    fn parse_power(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        let left = self.parse_unary()?;

        self.skip_whitespace();
        if self.peek() == Some('^') {
            self.advance();
            let right = self.parse_power()?;
            return Some(Expr::BinOp {
                op: BinOperator::Power,
                left: Box::new(left),
                right: Box::new(right),
            });
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
            '#' => self.parse_error_literal(),
            c if c.is_ascii_digit() || c == '.' => self.parse_number(),
            c if c.is_ascii_alphabetic() || c == '$' => self.parse_identifier_or_reference(),
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
        self.advance();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c == '"' {
                let s: String = self.chars[start..self.pos].iter().collect();
                self.advance();
                return Some(Expr::Text(s));
            }
            self.advance();
        }
        None
    }

    fn parse_error_literal(&mut self) -> Option<Expr> {
        const ERRORS: [(&str, ValueError); 5] = [
            ("#DIV/0!", ValueError::DivisionByZero),
            ("#REF!", ValueError::InvalidRef),
            ("#VALUE!", ValueError::InvalidValue),
            ("#NAME?", ValueError::InvalidName),
            ("#CYCLE!", ValueError::CyclicRef),
        ];

        for (text, error) in ERRORS {
            if self.starts_with(text) {
                self.pos += text.chars().count();
                return Some(Expr::Error(error));
            }
        }

        None
    }

    /// Identifier: could be a function name (followed by '(') or a cell reference.
    fn parse_identifier_or_reference(&mut self) -> Option<Expr> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == '$' || c == '_' {
                self.advance();
            } else {
                break;
            }
        }
        let ident: String = self.chars[start..self.pos].iter().collect();

        self.skip_whitespace();

        if self.peek() == Some('!') {
            self.advance();
            self.skip_whitespace();
            let ref_start = self.pos;
            while let Some(c) = self.peek() {
                if c.is_ascii_alphanumeric() || c == '$' {
                    self.advance();
                } else {
                    break;
                }
            }
            let ref_ident: String = self.chars[ref_start..self.pos].iter().collect();
            let mut reference = CellReference::parse(&ref_ident)?;
            reference.sheet_name = Some(ident.clone());

            self.skip_whitespace();
            if self.peek() == Some(':') {
                self.advance();
                self.skip_whitespace();
                let range_start = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() || c == '$' {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let end_ident: String = self.chars[range_start..self.pos].iter().collect();
                let mut end_reference = CellReference::parse(&end_ident)?;
                end_reference.sheet_name = Some(ident);
                return Some(Expr::Range {
                    start: reference,
                    end: end_reference,
                });
            }

            return Some(Expr::CellRef(reference));
        }

        if self.peek() == Some('(') {
            self.advance();
            let args = self.parse_func_args()?;
            self.expect(')')?;
            return Some(Expr::FuncCall {
                name: ident.to_ascii_uppercase(),
                args,
            });
        }

        match ident.to_ascii_uppercase().as_str() {
            "TRUE" => return Some(Expr::Boolean(true)),
            "FALSE" => return Some(Expr::Boolean(false)),
            _ => {}
        }

        if let Some(reference) = CellReference::parse(&ident) {
            self.skip_whitespace();
            if self.peek() == Some(':') {
                self.advance();
                self.skip_whitespace();
                let range_start = self.pos;
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() || c == '$' {
                        self.advance();
                    } else {
                        break;
                    }
                }
                let end_ident: String = self.chars[range_start..self.pos].iter().collect();
                let end_reference = CellReference::parse(&end_ident)?;
                return Some(Expr::Range {
                    start: reference,
                    end: end_reference,
                });
            }
            return Some(Expr::CellRef(reference));
        }

        None
    }

    fn starts_with(&self, pattern: &str) -> bool {
        let pattern_chars: Vec<char> = pattern.chars().collect();
        self.chars[self.pos..].starts_with(&pattern_chars)
    }

    fn parse_func_args(&mut self) -> Option<Vec<Expr>> {
        let mut args = Vec::new();
        self.skip_whitespace();

        if self.peek() == Some(')') {
            return Some(args);
        }

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
        self.parse_expr()
    }
}
