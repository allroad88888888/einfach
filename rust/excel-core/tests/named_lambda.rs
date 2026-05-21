//! Integration tests for defined-name LAMBDA registration on `Workbook`.
//!
//! Covers:
//! - `define_name("inc", "=LAMBDA(x, x+1)")` → callable as `=inc(10)`
//! - Named LAMBDA inside dynamic-array higher-order calls (MAP +
//!   SEQUENCE) so the spill machinery sees the named lambda the same
//!   way it would see an inline `LAMBDA(...)`.
//! - `undefine_name` invalidates downstream formulas (next read
//!   surfaces #NAME? for cells that referenced the dropped name).
//! - Recursive named LAMBDA (fib) bottoms out correctly.
//! - Reserved-name rejection: `define_name("SUM", ...)` returns
//!   `WorkbookError::ReservedName` so the user can't shadow built-ins.
//! - Non-callable named values (e.g. a stored Number) work in
//!   `Expr::Name` position and surface #VALUE! when invoked as a
//!   function.
//!
//! Implementation lives in:
//! - `rust/excel-core/src/workbook.rs` — `named_values` field,
//!   `define_name` / `undefine_name` / `get_named`, `WorkbookError`,
//!   `invalidate_formulas_using_name`.
//! - `rust/excel-core/src/eval.rs` — `EvalProvider::lookup_named`,
//!   `Expr::Name` / `Expr::FuncCall` fallthrough, recursion guard.

use einfach_core::{Value, ValueError};
use einfach_excel_core::{Workbook, WorkbookError};

/// Smallest path: register a LAMBDA under a name, call it from a cell.
#[test]
fn defined_lambda_callable_as_function() {
    let mut wb = Workbook::new();
    wb.define_name("inc", "=LAMBDA(x, x+1)").unwrap();
    assert!(wb.set_formula(0, "A1", "=inc(10)"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(11.0));
}

/// Defined lambdas are interchangeable with inline LAMBDA literals as
/// the second arg to MAP — the result still spills, the worker still
/// observes the array shape, and reads against B1:B3 return the per-
/// element scalars.
#[test]
fn defined_lambda_works_inside_map() {
    let mut wb = Workbook::new();
    wb.define_name("inc", "=LAMBDA(x, x+1)").unwrap();
    assert!(wb.set_formula(0, "A1", "=MAP(SEQUENCE(3), inc)"));
    // Anchor returns the 3x1 Array; spilled targets A2/A3 return their
    // scalar cells through the derived-atom path that all higher-order
    // functions share.
    match wb.get_cell("Sheet1", "A1") {
        Value::Array(arr) => {
            assert_eq!(arr.shape(), (3, 1));
            assert_eq!(arr.get(0, 0), Some(&Value::Number(2.0)));
            assert_eq!(arr.get(1, 0), Some(&Value::Number(3.0)));
            assert_eq!(arr.get(2, 0), Some(&Value::Number(4.0)));
        }
        other => panic!("expected Array spill at A1, got {other:?}"),
    }
    assert_eq!(wb.get_cell("Sheet1", "A2"), Value::Number(3.0));
    assert_eq!(wb.get_cell("Sheet1", "A3"), Value::Number(4.0));
}

/// Removing a defined name dirties cells that referenced it, so the
/// next read returns `#NAME?` instead of the cached value.
#[test]
fn undefining_name_invalidates_dependent_formulas() {
    let mut wb = Workbook::new();
    wb.define_name("inc", "=LAMBDA(x, x+1)").unwrap();
    assert!(wb.set_formula(0, "A1", "=inc(10)"));
    assert!(wb.set_formula(0, "B1", "=inc(20)"));
    // Establish baseline + warm the formula cache.
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(11.0));
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Number(21.0));

    assert!(wb.undefine_name("inc"));

    // After removal, both formulas re-evaluate against the empty
    // registry and surface #NAME? (no built-in by that name either).
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::InvalidName)
    );
    assert_eq!(
        wb.get_cell("Sheet1", "B1"),
        Value::Error(ValueError::InvalidName)
    );
}

/// Re-defining a name (without an explicit `undefine` first) replaces
/// the prior entry and invalidates downstream formulas so they re-
/// evaluate against the new definition.
#[test]
fn redefining_name_swaps_value_and_invalidates_consumers() {
    let mut wb = Workbook::new();
    wb.define_name("k", "=2").unwrap();
    assert!(wb.set_formula(0, "A1", "=k+1"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(3.0));

    wb.define_name("k", "=10").unwrap();
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(11.0));
}

/// Recursive named LAMBDA — fibonacci. `fib(7)` should be 13. The
/// body's two recursive `fib(...)` calls resolve through the workbook
/// registry; the recursion guard caps depth at 256 so a normal-sized
/// fib doesn't trip it.
#[test]
fn recursive_named_lambda_fibonacci() {
    let mut wb = Workbook::new();
    wb.define_name("fib", "=LAMBDA(n, IF(n<=1, n, fib(n-1)+fib(n-2)))")
        .unwrap();
    assert!(wb.set_formula(0, "A1", "=fib(7)"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(13.0));
}

/// Recursive named LAMBDA — factorial. `factorial(5) = 120`. (`fact`
/// collides with the built-in `FACT` arm so we use a non-reserved
/// name; see `reserved_builtin_names_are_rejected` for the collision
/// case.)
#[test]
fn recursive_named_lambda_factorial() {
    let mut wb = Workbook::new();
    wb.define_name("factorial", "=LAMBDA(n, IF(n<=1, 1, n*factorial(n-1)))")
        .unwrap();
    assert!(wb.set_formula(0, "A1", "=factorial(5)"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(120.0));
}

/// Pathological recursion hits the depth cap and returns #NUM! instead
/// of overflowing the OS stack.
#[test]
fn pathological_recursion_returns_num_error() {
    let mut wb = Workbook::new();
    wb.define_name("bad", "=LAMBDA(n, bad(n))").unwrap();
    assert!(wb.set_formula(0, "A1", "=bad(1)"));
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Error(ValueError::Overflow)
    );
}

/// Names that collide with built-ins are rejected at definition time.
#[test]
fn reserved_builtin_names_are_rejected() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_name("SUM", "=LAMBDA(x, x)").unwrap_err(),
        WorkbookError::ReservedName
    );
    assert_eq!(
        wb.define_name("if", "=LAMBDA(x, x)").unwrap_err(),
        WorkbookError::ReservedName
    );
    // Case-insensitive collision: lower-case `lambda` shadows the
    // built-in `LAMBDA` arm.
    assert_eq!(
        wb.define_name("lambda", "=LAMBDA(x, x)").unwrap_err(),
        WorkbookError::ReservedName
    );
}

/// Invalid identifiers (leading digit, dotted form, empty, too long)
/// are rejected before we ever touch the registry.
#[test]
fn invalid_identifiers_are_rejected() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_name("", "=1").unwrap_err(),
        WorkbookError::InvalidName
    );
    assert_eq!(
        wb.define_name("1foo", "=1").unwrap_err(),
        WorkbookError::InvalidName
    );
    assert_eq!(
        wb.define_name("has space", "=1").unwrap_err(),
        WorkbookError::InvalidName
    );
    assert_eq!(
        wb.define_name("dotted.name", "=1").unwrap_err(),
        WorkbookError::InvalidName
    );
    let too_long = "a".repeat(256);
    assert_eq!(
        wb.define_name(&too_long, "=1").unwrap_err(),
        WorkbookError::InvalidName
    );
}

/// Bad formula text surfaces `ParseFailed`; bad eval surfaces
/// `EvalFailed`.
#[test]
fn parse_and_eval_failures_propagate() {
    let mut wb = Workbook::new();
    assert_eq!(
        wb.define_name("a", "no equals sign").unwrap_err(),
        WorkbookError::ParseFailed
    );
    // `=1/0` parses fine but eval surfaces #DIV/0!.
    assert_eq!(
        wb.define_name("zero", "=1/0").unwrap_err(),
        WorkbookError::EvalFailed(ValueError::DivisionByZero)
    );
    // Registry left unchanged on either error path.
    assert!(wb.get_named("a").is_none());
    assert!(wb.get_named("zero").is_none());
}

/// A non-LAMBDA named value works in `Expr::Name` position (returns
/// the stored value) but surfaces #VALUE! when invoked as a function.
#[test]
fn non_lambda_named_value_call_is_value_error() {
    let mut wb = Workbook::new();
    wb.define_name("answer", "=42").unwrap();
    assert!(wb.set_formula(0, "A1", "=answer"));
    assert!(wb.set_formula(0, "A2", "=answer()"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(42.0));
    assert_eq!(
        wb.get_cell("Sheet1", "A2"),
        Value::Error(ValueError::InvalidValue)
    );
}

/// `get_named` returns the registered value (case-insensitive lookup).
#[test]
fn get_named_round_trip() {
    let mut wb = Workbook::new();
    wb.define_name("Tax_Rate", "=0.08").unwrap();
    assert_eq!(wb.get_named("tax_rate"), Some(Value::Number(0.08)));
    assert_eq!(wb.get_named("TAX_RATE"), Some(Value::Number(0.08)));
    assert_eq!(wb.get_named("Tax_Rate"), Some(Value::Number(0.08)));
    assert_eq!(wb.get_named("missing"), None);
}

/// `undefine_name` returns `false` for an unknown name and doesn't
/// touch the registry / dirty propagation.
#[test]
fn undefine_unknown_name_is_noop() {
    let mut wb = Workbook::new();
    assert!(!wb.undefine_name("never_defined"));
    wb.define_name("k", "=1").unwrap();
    assert!(wb.undefine_name("k"));
    // Idempotent.
    assert!(!wb.undefine_name("k"));
}

/// LET inside a cell formula shadows a defined name: integration-test
/// the eval order at the workbook boundary.
#[test]
fn let_in_formula_shadows_workbook_name() {
    let mut wb = Workbook::new();
    wb.define_name("answer", "=42").unwrap();
    assert!(wb.set_formula(0, "A1", "=LET(answer, 1, answer*2)"));
    assert_eq!(wb.get_cell("Sheet1", "A1"), Value::Number(2.0));
}

/// Defined names enumerate in canonical case via `named_names`.
#[test]
fn named_names_returns_canonical_case() {
    let mut wb = Workbook::new();
    wb.define_name("Tax_Rate", "=0.08").unwrap();
    wb.define_name("inc", "=LAMBDA(x, x+1)").unwrap();
    let names: Vec<String> = wb.named_names().map(str::to_string).collect();
    // Sorted by uppercased key — `inc` (key INC) precedes `Tax_Rate`
    // (key TAX_RATE).
    assert_eq!(names, vec!["inc".to_string(), "Tax_Rate".to_string()]);
}
