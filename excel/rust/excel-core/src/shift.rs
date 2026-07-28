use crate::cell::CellAddress;
use crate::formula::{BinOperator, Expr, RangeAbs, RangeBounds, RefAbs, TableArea};

/// What to do with a CellRef whose target was deleted by a structural edit.
///
/// `Invalid` becomes `#REF!` at eval time. We mark it via a sentinel
/// (row=u32::MAX, col=u32::MAX) so the AST shape is preserved — the eval
/// layer knows to short-circuit when it sees that address.
pub const REF_INVALID_ROW: u32 = u32::MAX;
pub const REF_INVALID_COL: u32 = u32::MAX;

fn is_invalid(addr: CellAddress) -> bool {
    addr.row == REF_INVALID_ROW || addr.col == REF_INVALID_COL
}

fn range_has_invalid_ref(start: CellAddress, end: CellAddress, unbounded: RangeBounds) -> bool {
    let row_invalid = if unbounded.rows_unbounded() {
        false
    } else {
        start.row == REF_INVALID_ROW || end.row == REF_INVALID_ROW
    };
    let col_invalid = if unbounded.cols_unbounded() {
        false
    } else {
        start.col == REF_INVALID_COL || end.col == REF_INVALID_COL
    };
    row_invalid || col_invalid
}

/// Returns true if the AST contains any invalid (#REF!) cell reference,
/// e.g. left over from a row/column delete that took out a cell the
/// formula was reading.
pub fn contains_invalid_ref(expr: &Expr) -> bool {
    match expr {
        Expr::CellRef(addr, _) => is_invalid(*addr),
        Expr::Range {
            start,
            end,
            unbounded,
            ..
        } => range_has_invalid_ref(*start, *end, *unbounded),
        Expr::SheetRef { addr, .. } => is_invalid(*addr),
        Expr::SheetRange {
            start,
            end,
            unbounded,
            ..
        } => range_has_invalid_ref(*start, *end, *unbounded),
        Expr::Negate(inner) => contains_invalid_ref(inner),
        Expr::BinOp { left, right, .. } => {
            contains_invalid_ref(left) || contains_invalid_ref(right)
        }
        Expr::FuncCall { args, .. } => args.iter().any(contains_invalid_ref),
        Expr::SpillRef(anchor) => contains_invalid_ref(anchor),
        Expr::DynamicRange { start, end } => {
            contains_invalid_ref(start) || contains_invalid_ref(end)
        }
        // Constant-array literal: the parser already rejected any cell
        // ref / range / func call inside, so the elements can't carry a
        // #REF! sentinel.
        Expr::ArrayLit { .. } => false,
        // Multi-area: every part is a reference, so a #REF! in any of
        // them propagates the same way it would for a bare ref.
        Expr::MultiArea(parts) => parts.iter().any(contains_invalid_ref),
        _ => false,
    }
}

/// Adjust a single address for a row insertion at `at` (0-based) of `count`
/// rows. References at or below `at` shift down by `count`. References
/// above `at` are unchanged.
pub fn shift_addr_row_insert(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) || addr.row < at {
        return addr;
    }
    CellAddress::new(addr.row + count, addr.col)
}

/// Adjust a single address for a row deletion of `count` rows starting at
/// `at`. Returns the invalid sentinel when the row was inside the deleted
/// range so eval can produce #REF!.
pub fn shift_addr_row_delete(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) {
        return addr;
    }
    if addr.row < at {
        addr
    } else if addr.row < at + count {
        CellAddress::new(REF_INVALID_ROW, REF_INVALID_COL)
    } else {
        CellAddress::new(addr.row - count, addr.col)
    }
}

pub fn shift_addr_col_insert(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) || addr.col < at {
        return addr;
    }
    CellAddress::new(addr.row, addr.col + count)
}

pub fn shift_addr_col_delete(addr: CellAddress, at: u32, count: u32) -> CellAddress {
    if is_invalid(addr) {
        return addr;
    }
    if addr.col < at {
        addr
    } else if addr.col < at + count {
        CellAddress::new(REF_INVALID_ROW, REF_INVALID_COL)
    } else {
        CellAddress::new(addr.row, addr.col - count)
    }
}

/// Structural-edit descriptor shared by the hydrated AST retarget
/// (`Sheet::retarget_formula_refs`) and the lazy parked-source rewrite
/// (`rewrite_parked_source`). Carrying the edit (instead of a bare
/// `Fn(CellAddress) -> CellAddress`) lets both paths answer
/// "does this edit even touch coordinate X?" without re-deriving the
/// axis from closure behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShiftEdit {
    RowInsert { at: u32, count: u32 },
    RowDelete { at: u32, count: u32 },
    ColInsert { at: u32, count: u32 },
    ColDelete { at: u32, count: u32 },
}

impl ShiftEdit {
    /// Apply the edit's address mapping — exactly the `shift_addr_*`
    /// function the structural ops used to pass as a closure.
    pub fn apply(&self, addr: CellAddress) -> CellAddress {
        match *self {
            ShiftEdit::RowInsert { at, count } => shift_addr_row_insert(addr, at, count),
            ShiftEdit::RowDelete { at, count } => shift_addr_row_delete(addr, at, count),
            ShiftEdit::ColInsert { at, count } => shift_addr_col_insert(addr, at, count),
            ShiftEdit::ColDelete { at, count } => shift_addr_col_delete(addr, at, count),
        }
    }

    /// True for row insert/delete, false for column insert/delete.
    pub fn is_row_edit(&self) -> bool {
        matches!(
            self,
            ShiftEdit::RowInsert { .. } | ShiftEdit::RowDelete { .. }
        )
    }

    /// First coordinate on the edit axis touched by the edit. Every
    /// cell with `row >= boundary` (row edits) / `col >= boundary`
    /// (col edits) shifts (insert) or shifts-or-dies (delete); cells
    /// strictly below the boundary are untouched.
    pub fn boundary(&self) -> u32 {
        match *self {
            ShiftEdit::RowInsert { at, .. }
            | ShiftEdit::RowDelete { at, .. }
            | ShiftEdit::ColInsert { at, .. }
            | ShiftEdit::ColDelete { at, .. } => at,
        }
    }

    /// Can the edit change any value INSIDE `range` (canonical form —
    /// unbounded axes carry the `0 / u32::MAX` sentinels)? Used by the
    /// hydrated retarget to decide whether an AST-unchanged formula's
    /// cached value can be kept: a range whose end coordinate reaches
    /// the edit boundary may observe cells that moved.
    pub fn touches_range(&self, range: &crate::range::CellRange) -> bool {
        if self.is_row_edit() {
            range.end.row >= self.boundary()
        } else {
            range.end.col >= self.boundary()
        }
    }
}

/// Outcome of `rewrite_parked_source` for one parked formula source.
#[derive(Debug, PartialEq, Eq)]
pub enum SourceRewrite {
    /// No reference crosses the edit boundary — source text reusable as-is.
    Unchanged,
    /// At least one reference shifted; the rewritten source is returned.
    Rewritten(String),
    /// A reference fell inside the deleted band. Mirrors the hydrated
    /// path: the whole formula becomes a `#REF!` error cell.
    DeadRef,
}

/// AUDIT A-1 — token-level A1-reference rewrite for LAZY (parked)
/// formula sources. Structural edits must retarget parked formulas
/// WITHOUT hydrating them (no parse, no dep install); this scanner
/// rewrites only the reference tokens the edit actually moves, in one
/// pass over the source bytes, allocating only when something changes.
///
/// The scanner mirrors `parse_formula`'s tokenization rules exactly so
/// that `hydrate(rewrite(src))` ≡ `retarget(hydrate(src))`:
///
///   - String literals (`"..."`, no escape support — same as
///     `Parser::parse_string`) are skipped verbatim, so `="A1"` is
///     never rewritten.
///   - Identifier tokens follow `Parser::parse_identifier`:
///     `[A-Za-z][A-Za-z0-9_]*` with `.` absorbed only when the next
///     char is another identifier char (so `RANK.EQ` is one token and
///     never mistaken for a ref).
///   - A token followed (whitespace allowed) by `(` is a function call
///     — `LOG10(`, `ATAN2(`, and even `A1(...)` (which the parser
///     treats as a FuncCall named `A1`, not a ref) are never shifted.
///   - A token followed (whitespace allowed) by `!` is a sheet name;
///     the address token immediately after the `!` — plus an optional
///     `:end` range tail that parses as an address — belongs to a
///     `SheetRef` / `SheetRange`, which within-sheet structural edits
///     do NOT shift (mirrors `map_addrs`). Cross-sheet retarget scope
///     is unchanged from the hydrated path: edits on this sheet never
///     rewrite other sheets' formulas either.
///   - A token that parses as a cell address is shifted through
///     `ShiftEdit::apply`. Bounded range corners (`A1:B5`) are two
///     independent tokens, exactly like `shift_range_corners` with
///     `RangeBounds::None`.
///   - Whole-column (`A:C`) / whole-row (`1:3`) ranges replicate
///     `shift_range_corners`' synthetic-corner trick: the bounded axis
///     shifts, the unbounded axis is pinned — and a corner mapped into
///     the deleted band (e.g. `delete_col(0)` under `=SUM(1:3)`) kills
///     the formula, matching the hydrated `contains_invalid_ref` path.
///   - Absolute refs (`$A$1`, `$A1`, `A$1`, and the range / whole-col /
///     whole-row forms) are shifted exactly like their relative twins —
///     the address moves, the `$` markers are preserved — mirroring the
///     hydrated `map_addrs` path (absoluteness never changes how an edit
///     moves an address). Quoted sheet names (`'My Sheet'!A1`) still do
///     not exist in this grammar, so the scanner doesn't model them.
///
/// Sources that don't parse (possible via `bulk_install_storage`,
/// which parks without validating) still surface `#VALUE!` at
/// hydration after a rewrite — token rewrites inside garbage can't
/// make garbage parse. The caller is expected to parse-check before
/// honoring `DeadRef` so unparseable sources keep the hydrated path's
/// `#VALUE!` outcome instead of gaining a `#REF!`.
pub fn rewrite_parked_source(src: &str, edit: ShiftEdit) -> SourceRewrite {
    let b = src.as_bytes();
    let n = b.len();
    // Output buffer, allocated lazily on the first actual rewrite.
    // `emitted` is the source index up to which output (or implicit
    // unchanged prefix) is already accounted for.
    let mut out: Option<String> = None;
    let mut emitted = 0usize;
    let mut i = 0usize;
    // Raw previous byte (0 at start). `prev == b'!'` marks the token
    // that immediately follows a sheet-name bang — the parser reads
    // that address with NO whitespace skip, so raw adjacency is right.
    let mut prev: u8 = 0;

    while i < n {
        let c = b[i];
        if c == b'"' {
            // String literal: skip to the closing quote (parser has no
            // escape sequence — first `"` closes).
            i += 1;
            while i < n && b[i] != b'"' {
                i += 1;
            }
            if i < n {
                i += 1;
            }
            prev = b'"';
            continue;
        }
        if c == b'$' || c.is_ascii_alphabetic() {
            // A token that immediately follows a sheet `!` is a cross-sheet
            // address (SheetRef / SheetRange corner). Within-sheet edits
            // never shift those (mirrors `map_addrs`), so skip the whole
            // `[$]col[$]row` corner plus an optional `:corner` SheetRange
            // tail. A non-address after `!` (a DynamicRange end) falls
            // through so its inner refs still shift.
            if prev == b'!' {
                if let Some((_, _, _, end)) = scan_abs_addr_token(b, i) {
                    let mut k = end;
                    let j = skip_ascii_ws(b, k);
                    if j < n && b[j] == b':' {
                        let jj = skip_ascii_ws(b, j + 1);
                        if let Some((_, _, _, end2)) = scan_abs_addr_token(b, jj) {
                            k = end2;
                        }
                    }
                    i = k;
                    prev = b[i - 1];
                    continue;
                }
            }

            if c.is_ascii_alphabetic() {
                let start = i;
                i = scan_ident_end(b, i);
                match next_non_ws(b, i) {
                    Some(b'(') | Some(b'!') => {
                        // Function name or sheet name — never a same-sheet ref.
                        prev = b[i - 1];
                        continue;
                    }
                    _ => {}
                }
                // Same-sheet cell ref (`A5`, `A$5`), `$`-aware on the row.
                if let Some((addr, col_abs, row_abs, end)) = scan_abs_addr_token(b, start) {
                    let mapped = edit.apply(addr);
                    if mapped.row == REF_INVALID_ROW || mapped.col == REF_INVALID_COL {
                        return SourceRewrite::DeadRef;
                    }
                    if mapped != addr {
                        let buf = out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                        buf.push_str(&src[emitted..start]);
                        push_abs_addr(buf, mapped, col_abs, row_abs);
                        emitted = end;
                    }
                    i = end;
                    prev = b[i - 1];
                    continue;
                }
                // Whole-column range `A:C` / `A:$C` (start column has no `$`
                // on this path — a leading `$` routes through the `$` arm).
                if let Some(res) = try_shift_whole_col(b, start, edit) {
                    match res {
                        Err(()) => return SourceRewrite::DeadRef,
                        Ok((new_i, rewrite)) => {
                            if let Some(text) = rewrite {
                                let buf =
                                    out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                                buf.push_str(&src[emitted..start]);
                                buf.push_str(&text);
                                emitted = new_i;
                            }
                            i = new_i;
                            prev = b[i - 1];
                            continue;
                        }
                    }
                }
                // Plain Name / TRUE / FALSE / error-literal letters — copy.
                prev = b[i - 1];
                continue;
            }

            // c == b'$': a leading `$` always introduces a reference
            // (never a function / sheet / Name).
            let start = i;
            if let Some((addr, col_abs, row_abs, end)) = scan_abs_addr_token(b, start) {
                let mapped = edit.apply(addr);
                if mapped.row == REF_INVALID_ROW || mapped.col == REF_INVALID_COL {
                    return SourceRewrite::DeadRef;
                }
                if mapped != addr {
                    let buf = out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                    buf.push_str(&src[emitted..start]);
                    push_abs_addr(buf, mapped, col_abs, row_abs);
                    emitted = end;
                }
                i = end;
                prev = b[i - 1];
                continue;
            }
            if let Some(res) = try_shift_whole_col(b, start, edit) {
                match res {
                    Err(()) => return SourceRewrite::DeadRef,
                    Ok((new_i, rewrite)) => {
                        if let Some(text) = rewrite {
                            let buf =
                                out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                            buf.push_str(&src[emitted..start]);
                            buf.push_str(&text);
                            emitted = new_i;
                        }
                        i = new_i;
                        prev = b[i - 1];
                        continue;
                    }
                }
            }
            if let Some(res) = try_shift_whole_row(b, start, edit) {
                match res {
                    Err(()) => return SourceRewrite::DeadRef,
                    Ok((new_i, rewrite)) => {
                        if let Some(text) = rewrite {
                            let buf =
                                out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                            buf.push_str(&src[emitted..start]);
                            buf.push_str(&text);
                            emitted = new_i;
                        }
                        i = new_i;
                        prev = b[i - 1];
                        continue;
                    }
                }
            }
            // Lone `$` (not part of a reference) — copy through.
            prev = b'$';
            i += 1;
            continue;
        }
        if c.is_ascii_digit() && prev != b'.' {
            // Candidate whole-row range `1:3` / `1:$3`. A leading `$` on the
            // first corner routes through the `$` arm above.
            let start = i;
            if let Some(res) = try_shift_whole_row(b, start, edit) {
                match res {
                    Err(()) => return SourceRewrite::DeadRef,
                    Ok((new_i, rewrite)) => {
                        if let Some(text) = rewrite {
                            let buf =
                                out.get_or_insert_with(|| String::with_capacity(src.len() + 8));
                            buf.push_str(&src[emitted..start]);
                            buf.push_str(&text);
                            emitted = new_i;
                        }
                        i = new_i;
                        prev = b[i - 1];
                        continue;
                    }
                }
            }
            // Not a whole-row range — copy the leading digit run through.
            while i < n && b[i].is_ascii_digit() {
                i += 1;
            }
            prev = b[i - 1];
            continue;
        }
        // Punctuation / whitespace / multibyte UTF-8 — copy through.
        prev = c;
        i += 1;
    }

    match out {
        None => SourceRewrite::Unchanged,
        Some(mut buf) => {
            buf.push_str(&src[emitted..]);
            SourceRewrite::Rewritten(buf)
        }
    }
}

/// Identifier scan mirroring `Parser::parse_identifier`: alphanumerics
/// and `_`, with `.` absorbed only when followed by another identifier
/// char. `i` must point at the (alphabetic) first char.
fn scan_ident_end(b: &[u8], mut i: usize) -> usize {
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphanumeric() || c == b'_' {
            i += 1;
        } else if c == b'.'
            && i + 1 < b.len()
            && (b[i + 1].is_ascii_alphanumeric() || b[i + 1] == b'_')
        {
            i += 1;
        } else {
            break;
        }
    }
    i
}

fn skip_ascii_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t' || b[i] == b'\r' || b[i] == b'\n') {
        i += 1;
    }
    i
}

fn next_non_ws(b: &[u8], i: usize) -> Option<u8> {
    let j = skip_ascii_ws(b, i);
    b.get(j).copied()
}

/// Overflow-safe column-letter parse (`CellAddress::parse`'s
/// `col_letters_to_index` does unchecked arithmetic, which would panic
/// in debug builds on absurd letter runs in garbage sources — the
/// scanner runs over EVERY parked source on EVERY structural edit, so
/// it must never panic on hostile text).
fn parse_col_letters(s: &str) -> Option<u32> {
    if s.is_empty() {
        return None;
    }
    let mut result: u32 = 0;
    for c in s.bytes() {
        if !c.is_ascii_alphabetic() {
            return None;
        }
        let d = (c.to_ascii_uppercase() - b'A') as u32;
        result = result.checked_mul(26)?.checked_add(d + 1)?;
    }
    result.checked_sub(1)
}

/// Parse a `[$]col[$]row` cell-address token at byte index `i` (which must
/// point at `$` or an ascii letter). Returns `(addr, col_abs, row_abs, end)`
/// only when the token is a self-delimited cell address — mirroring
/// `Parser::scan_abs_cell_addr`, boundary check included, so `A1B` / `A1.5`
/// are NOT treated as addresses. Overflow-safe (runs over hostile parked
/// text). Returns `None` otherwise.
fn scan_abs_addr_token(b: &[u8], i: usize) -> Option<(CellAddress, bool, bool, usize)> {
    let n = b.len();
    let mut j = i;
    let col_abs = if j < n && b[j] == b'$' {
        j += 1;
        true
    } else {
        false
    };
    let letters_start = j;
    while j < n && b[j].is_ascii_alphabetic() {
        j += 1;
    }
    if j == letters_start {
        return None;
    }
    let col = parse_col_letters(std::str::from_utf8(&b[letters_start..j]).ok()?)?;
    let row_abs = if j < n && b[j] == b'$' {
        j += 1;
        true
    } else {
        false
    };
    let digits_start = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == digits_start {
        return None;
    }
    // Boundary: the token must not run into a longer identifier.
    if j < n {
        let d = b[j];
        if d.is_ascii_alphanumeric() || d == b'_' {
            return None;
        }
        if d == b'.' && j + 1 < n && (b[j + 1].is_ascii_alphanumeric() || b[j + 1] == b'_') {
            return None;
        }
    }
    let row: u32 = std::str::from_utf8(&b[digits_start..j])
        .ok()?
        .parse()
        .ok()?;
    if row == 0 {
        return None;
    }
    Some((CellAddress::new(row - 1, col), col_abs, row_abs, j))
}

/// Emit a `[$]col[$]row` address token into `out`, preserving the `$`
/// markers.
fn push_abs_addr(out: &mut String, addr: CellAddress, col_abs: bool, row_abs: bool) {
    if col_abs {
        out.push('$');
    }
    out.push_str(&col_only(addr.col));
    if row_abs {
        out.push('$');
    }
    out.push_str(&(addr.row + 1).to_string());
}

/// Scan a `[$]letters` whole-column corner at `i`. Returns `(col, col_abs,
/// end)`. Overflow-safe. `None` when no letters are present.
fn scan_abs_col_token(b: &[u8], i: usize) -> Option<(u32, bool, usize)> {
    let n = b.len();
    let mut j = i;
    let col_abs = if j < n && b[j] == b'$' {
        j += 1;
        true
    } else {
        false
    };
    let s = j;
    while j < n && b[j].is_ascii_alphabetic() {
        j += 1;
    }
    if j == s {
        return None;
    }
    let col = parse_col_letters(std::str::from_utf8(&b[s..j]).ok()?)?;
    Some((col, col_abs, j))
}

/// Try to consume a `$`-aware whole-column range `[$]A:[$]C` starting at
/// `start`. `None` when the shape is not a whole-column range. `Some(Err)`
/// when a corner was deleted (DeadRef). `Some(Ok((new_i, rewrite)))`
/// otherwise, where `rewrite` is `Some(text)` when the columns moved (`$`
/// markers preserved). Mirrors the hydrated `shift_range_corners` +
/// `contains_invalid_ref` outcome for `RangeBounds::Rows`.
fn try_shift_whole_col(
    b: &[u8],
    start: usize,
    edit: ShiftEdit,
) -> Option<Result<(usize, Option<String>), ()>> {
    let n = b.len();
    let (start_col, start_abs, after_start) = scan_abs_col_token(b, start)?;
    let j = skip_ascii_ws(b, after_start);
    if j >= n || b[j] != b':' {
        return None;
    }
    let j = skip_ascii_ws(b, j + 1);
    let (end_col, end_abs, after_end) = scan_abs_col_token(b, j)?;
    // `A:B3` — a trailing digit means the right corner was a cell address.
    if after_end < n && b[after_end].is_ascii_digit() {
        return None;
    }
    let m1 = edit.apply(CellAddress::new(0, start_col));
    let m2 = edit.apply(CellAddress::new(0, end_col));
    if m1.col == REF_INVALID_COL
        || m2.col == REF_INVALID_COL
        || (!edit.is_row_edit() && (m1.row == REF_INVALID_ROW || m2.row == REF_INVALID_ROW))
    {
        return Some(Err(()));
    }
    let rewrite = if !edit.is_row_edit() && (m1.col != start_col || m2.col != end_col) {
        let mut s = String::new();
        if start_abs {
            s.push('$');
        }
        s.push_str(&col_only(m1.col));
        s.push(':');
        if end_abs {
            s.push('$');
        }
        s.push_str(&col_only(m2.col));
        Some(s)
    } else {
        None
    };
    Some(Ok((after_end, rewrite)))
}

/// Try to consume a `$`-aware whole-row range `[$]1:[$]3` starting at
/// `start`. Same result contract as [`try_shift_whole_col`], for
/// `RangeBounds::Cols`. Mirrors `try_parse_whole_row_range`'s acceptance
/// rule (immediate `:`, digits both sides, end not followed by a letter).
fn try_shift_whole_row(
    b: &[u8],
    start: usize,
    edit: ShiftEdit,
) -> Option<Result<(usize, Option<String>), ()>> {
    let n = b.len();
    let mut j = start;
    let start_abs = if j < n && b[j] == b'$' {
        j += 1;
        true
    } else {
        false
    };
    let s1 = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == s1 {
        return None;
    }
    let r1: u32 = std::str::from_utf8(&b[s1..j]).ok()?.parse().ok()?;
    // `:` must be immediate (no whitespace).
    if j >= n || b[j] != b':' {
        return None;
    }
    j += 1;
    let end_abs = if j < n && b[j] == b'$' {
        j += 1;
        true
    } else {
        false
    };
    let s2 = j;
    while j < n && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == s2 {
        return None;
    }
    if j < n && b[j].is_ascii_alphabetic() {
        return None;
    }
    let r2: u32 = std::str::from_utf8(&b[s2..j]).ok()?.parse().ok()?;
    if r1 == 0 || r2 == 0 {
        return None;
    }
    let m1 = edit.apply(CellAddress::new(r1 - 1, 0));
    let m2 = edit.apply(CellAddress::new(r2 - 1, 0));
    if m1.row == REF_INVALID_ROW
        || m2.row == REF_INVALID_ROW
        || (edit.is_row_edit() && (m1.col == REF_INVALID_COL || m2.col == REF_INVALID_COL))
    {
        return Some(Err(()));
    }
    let rewrite = if edit.is_row_edit() && (m1.row != r1 - 1 || m2.row != r2 - 1) {
        let mut s = String::new();
        if start_abs {
            s.push('$');
        }
        s.push_str(&(m1.row + 1).to_string());
        s.push(':');
        if end_abs {
            s.push('$');
        }
        s.push_str(&(m2.row + 1).to_string());
        Some(s)
    } else {
        None
    };
    Some(Ok((j, rewrite)))
}

/// Walk an AST applying `f` to every CellRef / Range corner address.
/// Returns a new AST. Used by row/col insert/delete to retarget formulas.
///
/// Whole-column / whole-row ranges are INVARIANT on their unbounded axis:
/// inserting a row above column A's `A:A` reference doesn't move the
/// column corner. We apply `f` to a synthesized address that keeps the
/// unbounded axis at its sentinel, then restore the sentinel after the
/// shift so any per-axis mutation in `f` (e.g. a `col_insert` shift) is
/// still seen by the bounded axis.
pub fn map_addrs(expr: &Expr, f: &dyn Fn(CellAddress) -> CellAddress) -> Expr {
    match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => expr.clone(),
        Expr::CellRef(addr, abs) => Expr::CellRef(f(*addr), *abs),
        Expr::Range {
            start,
            end,
            unbounded,
            abs,
        } => {
            let (new_start, new_end) = shift_range_corners(*start, *end, *unbounded, &|a| f(a));
            Expr::Range {
                start: new_start,
                end: new_end,
                unbounded: *unbounded,
                abs: *abs,
            }
        }
        // Cross-sheet refs aren't shifted by within-sheet structural edits.
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => expr.clone(),
        Expr::SpillRef(anchor) => Expr::SpillRef(Box::new(map_addrs(anchor, f))),
        Expr::DynamicRange { start, end } => Expr::DynamicRange {
            start: Box::new(map_addrs(start, f)),
            end: Box::new(map_addrs(end, f)),
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(map_addrs(inner, f))),
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(map_addrs(left, f)),
            right: Box::new(map_addrs(right, f)),
        },
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args.iter().map(|a| map_addrs(a, f)).collect(),
        },
        // LET / future-LAMBDA bindings carry no cell address; copy as-is.
        Expr::Name(_) => expr.clone(),
        // Immediate-call form: walk both the callee subtree and the
        // argument list. The callee can itself contain CellRefs (e.g.
        // `LAMBDA(x, A1+x)(5)` keeps the `A1` reference under the
        // callee's body), and arg expressions can too.
        Expr::Call(callee, args) => Expr::Call(
            Box::new(map_addrs(callee, f)),
            args.iter().map(|a| map_addrs(a, f)).collect(),
        ),
        // Constant-array literal: cells are restricted to literals at
        // parse time, so there are no addresses to retarget. Clone the
        // node as-is.
        Expr::ArrayLit { .. } => expr.clone(),
        // Multi-area: every part is a reference subject to retargeting.
        Expr::MultiArea(parts) => Expr::MultiArea(parts.iter().map(|p| map_addrs(p, f)).collect()),
        // Structured (Table) reference: carries no A1 coordinates — it is
        // resolved against the registry at eval time, and structural edits
        // follow the Table via the registry (design doc §5.2 / §4.3), not by
        // rewriting this node. Transparent.
        Expr::TableRef { .. } => expr.clone(),
    }
}

/// Apply `f` only to the bounded axis of a Range corner, leaving the
/// unbounded axis pinned to its sentinel (`0` on start, `u32::MAX` on
/// end). Used by `map_addrs` so a row-insert never tries to shift the
/// sentinel into `u32::MAX + count` (which would overflow).
fn shift_range_corners(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    f: &dyn Fn(CellAddress) -> CellAddress,
) -> (CellAddress, CellAddress) {
    if matches!(unbounded, RangeBounds::None) {
        return (f(start), f(end));
    }
    // Build a synthetic "shiftable" CellAddress where the unbounded axis
    // is replaced by a benign value (row 0 / col 0), apply f, then put
    // back the sentinel on the unbounded axis.
    let rows_un = unbounded.rows_unbounded();
    let cols_un = unbounded.cols_unbounded();
    let synth_start = CellAddress::new(
        if rows_un { 0 } else { start.row },
        if cols_un { 0 } else { start.col },
    );
    let synth_end = CellAddress::new(
        if rows_un { 0 } else { end.row },
        if cols_un { 0 } else { end.col },
    );
    let shifted_start = f(synth_start);
    let shifted_end = f(synth_end);
    // If the bounded axis got shifted to the #REF! sentinel, leave it
    // there (eval will produce #REF!). Otherwise pin the unbounded axis
    // back to its sentinel.
    let new_start = CellAddress::new(
        if rows_un { 0 } else { shifted_start.row },
        if cols_un { 0 } else { shifted_start.col },
    );
    let new_end = CellAddress::new(
        if rows_un { u32::MAX } else { shifted_end.row },
        if cols_un { u32::MAX } else { shifted_end.col },
    );
    // Propagate #REF! invalidity from the bounded axis: if the shifted
    // bounded corner came back as REF_INVALID_* (column deletion ate the
    // referenced column), surface that sentinel on the whole corner so
    // `contains_invalid_ref` can detect it on the bounded axis.
    let new_start = if !rows_un && shifted_start.row == REF_INVALID_ROW {
        CellAddress::new(REF_INVALID_ROW, new_start.col)
    } else if !cols_un && shifted_start.col == REF_INVALID_COL {
        CellAddress::new(new_start.row, REF_INVALID_COL)
    } else {
        new_start
    };
    let new_end = if !rows_un && shifted_end.row == REF_INVALID_ROW {
        CellAddress::new(REF_INVALID_ROW, new_end.col)
    } else if !cols_un && shifted_end.col == REF_INVALID_COL {
        CellAddress::new(new_end.row, REF_INVALID_COL)
    } else {
        new_end
    };
    (new_start, new_end)
}

/// Shift every cell reference in an AST by the given (drow, dcol) delta.
/// Returns Err when a shift would push a reference out of bounds (negative).
/// Used by copy-paste so `=A1` copied from B1 to B2 becomes `=A2` (drow=1).
///
/// Range references shift both corners by the same delta. For whole-col /
/// whole-row ranges, only the bounded axis shifts (an `A:A` copied right
/// becomes `B:B`; shifted down it stays `A:A`).
pub fn shift_refs(expr: &Expr, drow: i32, dcol: i32) -> Result<Expr, ()> {
    Ok(match expr {
        Expr::Number(_) | Expr::Text(_) | Expr::Bool(_) | Expr::Error(_) => expr.clone(),
        Expr::CellRef(addr, abs) => Expr::CellRef(shift_addr(*addr, drow, dcol)?, *abs),
        Expr::Range {
            start,
            end,
            unbounded,
            abs,
        } => {
            let (s, e) = shift_range_corners_delta(*start, *end, *unbounded, drow, dcol)?;
            Expr::Range {
                start: s,
                end: e,
                unbounded: *unbounded,
                abs: *abs,
            }
        }
        // Cross-sheet refs aren't shifted on copy/paste — they point to a
        // fixed location on a different sheet regardless of paste target.
        Expr::SheetRef { .. } | Expr::SheetRange { .. } => expr.clone(),
        Expr::SpillRef(anchor) => Expr::SpillRef(Box::new(shift_refs(anchor, drow, dcol)?)),
        Expr::DynamicRange { start, end } => Expr::DynamicRange {
            start: Box::new(shift_refs(start, drow, dcol)?),
            end: Box::new(shift_refs(end, drow, dcol)?),
        },
        Expr::Negate(inner) => Expr::Negate(Box::new(shift_refs(inner, drow, dcol)?)),
        Expr::BinOp { op, left, right } => Expr::BinOp {
            op: *op,
            left: Box::new(shift_refs(left, drow, dcol)?),
            right: Box::new(shift_refs(right, drow, dcol)?),
        },
        Expr::FuncCall { name, args } => Expr::FuncCall {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| shift_refs(a, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        },
        // LET binding names carry no cell address; copy as-is.
        Expr::Name(_) => expr.clone(),
        // Immediate-call form mirrors FuncCall — walk callee + args.
        Expr::Call(callee, args) => Expr::Call(
            Box::new(shift_refs(callee, drow, dcol)?),
            args.iter()
                .map(|a| shift_refs(a, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        // Constant-array literal: no addresses to shift; clone as-is.
        Expr::ArrayLit { .. } => expr.clone(),
        // Multi-area: shift every inner reference.
        Expr::MultiArea(parts) => Expr::MultiArea(
            parts
                .iter()
                .map(|p| shift_refs(p, drow, dcol))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        // Structured (Table) reference: no A1 coordinates to shift on
        // copy/paste — it re-resolves by name at the paste target. Clone.
        Expr::TableRef { .. } => expr.clone(),
    })
}

fn shift_addr(addr: CellAddress, drow: i32, dcol: i32) -> Result<CellAddress, ()> {
    let row = (addr.row as i32) + drow;
    let col = (addr.col as i32) + dcol;
    if row < 0 || col < 0 {
        return Err(());
    }
    Ok(CellAddress::new(row as u32, col as u32))
}

/// Delta-shift the two corners of a Range, honoring the unbounded axes
/// (those stay pinned at sentinel values; no overflow on `u32::MAX +
/// drow`).
fn shift_range_corners_delta(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    drow: i32,
    dcol: i32,
) -> Result<(CellAddress, CellAddress), ()> {
    if matches!(unbounded, RangeBounds::None) {
        return Ok((shift_addr(start, drow, dcol)?, shift_addr(end, drow, dcol)?));
    }
    let rows_un = unbounded.rows_unbounded();
    let cols_un = unbounded.cols_unbounded();
    // Only shift the bounded axis.
    let new_start_row = if rows_un {
        0
    } else {
        let r = (start.row as i32) + drow;
        if r < 0 {
            return Err(());
        }
        r as u32
    };
    let new_end_row = if rows_un {
        u32::MAX
    } else {
        let r = (end.row as i32) + drow;
        if r < 0 {
            return Err(());
        }
        r as u32
    };
    let new_start_col = if cols_un {
        0
    } else {
        let c = (start.col as i32) + dcol;
        if c < 0 {
            return Err(());
        }
        c as u32
    };
    let new_end_col = if cols_un {
        u32::MAX
    } else {
        let c = (end.col as i32) + dcol;
        if c < 0 {
            return Err(());
        }
        c as u32
    };
    Ok((
        CellAddress::new(new_start_row, new_start_col),
        CellAddress::new(new_end_row, new_end_col),
    ))
}

/// Render an AST back to a formula string (for paste-and-store flows that
/// need text representation). Round-trip: parse(render(parse(s))) == parse(s).
pub fn render_formula(expr: &Expr) -> String {
    let mut out = String::from("=");
    render_into(expr, &mut out);
    out
}

/// Render a 0-based column index as letters ("A", "B", ..., "AA", ...).
/// Mirrors the private helper in `cell.rs`; duplicated here so render_into
/// doesn't have to instantiate a CellAddress + parse its repr just to drop
/// the row part.
fn col_only(mut col: u32) -> String {
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

/// Render one cell address with its `$` absolute markers (`$A$1`, `$A1`,
/// `A$1`, `A1`). Absoluteness is a written-form annotation only; the address
/// coordinates are unchanged from `to_string_repr`.
fn render_abs_addr(addr: CellAddress, abs: RefAbs, out: &mut String) {
    if abs.col {
        out.push('$');
    }
    out.push_str(&col_only(addr.col));
    if abs.row {
        out.push('$');
    }
    out.push_str(&format!("{}", addr.row + 1));
}

fn render_range_body(
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
    abs: RangeAbs,
    out: &mut String,
) {
    match unbounded {
        RangeBounds::None | RangeBounds::Both => {
            render_abs_addr(start, abs.start, out);
            out.push(':');
            render_abs_addr(end, abs.end, out);
        }
        RangeBounds::Rows => {
            // Whole-column range — only the column carries a `$`.
            if abs.start.col {
                out.push('$');
            }
            out.push_str(&col_only(start.col));
            out.push(':');
            if abs.end.col {
                out.push('$');
            }
            out.push_str(&col_only(end.col));
        }
        RangeBounds::Cols => {
            // Whole-row range — only the row carries a `$`.
            if abs.start.row {
                out.push('$');
            }
            out.push_str(&format!("{}", start.row + 1));
            out.push(':');
            if abs.end.row {
                out.push('$');
            }
            out.push_str(&format!("{}", end.row + 1));
        }
    }
}

fn render_into(expr: &Expr, out: &mut String) {
    match expr {
        Expr::Number(n) => {
            if *n == n.floor() && n.abs() < 1e15 {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{}", n));
            }
        }
        Expr::Text(s) => {
            out.push('"');
            out.push_str(s);
            out.push('"');
        }
        Expr::Bool(b) => out.push_str(if *b { "TRUE" } else { "FALSE" }),
        Expr::Error(e) => out.push_str(&e.to_string()),
        Expr::CellRef(addr, abs) => {
            if is_invalid(*addr) {
                out.push_str("#REF!");
            } else {
                render_abs_addr(*addr, *abs, out);
            }
        }
        Expr::Range {
            start,
            end,
            unbounded,
            abs,
        } => {
            // For whole-col / whole-row ranges, only the bounded axis can
            // carry a #REF! sentinel. is_invalid() checks BOTH axes, so
            // we'd false-positive on the u32::MAX sentinel. Check the
            // bounded axes explicitly.
            if range_has_invalid_ref(*start, *end, *unbounded) {
                out.push_str("#REF!");
            } else {
                render_range_body(*start, *end, *unbounded, *abs, out);
            }
        }
        Expr::SheetRef { sheet, addr, abs } => {
            if is_invalid(*addr) {
                out.push_str("#REF!");
            } else {
                out.push_str(sheet);
                out.push('!');
                render_abs_addr(*addr, *abs, out);
            }
        }
        Expr::SheetRange {
            sheet,
            start,
            end,
            unbounded,
            abs,
        } => {
            if range_has_invalid_ref(*start, *end, *unbounded) {
                out.push_str("#REF!");
            } else {
                out.push_str(sheet);
                out.push('!');
                render_range_body(*start, *end, *unbounded, *abs, out);
            }
        }
        Expr::SpillRef(anchor) => {
            render_into(anchor, out);
            out.push('#');
        }
        Expr::DynamicRange { start, end } => {
            render_into(start, out);
            out.push(':');
            render_into(end, out);
        }
        Expr::Negate(inner) => {
            out.push('-');
            render_into(inner, out);
        }
        Expr::BinOp { op, left, right } => {
            // Always parenthesize binops to avoid having to track precedence
            // on the way back. Parser handles redundant parens fine.
            out.push('(');
            render_into(left, out);
            out.push_str(match op {
                BinOperator::Add => "+",
                BinOperator::Sub => "-",
                BinOperator::Mul => "*",
                BinOperator::Div => "/",
                BinOperator::Pow => "^",
                BinOperator::Concat => "&",
                BinOperator::Eq => "=",
                BinOperator::NotEq => "<>",
                BinOperator::Lt => "<",
                BinOperator::LtEq => "<=",
                BinOperator::Gt => ">",
                BinOperator::GtEq => ">=",
            });
            render_into(right, out);
            out.push(')');
        }
        Expr::FuncCall { name, args } => {
            out.push_str(name);
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(a, out);
            }
            out.push(')');
        }
        // LET-style bound name (or future LAMBDA parameter). Round-trips
        // verbatim — the parser will rebuild the same `Expr::Name`.
        Expr::Name(n) => out.push_str(n),
        // Immediate-call: render `(callee)(args, ...)`. The wrapping
        // parens around the callee keep the round-trip unambiguous —
        // without them, `LAMBDA(x, x)(5)` and `LAMBDA(x, x(5))` would
        // share the same surface string when the callee is itself a
        // FuncCall with one body arg.
        Expr::ArrayLit { rows, cols, data } => {
            // Render `{a,b;c,d}` — comma separates columns, semicolon
            // separates rows, row-major. Round-trip with parse_formula.
            out.push('{');
            for r in 0..*rows {
                if r > 0 {
                    out.push(';');
                }
                for c in 0..*cols {
                    if c > 0 {
                        out.push(',');
                    }
                    let idx = (r as usize) * (*cols as usize) + (c as usize);
                    render_into(&data[idx], out);
                }
            }
            out.push('}');
        }
        Expr::Call(callee, args) => {
            out.push('(');
            render_into(callee, out);
            out.push(')');
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(a, out);
            }
            out.push(')');
        }
        // Multi-area: render as `(part1, part2, ...)`. Parens are
        // required for round-trip — the parser only recognises the
        // multi-area form inside parens (a bare `A1, B1` outside parens
        // would be ambiguous with a function-arg list).
        Expr::MultiArea(parts) => {
            out.push('(');
            for (i, p) in parts.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(p, out);
            }
            out.push(')');
        }
        // Structured (Table) reference. Column names in a parsed TableRef
        // can never contain `[ ] # @` (both the bare and bracketed colref
        // lexers stop at those), so single columns render bare and only
        // multi-column segments need inner brackets — the round-trip
        // (`parse(render(parse(s))) == parse(s)`) holds at the AST level.
        Expr::TableRef {
            table,
            area,
            columns,
        } => {
            if let Some(name) = table {
                out.push_str(name);
            }
            out.push('[');
            match area {
                TableArea::All => out.push_str("#All"),
                TableArea::Headers => out.push_str("#Headers"),
                TableArea::Totals => out.push_str("#Totals"),
                TableArea::Data => match columns {
                    None => out.push_str("#Data"),
                    Some((a, b)) if a == b => out.push_str(a),
                    Some((a, b)) => render_table_segment(a, b, out),
                },
                TableArea::ThisRow => {
                    out.push('@');
                    match columns {
                        None => {}
                        Some((a, b)) if a == b => out.push_str(a),
                        Some((a, b)) => render_table_segment(a, b, out),
                    }
                }
            }
            out.push(']');
        }
    }
}

/// Render a multi-column structured-reference segment `[a]:[b]` (design
/// doc §5.1). Both endpoints are bracketed so the `:` reads as the segment
/// separator on re-parse rather than as part of a bare column name.
fn render_table_segment(a: &str, b: &str, out: &mut String) {
    out.push('[');
    out.push_str(a);
    out.push_str("]:[");
    out.push_str(b);
    out.push(']');
}

/// A structured-reference rename to apply to formula text (design doc #32
/// §4.3). Table rename rewrites the `Expr::TableRef::table` field; column
/// rename rewrites the endpoints of `Expr::TableRef::columns` — but only on
/// references that target the renamed Table.
///
/// String fields are owned and matched case-insensitively; a rename is a
/// low-frequency dialog op so the allocation is irrelevant.
#[derive(Clone, Debug)]
pub(crate) enum TableRefEditSpec {
    /// `<from>[…]` → `<to>[…]` for every reference whose table name matches
    /// `from` (case-insensitively).
    RenameTable { from: String, to: String },
    /// `<table>[…<from>…]` → `<table>[…<to>…]`. `table_upper` is the
    /// uppercased target Table name; a table-less `[Col]` reference is only
    /// rewritten when the caller passes `apply_bare` (its cell sits inside
    /// the renamed Table).
    RenameColumn {
        table_upper: String,
        from: String,
        to: String,
    },
}

/// Rewrite `Expr::TableRef` nodes per `spec`, returning `Some(new)` iff any
/// node changed (so callers skip untouched formulas). `apply_bare` toggles
/// whether table-less `[Col]` references count as targeting the renamed
/// Table — set by the driver per formula cell (design doc #32 §4.3).
///
/// The node carries no A1 coordinates, so this is the ONLY structural-edit
/// walker that touches a Table reference; `map_addrs` / `shift_refs` leave
/// it transparent. Every child-bearing variant is recursed explicitly;
/// leaves (and `ArrayLit`, whose cells are literals only) can hold no
/// `TableRef` and return `None`.
pub(crate) fn rewrite_table_refs(
    expr: &Expr,
    spec: &TableRefEditSpec,
    apply_bare: bool,
) -> Option<Expr> {
    match expr {
        Expr::TableRef {
            table,
            area,
            columns,
        } => match spec {
            TableRefEditSpec::RenameTable { from, to } => match table {
                Some(t) if t.eq_ignore_ascii_case(from) => Some(Expr::TableRef {
                    table: Some(to.clone()),
                    area: *area,
                    columns: columns.clone(),
                }),
                _ => None,
            },
            TableRefEditSpec::RenameColumn {
                table_upper,
                from,
                to,
            } => {
                let targets = match table {
                    Some(t) => t.eq_ignore_ascii_case(table_upper),
                    None => apply_bare,
                };
                if !targets {
                    return None;
                }
                let (a, b) = columns.as_ref()?;
                let na = if a.eq_ignore_ascii_case(from) {
                    to.clone()
                } else {
                    a.clone()
                };
                let nb = if b.eq_ignore_ascii_case(from) {
                    to.clone()
                } else {
                    b.clone()
                };
                if &na == a && &nb == b {
                    return None;
                }
                Some(Expr::TableRef {
                    table: table.clone(),
                    area: *area,
                    columns: Some((na, nb)),
                })
            }
        },
        Expr::Negate(inner) => {
            rewrite_table_refs(inner, spec, apply_bare).map(|e| Expr::Negate(Box::new(e)))
        }
        Expr::BinOp { op, left, right } => {
            let l = rewrite_table_refs(left, spec, apply_bare);
            let r = rewrite_table_refs(right, spec, apply_bare);
            if l.is_none() && r.is_none() {
                return None;
            }
            Some(Expr::BinOp {
                op: *op,
                left: Box::new(l.unwrap_or_else(|| (**left).clone())),
                right: Box::new(r.unwrap_or_else(|| (**right).clone())),
            })
        }
        Expr::FuncCall { name, args } => {
            rewrite_table_ref_children(args, spec, apply_bare).map(|args| Expr::FuncCall {
                name: name.clone(),
                args,
            })
        }
        Expr::Call(callee, args) => {
            let c = rewrite_table_refs(callee, spec, apply_bare);
            let a = rewrite_table_ref_children(args, spec, apply_bare);
            if c.is_none() && a.is_none() {
                return None;
            }
            Some(Expr::Call(
                Box::new(c.unwrap_or_else(|| (**callee).clone())),
                a.unwrap_or_else(|| args.clone()),
            ))
        }
        Expr::MultiArea(parts) => {
            rewrite_table_ref_children(parts, spec, apply_bare).map(Expr::MultiArea)
        }
        Expr::SpillRef(anchor) => {
            rewrite_table_refs(anchor, spec, apply_bare).map(|e| Expr::SpillRef(Box::new(e)))
        }
        Expr::DynamicRange { start, end } => {
            let s = rewrite_table_refs(start, spec, apply_bare);
            let e = rewrite_table_refs(end, spec, apply_bare);
            if s.is_none() && e.is_none() {
                return None;
            }
            Some(Expr::DynamicRange {
                start: Box::new(s.unwrap_or_else(|| (**start).clone())),
                end: Box::new(e.unwrap_or_else(|| (**end).clone())),
            })
        }
        _ => None,
    }
}

fn rewrite_table_ref_children(
    children: &[Expr],
    spec: &TableRefEditSpec,
    apply_bare: bool,
) -> Option<Vec<Expr>> {
    let mut any = false;
    let mut out = Vec::with_capacity(children.len());
    for child in children {
        match rewrite_table_refs(child, spec, apply_bare) {
            Some(new_child) => {
                any = true;
                out.push(new_child);
            }
            None => out.push(child.clone()),
        }
    }
    if any {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formula::parse_formula;

    fn shifted(input: &str, drow: i32, dcol: i32) -> String {
        let expr = parse_formula(input).expect("parse");
        let shifted = shift_refs(&expr, drow, dcol).expect("shift");
        render_formula(&shifted)
    }

    #[test]
    fn shift_simple_ref_down() {
        assert_eq!(shifted("=A1", 1, 0), "=A2");
    }

    #[test]
    fn shift_simple_ref_right() {
        assert_eq!(shifted("=A1", 0, 1), "=B1");
    }

    #[test]
    fn shift_range() {
        assert_eq!(shifted("=SUM(A1:B2)", 1, 1), "=SUM(B2:C3)");
    }

    #[test]
    fn shift_function_call() {
        assert_eq!(shifted("=IF(A1>0,A1,B1)", 0, 1), "=IF((B1>0),B1,C1)");
    }

    #[test]
    fn shift_negative_oob_errors() {
        let expr = parse_formula("=A1").unwrap();
        assert!(shift_refs(&expr, -1, 0).is_err());
    }

    #[test]
    fn render_roundtrip() {
        let original = "=SUM(A1:A10)+IF(B1>0,B1*2,0)";
        let parsed = parse_formula(original).unwrap();
        let rendered = render_formula(&parsed);
        // Re-parsing the rendered output produces the same AST.
        let reparsed = parse_formula(&rendered).unwrap();
        assert_eq!(parsed, reparsed);
    }

    // === Phase 2 Track G — whole-col / whole-row round-trips ===

    #[test]
    fn render_whole_col_roundtrip() {
        for syntax in ["=SUM(A:A)", "=SUM(A:C)", "=A:A", "=SUM(AA:AC)"] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn render_whole_row_roundtrip() {
        for syntax in ["=SUM(1:1)", "=SUM(1:3)", "=SUM(100:200)"] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn render_array_literal_roundtrip() {
        // Parse → render → parse yields the same AST for the
        // constant-array literal syntax. Covers single-row, single-col,
        // 2D, and embedded-in-SUM shapes.
        for syntax in [
            "={1,2,3}",
            "={1;2;3}",
            "={1,2;3,4}",
            "={-1,2}",
            "={#N/A,#CALC!}",
            "=SUM({10,20,30})",
        ] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn shift_whole_col_invariant_under_row_shift() {
        // Whole-column ref stays put when shifted down — the column
        // corner is invariant on the row axis.
        assert_eq!(shifted("=SUM(A:A)", 5, 0), "=SUM(A:A)");
        // But shifting right moves the bounded column.
        assert_eq!(shifted("=SUM(A:A)", 0, 1), "=SUM(B:B)");
    }

    #[test]
    fn shift_whole_row_invariant_under_col_shift() {
        // Whole-row ref stays put when shifted right.
        assert_eq!(shifted("=SUM(1:1)", 0, 5), "=SUM(1:1)");
        // But shifting down moves the bounded row.
        assert_eq!(shifted("=SUM(1:1)", 2, 0), "=SUM(3:3)");
    }

    #[test]
    fn render_multi_area_roundtrip() {
        // Multi-area parse → render → parse yields the same AST.
        for syntax in [
            "=AREAS((A1:B2,D5:E6))",
            "=AREAS((A1:B2,D5:E6,F1))",
            "=(A1,B2)",
        ] {
            let parsed = parse_formula(syntax).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "round-trip {} -> {}", syntax, rendered);
        }
    }

    #[test]
    fn shift_multi_area_shifts_each_part() {
        // Multi-area shifts every inner reference by the same delta.
        assert_eq!(shifted("=AREAS((A1:B2,D5))", 1, 1), "=AREAS((B2:C3,E6))");
    }

    // === AUDIT A-1 — parked-source token rewrite ===
    //
    // Contract under test: for every parseable source,
    // `hydrate(rewrite(src))` must equal `retarget(hydrate(src))` —
    // i.e. parsing the rewritten text yields the same AST as
    // `map_addrs` over the parse of the original text.

    fn assert_rewrite_matches_ast(src: &str, edit: ShiftEdit) {
        let rewritten = match rewrite_parked_source(src, edit) {
            SourceRewrite::Unchanged => src.to_string(),
            SourceRewrite::Rewritten(s) => s,
            SourceRewrite::DeadRef => {
                // The AST path must agree the formula dies.
                let expr = parse_formula(src).expect("parseable");
                let mapped = map_addrs(&expr, &|a| edit.apply(a));
                assert!(
                    contains_invalid_ref(&mapped),
                    "scanner said DeadRef but AST retarget survives: {src}"
                );
                return;
            }
        };
        let expr = parse_formula(src).expect("original must parse");
        let mapped = map_addrs(&expr, &|a| edit.apply(a));
        assert!(
            !contains_invalid_ref(&mapped),
            "AST retarget died but scanner rewrote: {src}"
        );
        let reparsed = parse_formula(&rewritten)
            .unwrap_or_else(|| panic!("rewritten must parse: {src} -> {rewritten}"));
        assert_eq!(
            mapped, reparsed,
            "rewrite mismatch for {src} -> {rewritten} under {edit:?}"
        );
    }

    #[test]
    fn parked_rewrite_matches_ast_retarget_corpus() {
        let edits = [
            ShiftEdit::RowInsert { at: 0, count: 1 },
            ShiftEdit::RowInsert { at: 2, count: 3 },
            ShiftEdit::RowDelete { at: 0, count: 1 },
            ShiftEdit::RowDelete { at: 1, count: 2 },
            ShiftEdit::ColInsert { at: 0, count: 1 },
            ShiftEdit::ColInsert { at: 1, count: 2 },
            ShiftEdit::ColDelete { at: 0, count: 1 },
            ShiftEdit::ColDelete { at: 2, count: 1 },
        ];
        let corpus = [
            "=A1",
            "=A5+B7*2",
            "=SUM(A1:B5)",
            "=SUM(A1:A10)+IF(B1>0,B1*2,0)",
            "=SUM(A:C)",
            "=SUM(1:3)",
            "=A1:B2 + SUM( C3 : D4 )",
            "=IF(A2>0,\"A2\",\"B9\")&C3",
            "=LOG10(A2)+ATAN2(B3,C4)",
            "=Data!A1+B2",
            "=Data!A1:B3+C4",
            "=SEQUENCE(3)",
            "=B1#",
            "=INDEX(A:A,3)",
            "=A1:INDEX(B:B,5)",
            "=LET(x, A5, x*2)",
            "=TRUE+FALSE",
            "=RANK.EQ(A2,B1:B9)",
            "={1,2;3,4}",
            "=AREAS((A1:B2,D5:E6))",
            "=#REF!+A2",
            "=\"literal A1:B2 stays\"&A3",
            "=a5+b7", // lowercase refs are valid and shift
            // Absolute / mixed references: the parked scanner must match the
            // hydrated `map_addrs` retarget exactly, `$` markers included.
            "=$A$5",
            "=A$5+$B7*2",
            "=SUM($A$1:$B$5)",
            "=$A$1:B$2 + SUM( $C3 : D$4 )",
            "=SUM($A:$C)",
            "=SUM($1:$3)",
            "=Data!$A$1+$B2",
            "=$B1#",
            "=$A$1:INDEX($B:$B,5)",
            "=IF($A2>0,\"$A$2\",\"B9\")&$C3",
        ];
        for edit in edits {
            for src in corpus {
                assert_rewrite_matches_ast(src, edit);
            }
        }
    }

    #[test]
    fn parked_rewrite_unchanged_when_refs_below_boundary() {
        // No allocation contract: refs strictly above the insert point
        // report Unchanged.
        assert_eq!(
            rewrite_parked_source("=A1+B2", ShiftEdit::RowInsert { at: 5, count: 1 }),
            SourceRewrite::Unchanged
        );
        assert_eq!(
            rewrite_parked_source("=SUM(A1:B3)", ShiftEdit::ColInsert { at: 9, count: 2 }),
            SourceRewrite::Unchanged
        );
    }

    #[test]
    fn parked_rewrite_quoted_strings_and_function_names_survive() {
        let got = rewrite_parked_source(
            "=IF(A2>0,\"A2 ok\",\"skip B9\")&LOG10(C3)",
            ShiftEdit::RowInsert { at: 0, count: 1 },
        );
        assert_eq!(
            got,
            SourceRewrite::Rewritten("=IF(A3>0,\"A2 ok\",\"skip B9\")&LOG10(C4)".into())
        );
    }

    #[test]
    fn parked_rewrite_cross_sheet_refs_untouched() {
        // Within-sheet edits never shift sheet-qualified refs (mirrors
        // `map_addrs`), including a sheet NAME that looks like a ref.
        assert_eq!(
            rewrite_parked_source(
                "=Data!A1+Data!B2:C3",
                ShiftEdit::RowInsert { at: 0, count: 1 }
            ),
            SourceRewrite::Unchanged
        );
        assert_eq!(
            rewrite_parked_source("=B2!A1", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Unchanged
        );
        // Same-sheet refs around a cross-sheet ref still shift.
        assert_eq!(
            rewrite_parked_source("=Data!A1+B2", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=Data!A1+B3".into())
        );
    }

    #[test]
    fn parked_rewrite_deleted_band_is_dead() {
        assert_eq!(
            rewrite_parked_source("=B5*2", ShiftEdit::RowDelete { at: 4, count: 1 }),
            SourceRewrite::DeadRef
        );
        assert_eq!(
            rewrite_parked_source("=SUM(A1:B5)", ShiftEdit::ColDelete { at: 0, count: 1 }),
            SourceRewrite::DeadRef
        );
        // Range corner survives a delete inside the band interior.
        assert_eq!(
            rewrite_parked_source("=SUM(1:3)", ShiftEdit::RowDelete { at: 1, count: 1 }),
            SourceRewrite::Rewritten("=SUM(1:2)".into())
        );
    }

    #[test]
    fn parked_rewrite_whole_row_whole_col_axis_rules() {
        // Row edits move whole-row ranges, leave whole-col ranges.
        assert_eq!(
            rewrite_parked_source("=SUM(2:3)", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=SUM(3:4)".into())
        );
        assert_eq!(
            rewrite_parked_source("=SUM(B:C)", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Unchanged
        );
        // Col edits: the mirror image.
        assert_eq!(
            rewrite_parked_source("=SUM(B:C)", ShiftEdit::ColInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=SUM(C:D)".into())
        );
        assert_eq!(
            rewrite_parked_source("=SUM(2:3)", ShiftEdit::ColInsert { at: 0, count: 1 }),
            SourceRewrite::Unchanged
        );
        // Deleting the pinned corner column kills a whole-row range —
        // quirky but exactly what `shift_range_corners` +
        // `contains_invalid_ref` produce on the hydrated path.
        assert_eq!(
            rewrite_parked_source("=SUM(1:3)", ShiftEdit::ColDelete { at: 0, count: 1 }),
            SourceRewrite::DeadRef
        );
        assert_eq!(
            rewrite_parked_source("=SUM(B:C)", ShiftEdit::RowDelete { at: 0, count: 1 }),
            SourceRewrite::DeadRef
        );
    }

    #[test]
    fn parked_rewrite_hostile_text_never_panics() {
        // Garbage sources (reachable via bulk_install_storage, which
        // parks without validating) must scan without panicking —
        // including letter runs that would overflow the naive
        // column-letter arithmetic.
        for src in [
            "=ABCDEFGHIJKLMNOP123",
            "=ZZZZZZZZZZ:ZZZZZZZZZZ",
            "=99999999999999999999:3",
            "=1.5:3",
            "=A1++",
            "=\"unterminated",
            "=日本語+A2",
            "=0:0",
        ] {
            let _ = rewrite_parked_source(src, ShiftEdit::RowInsert { at: 0, count: 1 });
            let _ = rewrite_parked_source(src, ShiftEdit::ColDelete { at: 0, count: 1 });
        }
    }

    #[test]
    fn parked_rewrite_spill_ref_shifts_anchor() {
        assert_eq!(
            rewrite_parked_source("=B1#", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=B2#".into())
        );
    }

    // ================= Absolute references (`$A$1`) round-trip =================

    #[test]
    fn render_absolute_refs_byte_exact() {
        // Requirement #2: a stored `$` form reads back with its `$` intact.
        // These simple refs carry no binop parens, so render is byte-exact
        // with the source (the hydrated retarget path re-renders via exactly
        // this function into `formula_texts` / `get_formula`).
        for s in [
            "=$A$1",
            "=$A1",
            "=A$1",
            "=A1",
            "=$A$2:$B$4",
            "=$A2:B$4",
            "=A1:$B$2",
            "=Sheet1!$A$1",
            "=Sheet1!$A$2:$B$4",
            "=$A:$C",
            "=A:$C",
            "=$1:$3",
            "=$A$1#",
        ] {
            let parsed = parse_formula(s).unwrap();
            assert_eq!(render_formula(&parsed), s, "byte round-trip for {s}");
        }
    }

    #[test]
    fn render_absolute_refs_ast_roundtrip() {
        // Property: parse -> render -> parse == parse, across `$` combos
        // embedded in binops / function calls.
        for s in [
            "=$A$1+$B2*C$3",
            "=SUM($A$2:$B$4)",
            "=SUM($A2:B$4)",
            "=SUM(Sheet1!$A$1:$C$9)",
            "=SUM($A:$C)+SUM($1:$3)",
            "=IF($A$1>0,$B$1,C1)",
        ] {
            let parsed = parse_formula(s).unwrap();
            let rendered = render_formula(&parsed);
            let reparsed = parse_formula(&rendered).unwrap();
            assert_eq!(parsed, reparsed, "AST round-trip {s} -> {rendered}");
        }
    }

    #[test]
    fn structural_shift_preserves_absolute_markers() {
        // Requirement #3 (hydrated path): Excel shifts `$A$5` to `$A$6` on a
        // row insert — the ADDRESS moves, the `$` markers STAY.
        let shift = |src: &str, edit: ShiftEdit| {
            let expr = parse_formula(src).unwrap();
            render_formula(&map_addrs(&expr, &|a| edit.apply(a)))
        };
        assert_eq!(
            shift("=$A$5", ShiftEdit::RowInsert { at: 0, count: 1 }),
            "=$A$6"
        );
        assert_eq!(
            shift("=SUM($A$2:$B$4)", ShiftEdit::RowInsert { at: 0, count: 2 }),
            "=SUM($A$4:$B$6)"
        );
        assert_eq!(
            shift("=$A2:B$4", ShiftEdit::ColInsert { at: 0, count: 1 }),
            "=$B2:C$4"
        );
        // Absolute whole-column keeps `$` while the column shifts.
        assert_eq!(
            shift("=SUM($B:$C)", ShiftEdit::ColInsert { at: 0, count: 1 }),
            "=SUM($C:$D)"
        );
        // Deleting the referenced row still collapses to #REF!, `$` or not.
        assert_eq!(
            shift("=$A$5", ShiftEdit::RowDelete { at: 4, count: 1 }),
            "=#REF!"
        );
    }

    #[test]
    fn parked_rewrite_absolute_refs_preserve_markers() {
        // Requirement #3 (lazy/parked path): the token scanner shifts the
        // address and re-emits the `$`.
        assert_eq!(
            rewrite_parked_source("=$A$5", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=$A$6".into())
        );
        assert_eq!(
            rewrite_parked_source("=A$5*$B2", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=A$6*$B3".into())
        );
        assert_eq!(
            rewrite_parked_source("=SUM($A$2:$B$4)", ShiftEdit::ColInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=SUM($B$2:$C$4)".into())
        );
        // Cross-sheet absolute refs are NOT shifted by a within-sheet edit.
        assert_eq!(
            rewrite_parked_source("=Data!$A$1+$B$2", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=Data!$A$1+$B$3".into())
        );
        // Absolute whole-column / whole-row keep `$` on the bounded axis.
        assert_eq!(
            rewrite_parked_source("=SUM($B:$C)", ShiftEdit::ColInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=SUM($C:$D)".into())
        );
        assert_eq!(
            rewrite_parked_source("=SUM($2:$3)", ShiftEdit::RowInsert { at: 0, count: 1 }),
            SourceRewrite::Rewritten("=SUM($3:$4)".into())
        );
        // Deleting the referenced row kills the formula, absolute or not.
        assert_eq!(
            rewrite_parked_source("=$B$5", ShiftEdit::RowDelete { at: 4, count: 1 }),
            SourceRewrite::DeadRef
        );
    }
}
