use crate::cell::CellAddress;
use einfach_core::ValueError;

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
/// Dependency registration retains a canonical `CellRange` covering the
/// entire sheet on the unbounded axis. Formula evaluation maps it to lazy
/// Store geometry roots without expanding the coordinate space.
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

/// Which horizontal band of a Table an `Expr::TableRef` selects (design doc
/// #32 §5.1 `special`). The `#special` keyword — or its absence — maps to
/// one of these at parse time; the evaluator turns the band + the table's
/// registry geometry into a concrete row range (§5.3).
///
/// - `All` — every row (header + data + totals). Syntax `Table1[#All]`.
/// - `Data` — data rows only (the parser's default when a bare column or
///   segment is given, e.g. `Table1[Col]`). Syntax `Table1[#Data]`.
/// - `Headers` — the header row. Syntax `Table1[#Headers]`.
/// - `Totals` — the totals row (evaluates to `#REF!` when the table has
///   no totals row). Syntax `Table1[#Totals]`.
/// - `ThisRow` — the intersection of the referencing formula's own row
///   with the table's data area. Syntax `[@Col]`, `Table1[@Col]`, or
///   `Table1[#This Row]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableArea {
    All,
    Data,
    Headers,
    Totals,
    ThisRow,
}

/// Absolute-reference markers for one address as it is WRITTEN in a formula
/// (`$A$1`). Each axis pins independently: `$A1` pins the column, `A$1` pins
/// the row, `$A$1` pins both, `A1` pins neither (`RefAbs::REL`, the
/// `Default`).
///
/// Absoluteness is purely a written form. It NEVER changes how a reference
/// evaluates — `$A$1` and `A1` read the same cell — and it NEVER changes how
/// structural row/column inserts/deletes move the address: Excel shifts
/// `$A$5` to `$A$6` on a row insert, exactly like `A5`. The flags ride along
/// with the address through `shift`/`map_addrs` so the `$` survives shifts
/// and text round-trips. Drag-fill's pin-on-fill semantics are a host
/// concern (TS clipboard layer) and deliberately NOT modeled here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct RefAbs {
    /// Column pinned with a leading `$` (`$A1`).
    pub col: bool,
    /// Row pinned with a `$` before the row number (`A$1`).
    pub row: bool,
}

impl RefAbs {
    /// Fully relative (`A1`) — the overwhelmingly common case and the
    /// `Default`.
    pub const REL: RefAbs = RefAbs {
        col: false,
        row: false,
    };
    /// Fully absolute (`$A$1`).
    pub const ABS: RefAbs = RefAbs {
        col: true,
        row: true,
    };
    pub fn new(col: bool, row: bool) -> Self {
        RefAbs { col, row }
    }
}

/// Absolute-reference markers for the two corners of a range (`$A$1:$B$2`).
/// The corners are independent, so mixed forms like `$A1:B$2` are
/// representable. `Default` / `RangeAbs::REL` is both corners relative.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct RangeAbs {
    pub start: RefAbs,
    pub end: RefAbs,
}

impl RangeAbs {
    /// Both corners relative (`A1:B2`).
    pub const REL: RangeAbs = RangeAbs {
        start: RefAbs::REL,
        end: RefAbs::REL,
    };
    pub fn new(start: RefAbs, end: RefAbs) -> Self {
        RangeAbs { start, end }
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
    /// Literal Excel error token, e.g. `#N/A`, `#VALUE!`, `#CALC!`.
    Error(ValueError),
    /// A cell reference, e.g. `A1`, `$A$1`, `$A1`, `A$1`. The `RefAbs`
    /// records which axes were written with a `$`; it does not affect eval.
    CellRef(CellAddress, RefAbs),
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
        /// Per-corner `$` markers (`$A$1:$B$2`, `$A1:B$2`, ...). Purely a
        /// written form; does not affect eval or how corners shift.
        abs: RangeAbs,
    },
    /// Cross-sheet reference: `Sheet1!A1`. Resolution requires a Workbook
    /// scope at eval time; standalone Sheet eval treats it as #REF!.
    SheetRef {
        sheet: String,
        addr: CellAddress,
        abs: RefAbs,
    },
    /// Cross-sheet range: `Sheet1!A1:B3`. Kept distinct from `Range` so
    /// sheet-local dependency walkers never register the source addresses on
    /// the formula's own sheet.
    SheetRange {
        sheet: String,
        start: CellAddress,
        end: CellAddress,
        unbounded: RangeBounds,
        abs: RangeAbs,
    },
    /// Dynamic-array spill reference: `A1#` / `Sheet1!A1#`. The anchor is
    /// restricted to a single-cell reference at parse time.
    SpillRef(Box<Expr>),
    /// Range operator with a reference-returning expression endpoint, e.g.
    /// `A1:INDEX(A:A,3)`. Static `A1:B2` stays as `Expr::Range`.
    DynamicRange { start: Box<Expr>, end: Box<Expr> },
    /// A bare identifier that doesn't parse as a cell ref, function call,
    /// or boolean literal — e.g. `x` in `LET(x, 5, x*x)`. The evaluator
    /// resolves the name against the current LET scope (and, in future,
    /// named ranges); otherwise it surfaces `#NAME?`.
    Name(String),
    /// Immediate application of a computed callee — produced by trailing
    /// `(args)` on a non-identifier primary. The canonical case is
    /// `=LAMBDA(x, x*x)(5)`: `LAMBDA(...)` parses as a `FuncCall` and
    /// the trailing `(5)` wraps it in a `Call`. The evaluator evaluates
    /// the callee (must yield `Value::Lambda`), then applies it to the
    /// argument values.
    ///
    /// Why a separate variant rather than reusing `FuncCall` with a
    /// computed name? `FuncCall` carries a `String` (always upper-cased
    /// built-in name); the callee here is an arbitrary expression that
    /// resolves to a lambda value at runtime. Keeping them distinct
    /// means parser and eval stay simple and existing `FuncCall`
    /// dispatch keeps O(1).
    Call(Box<Expr>, Vec<Expr>),
    /// Excel constant-array literal: `={1,2,3;4,5,6}`. `,` separates
    /// columns, `;` separates rows. `data` is row-major, so the cell at
    /// `(row, col)` lives at `data[row * cols + col]`. The parser
    /// restricts cell expressions to literals (numbers, text, booleans,
    /// errors, or `Negate(Number)` for signed numerics); cell refs, function
    /// calls, ranges, etc. inside the literal are a parse error — those
    /// are not the Excel constant-array form. Eval lowers this directly
    /// to `Value::Array`.
    ArrayLit {
        rows: u32,
        cols: u32,
        data: Vec<Expr>,
    },
    /// Excel multi-area (union) reference: `(A1:B2, D5:E6, F1)`. Each
    /// inner expression is itself a reference (`CellRef`, `Range`,
    /// `SheetRef`, or `SheetRange`) — arbitrary expressions are
    /// rejected at parse time (a `(A1, 1+2)` shape is a parse error,
    /// not a `MultiArea`). The parser only emits this when ≥ 2 refs are
    /// separated by commas inside parentheses; `(A1:B2)` is just the
    /// grouped single ref `A1:B2`.
    ///
    /// Eval contract: `Expr::MultiArea` doesn't reduce to a scalar
    /// `Value`. The bare expression yields `#VALUE!` and built-ins that
    /// take a single range argument (SUM, AVERAGE, INDEX, ...) also
    /// surface `#VALUE!`. The only consumer that handles it as data is
    /// `AREAS`, which counts the parts. Future work may extend SUMIF /
    /// COUNTIF criteria-range handling.
    MultiArea(Vec<Expr>),
    /// Structured (Excel Table) reference: `Table1[Col]`, `[@Col]`,
    /// `Table1[#Headers]`, `Table1[[ColA]:[ColB]]`, etc. (design doc #32
    /// §5.1 / §5.2). The node is resolved to a concrete `SheetRange` at
    /// eval time against the workbook's Table registry (§5.3) — the AST
    /// carries NO A1 coordinates, so structural edits follow it through
    /// the registry rather than by rewriting this node.
    ///
    /// - `table` — `Some(name)` for `Table1[...]`; `None` for a table-less
    ///   `[Col]` / `[@Col]` written inside a table's own cells, where the
    ///   evaluator locates the containing table from the current cell.
    /// - `area` — which horizontal band (see [`TableArea`]).
    /// - `columns` — `None` for the whole area (`Table1[#All]`); `Some((a,
    ///   a))` for a single column; `Some((a, b))` for a `[ColA]:[ColB]`
    ///   segment. Column names are matched case-insensitively at eval time.
    TableRef {
        table: Option<String>,
        area: TableArea,
        columns: Option<(String, String)>,
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

/// Cell-expression check for `Expr::ArrayLit` elements. Excel restricts
/// constant-array entries to literal values; we accept exactly the four
/// shapes that can appear in the parsed source for such a literal:
///
/// - `Expr::Number(_)` — `1`, `3.14`, etc.
/// - `Expr::Text(_)` — `"foo"`.
/// - `Expr::Bool(_)` — `TRUE` / `FALSE`.
/// - `Expr::Error(_)` — `#N/A`, `#VALUE!`, etc.
/// - `Expr::Negate(inner)` where `inner` is a `Number`.
///
/// Cell refs, function calls, ranges, names, and binops are rejected.
fn is_valid_array_lit_element(expr: &Expr) -> bool {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => true,
        Expr::Negate(inner) => matches!(inner.as_ref(), Expr::Number(_)),
        _ => false,
    }
}

/// Does `expr` denote a reference (the only thing allowed inside a
/// multi-area `(A1:B2, D5:E6)` reference)? Accepts same-sheet and
/// cross-sheet cell refs and ranges. Everything else — literals,
/// binops, function calls, nested multi-area — is rejected.
fn is_ref_expr(expr: &Expr) -> bool {
    matches!(
        expr,
        Expr::CellRef(..)
            | Expr::Range { .. }
            | Expr::SheetRef { .. }
            | Expr::SheetRange { .. }
            | Expr::SpillRef(_)
            | Expr::DynamicRange { .. }
    )
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

    /// unary = '-' unary | primary call_suffix
    ///
    /// `call_suffix` chains trailing `(args)` onto the primary so
    /// `=LAMBDA(x, x*x)(5)` parses as `Call(FuncCall("LAMBDA", ...), [5])`
    /// — immediate-application of an inline lambda. Multiple chained
    /// applications (`=f()()()`) iterate the loop; if no `(` follows,
    /// the primary is returned untouched.
    fn parse_unary(&mut self) -> Option<Expr> {
        self.skip_whitespace();
        if self.peek() == Some('-') {
            self.advance();
            let expr = self.parse_unary()?;
            Some(Expr::Negate(Box::new(expr)))
        } else {
            let primary = self.parse_primary()?;
            let called = self.parse_call_suffix(primary)?;
            self.parse_spill_suffix(called)
        }
    }

    fn parse_spill_suffix(&mut self, mut expr: Expr) -> Option<Expr> {
        loop {
            self.skip_whitespace();
            if self.peek() != Some('#') {
                return Some(expr);
            }
            if !matches!(expr, Expr::CellRef(..) | Expr::SheetRef { .. }) {
                return None;
            }
            self.advance();
            expr = Expr::SpillRef(Box::new(expr));
        }
    }

    /// After parsing a primary, consume any trailing `(args)` chain and
    /// wrap the callee in `Expr::Call`. A trailing `(` is only treated
    /// as a call if the parsed callee CAN produce a callable value —
    /// we lean conservative and accept it on any `FuncCall` / `Name` /
    /// `Call` callee (the cases that can resolve to a lambda). This
    /// avoids `=A1(5)` (where A1 is a cell ref) being mis-parsed as a
    /// call when the user meant `A1 *... *(5)` etc.; the parser already
    /// requires `*` for that case so the ambiguity is moot, but the
    /// guard keeps the surface tight in case future primaries appear.
    fn parse_call_suffix(&mut self, mut callee: Expr) -> Option<Expr> {
        loop {
            self.skip_whitespace();
            if self.peek() != Some('(') {
                return Some(callee);
            }
            // Only callees that could plausibly be a lambda value get the
            // trailing-call treatment. Cell refs / literals / ranges
            // can't, and accepting them would shadow legitimate parse
            // failures with confusing "Call(CellRef(A1), …)" nodes.
            if !matches!(
                callee,
                Expr::FuncCall { .. } | Expr::Name(_) | Expr::Call(_, _)
            ) {
                return Some(callee);
            }
            self.advance(); // consume '('
            let args = self.parse_func_args()?;
            self.expect(')')?;
            callee = Expr::Call(Box::new(callee), args);
        }
    }

    /// primary = number | string | error | func_call | cell_ref_or_range | '(' expr ')' | '{' array_lit '}'
    fn parse_primary(&mut self) -> Option<Expr> {
        self.skip_whitespace();

        match self.peek()? {
            '(' => {
                // Two surface forms share the `(` opener:
                //   1. Grouped expression: `(A1+B1)`, `(1+2)`, `(A1:B2)`.
                //   2. Multi-area reference: `(A1:B2, D5:E6, F1)` — Excel's
                //      union/list-of-areas syntax, consumed by AREAS (and
                //      some criteria-style aggregates in advanced Excel).
                //
                // Speculative parse: consume `(`, parse one inner expr,
                // then peek for `,`. If we see a comma AND the inner expr
                // is a reference (CellRef / Range / SheetRef / SheetRange),
                // commit to multi-area parsing — every remaining element
                // must also be a reference. Otherwise the inner expr is
                // just the body of a grouped expression and `)` follows.
                //
                // A `(A1, 1+2)` shape (ref then non-ref) is a parse error
                // — it can't be a grouped expression (no operator between
                // refs) and can't be a multi-area reference (non-ref
                // element). Returning `None` here surfaces as a top-level
                // parse failure.
                self.advance();
                let first = self.parse_expr()?;
                self.skip_whitespace();
                if self.peek() == Some(',') {
                    // Multi-area path: first element MUST be a ref.
                    if !is_ref_expr(&first) {
                        return None;
                    }
                    let mut parts: Vec<Expr> = vec![first];
                    while self.peek() == Some(',') {
                        self.advance();
                        self.skip_whitespace();
                        let next = self.parse_expr()?;
                        if !is_ref_expr(&next) {
                            return None;
                        }
                        parts.push(next);
                        self.skip_whitespace();
                    }
                    self.expect(')')?;
                    Some(Expr::MultiArea(parts))
                } else {
                    // Grouped expression — strip the parens.
                    self.expect(')')?;
                    Some(first)
                }
            }
            '{' => self.parse_array_literal(),
            '"' => self.parse_string(),
            '#' => self.parse_error_literal(),
            // Table-less structured reference: `[Col]` / `[@Col]` written
            // inside a Table's own cells. `[` has no other lexical role, so
            // a leading `[` at primary position is unambiguously a
            // structured reference whose table is resolved from the current
            // cell at eval time (design doc §5.1 `tableref` alt).
            '[' => self.parse_table_ref_body(None),
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
            // A leading `$` unambiguously introduces a reference — no other
            // formula token starts with `$` (sheet names, function names, and
            // bare Names never carry one). Cover column-absolute cell refs
            // (`$A$1`, `$A1`), absolute whole-column ranges (`$A:$C`), and
            // absolute whole-row ranges (`$1:$3`).
            '$' => self.parse_dollar_primary(),
            _ => None,
        }
    }

    fn consume_dollar(&mut self) -> bool {
        if self.peek() == Some('$') {
            self.advance();
            true
        } else {
            false
        }
    }

    /// True if the current position continues an identifier token — an
    /// alphanumeric / `_`, or a `.` that is itself followed by an identifier
    /// char (the dotted-function-name rule). Used as the trailing boundary
    /// for a cell-address token so `A1B` / `A1.5` stay bare Names rather than
    /// being split into `A1` + trailing garbage.
    fn at_ident_continuation(&self) -> bool {
        match self.peek() {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' => true,
            Some('.') => matches!(self.peek_at(1), Some(n) if n.is_ascii_alphanumeric() || n == '_'),
            _ => false,
        }
    }

    /// Scan a `[$]col[$]row` cell address at the current position, recording
    /// which axes carried a `$`. Contiguous (no interior whitespace). On any
    /// failure — including a token that runs into a longer identifier
    /// (`A1B`) — the position is restored and `None` is returned, so the
    /// caller can fall through to whole-column / Name handling. Equivalent to
    /// "the whole leading token is a valid cell address" for the relative
    /// case, so it is a drop-in replacement for the old
    /// `CellAddress::parse(&ident)` path plus `$` support.
    fn scan_abs_cell_addr(&mut self) -> Option<(CellAddress, RefAbs)> {
        let save = self.pos;
        let col_abs = self.consume_dollar();
        let letters_start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.advance();
        }
        if self.pos == letters_start {
            self.pos = save;
            return None;
        }
        let letters: String = self.chars[letters_start..self.pos].iter().collect();
        let row_abs = self.consume_dollar();
        let digits_start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.advance();
        }
        if self.pos == digits_start {
            self.pos = save;
            return None;
        }
        if self.at_ident_continuation() {
            // e.g. `A1B` / `A1.5` — not a self-delimited address.
            self.pos = save;
            return None;
        }
        let digits: String = self.chars[digits_start..self.pos].iter().collect();
        match CellAddress::parse(&format!("{}{}", letters, digits)) {
            Some(addr) => Some((addr, RefAbs::new(col_abs, row_abs))),
            None => {
                self.pos = save;
                None
            }
        }
    }

    /// Scan a `[$]col` whole-column corner (letters with an optional leading
    /// `$`, NO row digits). Returns the 0-based column index and its `$`
    /// marker. Restores the position and returns `None` on failure.
    fn scan_abs_col(&mut self) -> Option<(u32, bool)> {
        let save = self.pos;
        let col_abs = self.consume_dollar();
        let letters_start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.advance();
        }
        if self.pos == letters_start {
            self.pos = save;
            return None;
        }
        let letters: String = self.chars[letters_start..self.pos].iter().collect();
        // Reuse the column parser via a synthetic `<letters>1` address.
        match CellAddress::parse(&format!("{}1", letters)) {
            Some(a) => Some((a.col, col_abs)),
            None => {
                self.pos = save;
                None
            }
        }
    }

    /// A leading `$` always introduces a reference. Distinguish the three
    /// shapes by what follows: `$A...` is a column-absolute cell ref or an
    /// absolute whole-column range; `$1:...` is an absolute whole-row range.
    fn parse_dollar_primary(&mut self) -> Option<Expr> {
        if let Some((addr, abs)) = self.scan_abs_cell_addr() {
            return self.finish_same_sheet_ref(addr, abs);
        }
        if let Some(expr) = self.try_scan_whole_col_range() {
            return Some(expr);
        }
        self.try_parse_whole_row_range()
    }

    /// Given an already-parsed start corner, consume an optional `:` range
    /// tail. Yields a bounded `Range` (both corners are addresses), a
    /// `DynamicRange` (the end is a computed reference such as
    /// `A1:INDEX(...)`), or a bare `CellRef` when no `:` follows.
    fn finish_same_sheet_ref(&mut self, start: CellAddress, start_abs: RefAbs) -> Option<Expr> {
        self.skip_whitespace();
        if self.peek() == Some(':') {
            self.advance();
            self.skip_whitespace();
            let after_colon = self.pos;
            if let Some((end, end_abs)) = self.scan_abs_cell_addr() {
                return Some(Expr::Range {
                    start,
                    end,
                    unbounded: RangeBounds::None,
                    abs: RangeAbs::new(start_abs, end_abs),
                });
            }
            self.pos = after_colon;
            let end = self.parse_unary()?;
            return Some(Expr::DynamicRange {
                start: Box::new(Expr::CellRef(start, start_abs)),
                end: Box::new(end),
            });
        }
        Some(Expr::CellRef(start, start_abs))
    }

    /// Whole-column range `[$]A:[$]C`. Both corners are column letters with
    /// an optional `$`; the range spans every row. Returns `None` (restoring
    /// position) when the shape is not a whole-column range — in particular
    /// when the end column is immediately followed by a digit (that is the
    /// `A1:B2` bounded-range family, handled elsewhere).
    fn try_scan_whole_col_range(&mut self) -> Option<Expr> {
        let save = self.pos;
        let Some((start_col, start_col_abs)) = self.scan_abs_col() else {
            self.pos = save;
            return None;
        };
        self.skip_whitespace();
        if self.peek() != Some(':') {
            self.pos = save;
            return None;
        }
        self.advance(); // ':'
        self.skip_whitespace();
        let Some((end_col, end_col_abs)) = self.scan_abs_col() else {
            self.pos = save;
            return None;
        };
        // `A:B3` — a trailing digit means the right corner was a cell
        // address, so this is not a whole-column range.
        if self.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            self.pos = save;
            return None;
        }
        Some(Expr::Range {
            start: CellAddress::new(0, start_col),
            end: CellAddress::new(u32::MAX, end_col),
            unbounded: RangeBounds::Rows,
            abs: RangeAbs::new(
                RefAbs::new(start_col_abs, false),
                RefAbs::new(end_col_abs, false),
            ),
        })
    }

    fn matches_literal(&self, token: &str) -> bool {
        let mut offset = 0;
        for expected in token.chars() {
            let Some(actual) = self.chars.get(self.pos + offset).copied() else {
                return false;
            };
            if !actual.eq_ignore_ascii_case(&expected) {
                return false;
            }
            offset += 1;
        }
        true
    }

    fn parse_error_literal(&mut self) -> Option<Expr> {
        let tokens = [
            ("#DIV/0!", ValueError::DivisionByZero),
            ("#VALUE!", ValueError::InvalidValue),
            ("#NAME?", ValueError::InvalidName),
            ("#SPILL!", ValueError::Spill),
            ("#CALC!", ValueError::Calc),
            ("#NULL!", ValueError::Null),
            ("#CYCLE!", ValueError::CyclicRef),
            ("#TYPE!", ValueError::WrongType),
            ("#ARGS!", ValueError::WrongArgCount),
            ("#BUSY!", ValueError::Busy),
            ("#REF!", ValueError::InvalidRef),
            ("#NUM!", ValueError::Overflow),
            ("#N/A", ValueError::NotAvailable),
        ];
        for (token, err) in tokens {
            if self.matches_literal(token) {
                self.pos += token.chars().count();
                return Some(Expr::Error(err));
            }
        }
        None
    }

    /// Speculative parse for `[$]<digits>:[$]<digits>` whole-row syntax
    /// (`1:1`, `1:3`, and the absolute forms `$1:$3`, `1:$3`, ...). On
    /// success consumes both corners and returns the range. On failure rolls
    /// back to the original position so `parse_number` (relative entry) or
    /// the caller (`$` entry) can take over.
    fn try_parse_whole_row_range(&mut self) -> Option<Expr> {
        let save = self.pos;
        // Optional `$` then first digit run.
        let start_row_abs = self.consume_dollar();
        let s1 = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.advance();
            } else {
                break;
            }
        }
        if self.pos == s1 {
            self.pos = save;
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
        self.advance();
        // Optional `$` then second digit run.
        let end_row_abs = self.consume_dollar();
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
        Some(Expr::Range {
            start: CellAddress::new(start_row - 1, 0),
            end: CellAddress::new(end_row - 1, u32::MAX),
            unbounded: RangeBounds::Cols,
            abs: RangeAbs::new(
                RefAbs::new(false, start_row_abs),
                RefAbs::new(false, end_row_abs),
            ),
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

    /// Excel constant-array literal: `{a,b;c,d}`. `,` separates columns
    /// within a row, `;` separates rows. We've already peeked the opening
    /// `{`; this consumes the brace, the body, and the closing `}`.
    ///
    /// Cell expressions inside the literal are parsed via `parse_expr`
    /// (so unary minus on a number works: `={-1, 2}`) and then validated
    /// against the constant-array contract: only `Number`, `Text`,
    /// `Bool`, `Error`, and `Negate(Number)` are accepted. Anything else (cell
    /// refs, function calls, ranges, nested literals, binops other than
    /// the single Negate-of-Number form) is rejected by returning
    /// `None`, which surfaces as a parse error at the top level. This
    /// matches Excel's restriction that constant-array elements be
    /// literals — formulas inside `{...}` would otherwise blur the
    /// boundary between the parsed literal and a CSE-array context the
    /// engine doesn't otherwise support.
    ///
    /// Rows MUST be rectangular: every row has the same column count as
    /// the first. A ragged literal (`={1,2;3}`) is a parse error.
    fn parse_array_literal(&mut self) -> Option<Expr> {
        self.advance(); // consume '{'
        self.skip_whitespace();
        let mut rows_data: Vec<Vec<Expr>> = Vec::new();
        // Parse at least one cell — empty `{}` is not a valid Excel
        // constant array and parsing nothing here would yield a 0x0
        // array that the spill machinery can't anchor anywhere useful.
        loop {
            let mut row: Vec<Expr> = Vec::new();
            // Parse cells separated by `,` within this row.
            loop {
                self.skip_whitespace();
                let cell = self.parse_expr()?;
                if !is_valid_array_lit_element(&cell) {
                    return None;
                }
                row.push(cell);
                self.skip_whitespace();
                if self.peek() == Some(',') {
                    self.advance();
                    continue;
                }
                break;
            }
            rows_data.push(row);
            self.skip_whitespace();
            if self.peek() == Some(';') {
                self.advance();
                continue;
            }
            break;
        }
        self.skip_whitespace();
        if self.peek() != Some('}') {
            return None;
        }
        self.advance(); // consume '}'

        if rows_data.is_empty() {
            return None;
        }
        let cols = rows_data[0].len();
        if cols == 0 {
            return None;
        }
        // Rectangular check — every row must share the column count.
        for r in &rows_data {
            if r.len() != cols {
                return None;
            }
        }
        let rows = rows_data.len();
        let mut data: Vec<Expr> = Vec::with_capacity(rows * cols);
        for r in rows_data {
            for cell in r {
                data.push(cell);
            }
        }
        // u32 conversion: practical literals fit easily; if a literal
        // somehow overflowed (millions of cells in source) we'd rather
        // fail parse than silently truncate.
        let rows_u32 = u32::try_from(rows).ok()?;
        let cols_u32 = u32::try_from(cols).ok()?;
        Some(Expr::ArrayLit {
            rows: rows_u32,
            cols: cols_u32,
            data,
        })
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
        // tried as cell addresses. BUT `=TRUE()` / `=FALSE()` are also legal
        // (Excel exposes them as zero-arg functions), so a trailing `(` must
        // route through the function-call branch first, where the dispatcher
        // returns the same boolean. Bare `TRUE` / `FALSE` (no parens) stays
        // an `Expr::Bool` literal.
        let upper = ident.to_ascii_uppercase();
        if (upper == "TRUE" || upper == "FALSE") && self.peek() != Some('(') {
            return Some(Expr::Bool(upper == "TRUE"));
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

        // Structured (Table) reference: `Table1[...]`. `[` has no other
        // lexical role, so `IDENT[` is unambiguously a structured reference.
        // This MUST precede the cell-ref / whole-column attempts below,
        // because a table name such as `Table1` also parses as a bare cell
        // address (column "TABLE", row 1) — the trailing `[` is the sole
        // disambiguator (design doc §5.2 attach point / §4.2 guard note).
        if self.peek() == Some('[') {
            return self.parse_table_ref_body(Some(ident));
        }

        // Check for cross-sheet reference: `Name!A1` / `Name!A1:B3`
        // (Excel syntax).
        // The bang `!` unambiguously marks the preceding identifier as a
        // sheet name — it's not a token in any other formula context. The
        // identifier ALWAYS becomes a sheet name when '!' follows, even if
        // the same chars would also parse as a cell address.
        if self.peek() == Some('!') {
            self.advance(); // skip '!'
            let (start_addr, start_abs) = self.scan_abs_cell_addr()?;
            self.skip_whitespace();
            if self.peek() == Some(':') {
                self.advance();
                self.skip_whitespace();
                let after_colon = self.pos;
                if let Some((end_addr, end_abs)) = self.scan_abs_cell_addr() {
                    return Some(Expr::SheetRange {
                        sheet: ident,
                        start: start_addr,
                        end: end_addr,
                        unbounded: RangeBounds::None,
                        abs: RangeAbs::new(start_abs, end_abs),
                    });
                }
                self.pos = after_colon;
                let end = self.parse_unary()?;
                return Some(Expr::DynamicRange {
                    start: Box::new(Expr::SheetRef {
                        sheet: ident,
                        addr: start_addr,
                        abs: start_abs,
                    }),
                    end: Box::new(end),
                });
            }
            return Some(Expr::SheetRef {
                sheet: ident,
                addr: start_addr,
                abs: start_abs,
            });
        }

        // Same-sheet reference (cell ref, bounded / dynamic range, or
        // whole-column range), `$`-aware. Rewind to the identifier start:
        // the identifier read above only served to rule out the function-
        // call / sheet-ref / table-ref / TRUE-FALSE forms (none matched), so
        // re-scanning the raw source as a reference here is unambiguous. A
        // successful `scan_abs_cell_addr` on the whole leading token is
        // exactly equivalent to the old `CellAddress::parse(&ident)` test for
        // the relative case, plus it now understands `A$1`.
        let name_fallback_pos = self.pos;
        self.pos = start;
        if let Some((addr, abs)) = self.scan_abs_cell_addr() {
            return self.finish_same_sheet_ref(addr, abs);
        }
        if let Some(expr) = self.try_scan_whole_col_range() {
            return Some(expr);
        }

        // A bare identifier that didn't match anything above (function
        // call, TRUE/FALSE, cross-sheet ref, cell ref, or whole-column
        // range) is a `Name`. The evaluator resolves it against the LET
        // scope at eval time, or yields `#NAME?` if unbound. Numbers
        // never reach here because they route through `parse_number`.
        // Restore the post-identifier position first (the reference scanners
        // above rewound to the identifier start).
        self.pos = name_fallback_pos;
        Some(Expr::Name(ident))
    }

    /// Parse a structured-reference body starting at the outer `[`
    /// (design doc §5.1 `inner`). `table` carries the already-read table
    /// name (`Some`) for `Table1[...]`, or `None` for a table-less
    /// `[...]`. The MVP grammar (§3.2 defers combined qualifiers /
    /// `'`-escapes / empty `[]`):
    ///
    /// ```text
    /// inner := '@' colspec | special | '[' colref ']' (':' '[' colref ']')? | colref
    /// ```
    fn parse_table_ref_body(&mut self, table: Option<String>) -> Option<Expr> {
        self.expect('[')?; // consume the outer '['
        self.skip_whitespace();
        let (area, columns) = match self.peek()? {
            '#' => (self.parse_table_special()?, None),
            '@' => {
                self.advance(); // consume '@'
                self.skip_whitespace();
                if self.peek() == Some(']') {
                    // Bare `[@]` — the whole current row across every column.
                    (TableArea::ThisRow, None)
                } else {
                    let col = self.parse_table_colspec()?;
                    (TableArea::ThisRow, Some((col.clone(), col)))
                }
            }
            '[' => {
                // `[colref]` possibly followed by `:` `[colref]` (a
                // multi-column segment). Bracketed column names carry the
                // display spelling verbatim.
                let first = self.parse_bracketed_colref()?;
                self.skip_whitespace();
                if self.peek() == Some(':') {
                    self.advance();
                    self.skip_whitespace();
                    if self.peek() != Some('[') {
                        return None;
                    }
                    let second = self.parse_bracketed_colref()?;
                    (TableArea::Data, Some((first, second)))
                } else {
                    (TableArea::Data, Some((first.clone(), first)))
                }
            }
            _ => {
                let col = self.parse_bare_colref()?;
                (TableArea::Data, Some((col.clone(), col)))
            }
        };
        self.skip_whitespace();
        self.expect(']')?; // consume the outer ']'
        Some(Expr::TableRef {
            table,
            area,
            columns,
        })
    }

    /// Parse a `#special` area keyword (case-insensitive). No keyword is a
    /// prefix of another, so match order is irrelevant.
    fn parse_table_special(&mut self) -> Option<TableArea> {
        let specials = [
            ("#Headers", TableArea::Headers),
            ("#Totals", TableArea::Totals),
            ("#Data", TableArea::Data),
            ("#This Row", TableArea::ThisRow),
            ("#All", TableArea::All),
        ];
        for (token, area) in specials {
            if self.matches_literal(token) {
                self.pos += token.chars().count();
                return Some(area);
            }
        }
        None
    }

    /// A `colspec` after `@`: either a bracketed `[colref]` (for names with
    /// special characters) or a bare `colref`.
    fn parse_table_colspec(&mut self) -> Option<String> {
        self.skip_whitespace();
        if self.peek() == Some('[') {
            self.parse_bracketed_colref()
        } else {
            self.parse_bare_colref()
        }
    }

    /// Parse `[colref]` — consumes the inner `[`, the column name up to the
    /// inner `]`, and the closing `]`. The name is trimmed but internal
    /// spaces are preserved; an empty name is a parse error.
    fn parse_bracketed_colref(&mut self) -> Option<String> {
        self.expect('[')?; // consume inner '['
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c == ']' || c == '[' || c == '#' || c == '@' {
                break;
            }
            self.advance();
        }
        let raw: String = self.chars[start..self.pos].iter().collect();
        let name = raw.trim().to_string();
        if name.is_empty() {
            return None;
        }
        self.expect(']')?; // consume inner ']'
        Some(name)
    }

    /// Parse a bare `colref`: any run of characters except `[ ] # @`,
    /// trimmed (internal spaces kept). Empty is a parse error.
    fn parse_bare_colref(&mut self) -> Option<String> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c == '[' || c == ']' || c == '#' || c == '@' {
                break;
            }
            self.advance();
        }
        let raw: String = self.chars[start..self.pos].iter().collect();
        let name = raw.trim().to_string();
        if name.is_empty() {
            return None;
        }
        Some(name)
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
            Some(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL))
        );
    }

    #[test]
    fn parse_addition() {
        assert_eq!(
            parse_formula("=A1+B1"),
            Some(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
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
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                right: Box::new(Expr::BinOp {
                    op: BinOperator::Mul,
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
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
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                    right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
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
            ), RefAbs::REL))))
        );
    }

    #[test]
    fn parse_division() {
        assert_eq!(
            parse_formula("=A1/B1"),
            Some(Expr::BinOp {
                op: BinOperator::Div,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
            })
        );
    }

    #[test]
    fn parse_spaces() {
        assert_eq!(
            parse_formula("= A1 + B1 "),
            Some(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
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
                    Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL),
                    Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL),
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
                args: vec![Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)],
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
                abs: RangeAbs::REL,
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
                abs: RangeAbs::REL,
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
                abs: RangeAbs::REL,
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
                abs: RangeAbs::REL,
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
                abs: RangeAbs::REL,
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
                    left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                    right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
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
    fn parse_error_literals() {
        assert_eq!(
            parse_formula("=#CALC!"),
            Some(Expr::Error(ValueError::Calc))
        );
        assert_eq!(
            parse_formula("=#N/A"),
            Some(Expr::Error(ValueError::NotAvailable))
        );
        assert_eq!(
            parse_formula("=#DIV/0!"),
            Some(Expr::Error(ValueError::DivisionByZero))
        );
        assert_eq!(
            parse_formula("=#value!"),
            Some(Expr::Error(ValueError::InvalidValue))
        );
        assert_eq!(
            parse_formula("=#BUSY!"),
            Some(Expr::Error(ValueError::Busy))
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
            abs: RefAbs::REL,
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
                abs: RangeAbs::REL,
                }],
            }
        );
    }

    #[test]
    fn parse_cross_sheet_range_rejects_missing_end() {
        assert!(parse_formula("=SUM(Sheet2!A1:)").is_none());
    }

    #[test]
    fn parse_spill_ref() {
        assert_eq!(
            parse_formula("=A1#"),
            Some(Expr::SpillRef(Box::new(Expr::CellRef(CellAddress::new(
                0, 0
            ), RefAbs::REL))))
        );
    }

    #[test]
    fn spill_ref_does_not_swallow_error_literal_suffix() {
        assert!(parse_formula("=A1#CALC!").is_none());
    }

    #[test]
    fn parse_cross_sheet_spill_ref() {
        assert_eq!(
            parse_formula("=Sheet2!A1#"),
            Some(Expr::SpillRef(Box::new(Expr::SheetRef {
                sheet: "Sheet2".into(),
                addr: CellAddress::new(0, 0),
            abs: RefAbs::REL,
            })))
        );
    }

    #[test]
    fn parse_dynamic_range_endpoint() {
        let result = parse_formula("=A1:INDEX(A:A,3)").unwrap();
        match result {
            Expr::DynamicRange { start, end } => {
                assert_eq!(*start, Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL));
                assert!(matches!(*end, Expr::FuncCall { .. }));
            }
            other => panic!("expected DynamicRange, got {:?}", other),
        }
    }

    #[test]
    fn parse_dynamic_range_binds_tighter_than_multiply() {
        let result = parse_formula("=A1:INDEX(A:A,3)*2").unwrap();
        match result {
            Expr::BinOp {
                op: BinOperator::Mul,
                left,
                right,
            } => {
                assert!(matches!(*left, Expr::DynamicRange { .. }));
                assert_eq!(*right, Expr::Number(2.0));
            }
            other => panic!("expected multiply, got {:?}", other),
        }
    }

    #[test]
    fn parse_spill_rejects_range_anchor() {
        assert!(parse_formula("=A1:B2#").is_none());
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
                abs: RefAbs::REL,
                }),
                right: Box::new(Expr::Number(5.0)),
            }
        );
    }

    #[test]
    fn cell_address_takes_precedence_over_sheet_ref() {
        // `A1` alone is a cell ref, not a sheet name. The bang disambiguates.
        let result = parse_formula("=A1").unwrap();
        assert!(matches!(result, Expr::CellRef(..)));
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
                    abs: RangeAbs::REL,
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
                    abs: RangeAbs::REL,
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
    fn parse_bare_identifier_is_name() {
        // Bare identifier that isn't a cell ref / func call / TRUE/FALSE
        // surfaces as Expr::Name. The evaluator binds it via LET scope or
        // returns #NAME? if unbound.
        assert_eq!(parse_formula("=x"), Some(Expr::Name("x".into())));
        assert_eq!(parse_formula("=foo"), Some(Expr::Name("foo".into())));
        // Underscores allowed inside identifiers.
        assert_eq!(parse_formula("=my_var"), Some(Expr::Name("my_var".into())));
    }

    #[test]
    fn parse_let_func_with_name_args() {
        // `LET` is a function call; its name args are Expr::Name nodes.
        let result = parse_formula("=LET(x, 5, x*x)").unwrap();
        let Expr::FuncCall { name, args } = result else {
            panic!("expected FuncCall");
        };
        assert_eq!(name, "LET");
        assert_eq!(args[0], Expr::Name("x".into()));
        assert_eq!(args[1], Expr::Number(5.0));
        // args[2] is x*x — BinOp with Name on both sides.
        match &args[2] {
            Expr::BinOp { op, left, right } => {
                assert_eq!(*op, BinOperator::Mul);
                assert_eq!(**left, Expr::Name("x".into()));
                assert_eq!(**right, Expr::Name("x".into()));
            }
            _ => panic!("expected BinOp"),
        }
    }

    #[test]
    fn parse_decimal_still_works_with_name_fallback() {
        // The Expr::Name fallback added for LET must not capture decimals
        // — `1.5` routes through parse_number because identifiers must
        // start with an alpha char.
        assert_eq!(parse_formula("=1.5"), Some(Expr::Number(1.5)));
        assert_eq!(parse_formula("=.5"), Some(Expr::Number(0.5)));
        assert_eq!(parse_formula("=100.25"), Some(Expr::Number(100.25)));
    }

    #[test]
    fn parse_nested_func() {
        let result = parse_formula("=SUM(A1,SUM(B1,C1))").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![
                    Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL),
                    Expr::FuncCall {
                        name: "SUM".into(),
                        args: vec![
                            Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL),
                            Expr::CellRef(CellAddress::new(0, 2), RefAbs::REL),
                        ],
                    },
                ],
            }
        );
    }

    // ── Expr::Call (trailing-call chaining for LAMBDA invocation) ────

    #[test]
    fn parse_lambda_immediate_call_wraps_in_expr_call() {
        // `=LAMBDA(x, x*x)(5)` parses as Call(FuncCall("LAMBDA", ...), [5]).
        let result = parse_formula("=LAMBDA(x, x*x)(5)").unwrap();
        match result {
            Expr::Call(callee, args) => {
                match *callee {
                    Expr::FuncCall {
                        name,
                        args: lam_args,
                    } => {
                        assert_eq!(name, "LAMBDA");
                        assert_eq!(lam_args[0], Expr::Name("x".into()));
                    }
                    other => panic!("expected FuncCall callee, got {:?}", other),
                }
                assert_eq!(args, vec![Expr::Number(5.0)]);
            }
            other => panic!("expected Expr::Call, got {:?}", other),
        }
    }

    #[test]
    fn parse_chained_call_wraps_each_application() {
        // `=LAMBDA(x, LAMBDA(y, x*y))(3)(4)` — two trailing calls
        // chain into Call(Call(FuncCall("LAMBDA",..), [3]), [4]).
        let result = parse_formula("=LAMBDA(x, LAMBDA(y, x*y))(3)(4)").unwrap();
        match result {
            Expr::Call(outer_callee, outer_args) => {
                assert_eq!(outer_args, vec![Expr::Number(4.0)]);
                match *outer_callee {
                    Expr::Call(inner_callee, inner_args) => {
                        assert_eq!(inner_args, vec![Expr::Number(3.0)]);
                        assert!(matches!(*inner_callee, Expr::FuncCall { .. }));
                    }
                    other => panic!("expected nested Call, got {:?}", other),
                }
            }
            other => panic!("expected Expr::Call, got {:?}", other),
        }
    }

    #[test]
    fn parse_trailing_call_on_name_wraps_in_expr_call() {
        // `=f(1, 2)` where `f` is a Name (no built-in by that name)
        // parses as Call(Name("f"), [1, 2]). This is the path stored
        // lambdas use when bound through LET and then immediately
        // invoked. NOTE: bare identifier "f" followed by "(" actually
        // parses as a FuncCall via the identifier branch — so this
        // test exercises an explicit Name produced inside a LET body
        // by other means rather than the surface `f(1,2)`. Skip this
        // exact assertion if the parser ambiguity surfaces; the
        // canonical immediate-invocation path is exercised in the
        // other parser tests above and the integration tests.
        //
        // To keep behavior verified, we instead confirm that a
        // *parenthesized* identifier wraps in Call:
        //   `=(f)(1, 2)` — parens deliberately disambiguate.
        let result = parse_formula("=(f)(1, 2)").unwrap();
        match result {
            Expr::Call(callee, args) => {
                assert_eq!(*callee, Expr::Name("f".into()));
                assert_eq!(args, vec![Expr::Number(1.0), Expr::Number(2.0)]);
            }
            other => panic!("expected Expr::Call, got {:?}", other),
        }
    }

    // === Excel constant-array literal: `={a,b;c,d}` ===

    #[test]
    fn parse_array_lit_single_row() {
        // `={1,2,3}` — 1 row × 3 cols, row-major data.
        let result = parse_formula("={1,2,3}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 1,
                cols: 3,
                data: vec![Expr::Number(1.0), Expr::Number(2.0), Expr::Number(3.0)],
            }
        );
    }

    #[test]
    fn parse_array_lit_single_column() {
        // `={1;2;3}` — 3 rows × 1 col.
        let result = parse_formula("={1;2;3}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 3,
                cols: 1,
                data: vec![Expr::Number(1.0), Expr::Number(2.0), Expr::Number(3.0)],
            }
        );
    }

    #[test]
    fn parse_array_lit_2x2() {
        // `={1,2;3,4}` — 2×2, row-major: [1,2,3,4].
        let result = parse_formula("={1,2;3,4}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 2,
                cols: 2,
                data: vec![
                    Expr::Number(1.0),
                    Expr::Number(2.0),
                    Expr::Number(3.0),
                    Expr::Number(4.0),
                ],
            }
        );
    }

    #[test]
    fn parse_array_lit_mixed_text_numbers() {
        // `={"a","b";1,2}` — mixed types in a 2×2 literal.
        let result = parse_formula("={\"a\",\"b\";1,2}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 2,
                cols: 2,
                data: vec![
                    Expr::Text("a".into()),
                    Expr::Text("b".into()),
                    Expr::Number(1.0),
                    Expr::Number(2.0),
                ],
            }
        );
    }

    #[test]
    fn parse_array_lit_negate_number_allowed() {
        // `={-1, 2}` — unary minus over a number is allowed.
        let result = parse_formula("={-1, 2}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 1,
                cols: 2,
                data: vec![Expr::Negate(Box::new(Expr::Number(1.0))), Expr::Number(2.0),],
            }
        );
    }

    #[test]
    fn parse_array_lit_bool() {
        let result = parse_formula("={TRUE,FALSE}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 1,
                cols: 2,
                data: vec![Expr::Bool(true), Expr::Bool(false)],
            }
        );
    }

    #[test]
    fn parse_array_lit_error_literals_allowed() {
        let result = parse_formula("={#N/A,#CALC!}").unwrap();
        assert_eq!(
            result,
            Expr::ArrayLit {
                rows: 1,
                cols: 2,
                data: vec![
                    Expr::Error(ValueError::NotAvailable),
                    Expr::Error(ValueError::Calc),
                ],
            }
        );
    }

    #[test]
    fn parse_array_lit_ragged_rejected() {
        // `={1,2;3}` — second row only has one column.
        assert!(parse_formula("={1,2;3}").is_none());
    }

    #[test]
    fn parse_array_lit_cell_ref_rejected() {
        // `={A1, B1}` — cell refs are not allowed inside a literal.
        assert!(parse_formula("={A1, B1}").is_none());
    }

    #[test]
    fn parse_array_lit_func_call_rejected() {
        // `={SUM(1)}` — function calls are not allowed inside a literal.
        assert!(parse_formula("={SUM(1)}").is_none());
    }

    #[test]
    fn parse_array_lit_binop_rejected() {
        // `={1+1}` — even pure-literal arithmetic isn't a valid constant.
        assert!(parse_formula("={1+1}").is_none());
    }

    #[test]
    fn parse_array_lit_nested_rejected() {
        // `={{1}}` — nested array literals are not valid Excel.
        assert!(parse_formula("={{1}}").is_none());
    }

    #[test]
    fn parse_array_lit_inside_func_call() {
        // `=SUM({1,2,3})` parses with the literal as the SUM arg.
        let result = parse_formula("=SUM({1,2,3})").unwrap();
        assert_eq!(
            result,
            Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::ArrayLit {
                    rows: 1,
                    cols: 3,
                    data: vec![Expr::Number(1.0), Expr::Number(2.0), Expr::Number(3.0)],
                }],
            }
        );
    }

    // === Excel multi-area reference syntax: `(A1:B2, D5:E6)` ===

    #[test]
    fn parse_multi_area_two_ranges() {
        // `=(A1:B2, D5)` — multi-area with two refs (Range + CellRef).
        let result = parse_formula("=(A1:B2, D5)").unwrap();
        assert_eq!(
            result,
            Expr::MultiArea(vec![
                Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(1, 1),
                    unbounded: RangeBounds::None,
                abs: RangeAbs::REL,
                },
                Expr::CellRef(CellAddress::new(4, 3), RefAbs::REL),
            ])
        );
    }

    #[test]
    fn parse_multi_area_three_parts() {
        // `=(A1:B2, D5:E6, F1)` — three-part multi-area.
        let result = parse_formula("=(A1:B2, D5:E6, F1)").unwrap();
        let Expr::MultiArea(parts) = result else {
            panic!("expected MultiArea");
        };
        assert_eq!(parts.len(), 3);
        assert!(matches!(parts[0], Expr::Range { .. }));
        assert!(matches!(parts[1], Expr::Range { .. }));
        assert_eq!(parts[2], Expr::CellRef(CellAddress::new(0, 5), RefAbs::REL));
    }

    #[test]
    fn parse_single_paren_ref_strips_parens() {
        // `=(A1)` — single ref in parens is just the cell ref, NOT a
        // single-element MultiArea.
        assert_eq!(
            parse_formula("=(A1)"),
            Some(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL))
        );
    }

    #[test]
    fn parse_paren_binop_still_grouped() {
        // `=(1+2)` — paren'd binop survives as a grouped expression
        // (not a MultiArea). The multi-area detection only kicks in
        // when a `,` follows the first inner expr.
        let result = parse_formula("=(1+2)").unwrap();
        assert!(matches!(result, Expr::BinOp { .. }));
    }

    #[test]
    fn parse_paren_addition_is_binop() {
        // `=(A1+B1)` must keep parsing as a BinOp — the addition takes
        // precedence over any multi-area interpretation. (The first
        // inner expr is `A1+B1` and no comma follows, so the path is
        // the grouped-expression path.)
        let result = parse_formula("=(A1+B1)").unwrap();
        assert_eq!(
            result,
            Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL)),
                right: Box::new(Expr::CellRef(CellAddress::new(0, 1), RefAbs::REL)),
            }
        );
    }

    #[test]
    fn parse_multi_area_rejects_non_ref_in_list() {
        // `=(A1, 1+2)` — the second part isn't a reference, so the
        // multi-area path rejects it. The grouped-expression path
        // can't take over either (a comma never appears in a normal
        // parenthesized binop). Overall parse fails.
        assert!(parse_formula("=(A1, 1+2)").is_none());
    }

    #[test]
    fn parse_multi_area_inside_func_call() {
        // `=SUM((A1:B2, D5:E6))` — the function arg is a multi-area.
        // SUM's eval will surface #VALUE! (multi-area isn't a normal
        // arg shape) but the formula must parse.
        let result = parse_formula("=SUM((A1:B2, D5:E6))").unwrap();
        let Expr::FuncCall { name, args } = result else {
            panic!("expected FuncCall");
        };
        assert_eq!(name, "SUM");
        assert_eq!(args.len(), 1);
        assert!(matches!(args[0], Expr::MultiArea(_)));
    }

    #[test]
    fn parse_areas_func_call_with_multi_area() {
        // `=AREAS((A1:B2, D5:E6))` — argument is a MultiArea.
        let result = parse_formula("=AREAS((A1:B2, D5:E6))").unwrap();
        let Expr::FuncCall { name, args } = result else {
            panic!("expected FuncCall");
        };
        assert_eq!(name, "AREAS");
        match &args[0] {
            Expr::MultiArea(parts) => assert_eq!(parts.len(), 2),
            other => panic!("expected MultiArea, got {:?}", other),
        }
    }

    #[test]
    fn parse_multi_area_with_cross_sheet_ref() {
        // `=(Sheet2!A1, B2)` — multi-area with a cross-sheet part.
        let result = parse_formula("=(Sheet2!A1, B2)").unwrap();
        let Expr::MultiArea(parts) = result else {
            panic!("expected MultiArea");
        };
        assert_eq!(parts.len(), 2);
        assert!(matches!(parts[0], Expr::SheetRef { .. }));
        assert_eq!(parts[1], Expr::CellRef(CellAddress::new(1, 1), RefAbs::REL));
    }

    // ================= Absolute references (`$A$1`) parsing =================
    //
    // Counter-example baseline (verified against the pre-change parser): the
    // dispatch `match` sent `$` to `_ => None`, so EVERY one of the formulas
    // below returned `parse_formula(..) == None` — a hard parse failure that
    // surfaced as `Error(InvalidValue)` in the cell, not a wrong value. These
    // assertions are the green side; they fail to even compile against the old
    // single-field `CellRef`.

    #[test]
    fn parse_absolute_cell_ref_all_four_forms() {
        assert_eq!(
            parse_formula("=$A$1"),
            Some(Expr::CellRef(CellAddress::new(0, 0), RefAbs::new(true, true)))
        );
        assert_eq!(
            parse_formula("=$A1"),
            Some(Expr::CellRef(
                CellAddress::new(0, 0),
                RefAbs::new(true, false)
            ))
        );
        assert_eq!(
            parse_formula("=A$1"),
            Some(Expr::CellRef(
                CellAddress::new(0, 0),
                RefAbs::new(false, true)
            ))
        );
        assert_eq!(
            parse_formula("=A1"),
            Some(Expr::CellRef(CellAddress::new(0, 0), RefAbs::REL))
        );
    }

    #[test]
    fn parse_single_absolute_ref_in_expression() {
        // The canonical reported crash: `=$A$2+1` used to fail the WHOLE
        // parse. It must now be a normal BinOp with an absolute left operand.
        assert_eq!(
            parse_formula("=$A$2+1").unwrap(),
            Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(Expr::CellRef(CellAddress::new(1, 0), RefAbs::ABS)),
                right: Box::new(Expr::Number(1.0)),
            }
        );
    }

    #[test]
    fn parse_absolute_range_corner_combinations() {
        // Both corners absolute.
        assert_eq!(
            parse_formula("=SUM($A$2:$B$4)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(1, 0),
                    end: CellAddress::new(3, 1),
                    unbounded: RangeBounds::None,
                    abs: RangeAbs::new(RefAbs::ABS, RefAbs::ABS),
                }],
            })
        );
        // Mixed: `$A2:B$4` — col-abs start, row-abs end.
        assert_eq!(
            parse_formula("=SUM($A2:B$4)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(1, 0),
                    end: CellAddress::new(3, 1),
                    unbounded: RangeBounds::None,
                    abs: RangeAbs::new(RefAbs::new(true, false), RefAbs::new(false, true)),
                }],
            })
        );
    }

    #[test]
    fn parse_absolute_cross_sheet_ref_and_range() {
        assert_eq!(
            parse_formula("=Sheet1!$A$1"),
            Some(Expr::SheetRef {
                sheet: "Sheet1".into(),
                addr: CellAddress::new(0, 0),
                abs: RefAbs::ABS,
            })
        );
        assert_eq!(
            parse_formula("=SUM(Sheet1!$A$2:$B$4)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::SheetRange {
                    sheet: "Sheet1".into(),
                    start: CellAddress::new(1, 0),
                    end: CellAddress::new(3, 1),
                    unbounded: RangeBounds::None,
                    abs: RangeAbs::new(RefAbs::ABS, RefAbs::ABS),
                }],
            })
        );
    }

    #[test]
    fn parse_absolute_whole_col_and_whole_row() {
        assert_eq!(
            parse_formula("=SUM($A:$C)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(u32::MAX, 2),
                    unbounded: RangeBounds::Rows,
                    abs: RangeAbs::new(RefAbs::new(true, false), RefAbs::new(true, false)),
                }],
            })
        );
        assert_eq!(
            parse_formula("=SUM($1:$3)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(2, u32::MAX),
                    unbounded: RangeBounds::Cols,
                    abs: RangeAbs::new(RefAbs::new(false, true), RefAbs::new(false, true)),
                }],
            })
        );
        // Mixed whole-column: relative start, absolute end.
        assert_eq!(
            parse_formula("=SUM(A:$C)"),
            Some(Expr::FuncCall {
                name: "SUM".into(),
                args: vec![Expr::Range {
                    start: CellAddress::new(0, 0),
                    end: CellAddress::new(u32::MAX, 2),
                    unbounded: RangeBounds::Rows,
                    abs: RangeAbs::new(RefAbs::REL, RefAbs::new(true, false)),
                }],
            })
        );
    }

    #[test]
    fn parse_absolute_spill_anchor() {
        assert_eq!(
            parse_formula("=$A$1#"),
            Some(Expr::SpillRef(Box::new(Expr::CellRef(
                CellAddress::new(0, 0),
                RefAbs::ABS
            ))))
        );
    }

    #[test]
    fn dollar_does_not_disturb_names_numbers_or_relative_refs() {
        // Regression guard: relative forms and non-reference tokens are
        // unchanged, and a stray `$` fails cleanly instead of mis-parsing.
        assert_eq!(parse_formula("=x"), Some(Expr::Name("x".into())));
        assert_eq!(parse_formula("=A1B"), Some(Expr::Name("A1B".into())));
        assert_eq!(parse_formula("=1.5"), Some(Expr::Number(1.5)));
        assert!(parse_formula("=$").is_none());
        assert!(parse_formula("=$5").is_none());
        assert!(parse_formula("=$Z").is_none());
    }
}
