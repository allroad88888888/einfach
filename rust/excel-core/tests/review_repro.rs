//! 回归测试 — 来自代码 review 的发现。
//! 标 `#[ignore]` 的测试期望行为是修复后的目标。修复后应去 ignore 让测试通过。
//! 详见 `rust/docs/ISSUES.md`。

use einfach_core::{Value, ValueError};
use einfach_excel_core::Sheet;

/// ISSUES B.12: `batch_set` 不会像 `set_cell` 那样清掉已有公式。
/// 1A step 5 修复后通过。
#[test]
fn batch_set_should_clear_formula() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_formula("B1", "=A1*2");
    assert_eq!(sheet.get_cell("B1"), Value::Number(20.0));

    sheet.batch_set(&[("B1", Value::Number(99.0))]);
    assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));

    sheet.set_cell("A1", Value::Number(100.0));
    assert_eq!(sheet.get_cell("B1"), Value::Number(99.0));
}

/// ISSUES B.1: cell_map 快照让"先建公式引用某 cell，后给该 cell 加公式"的场景失败。
/// 1A step 4 修复后通过。
#[test]
fn formula_referencing_cell_that_later_becomes_formula() {
    let mut sheet = Sheet::new();
    sheet.set_cell("A1", Value::Number(10.0));
    sheet.set_formula("D1", "=E1");
    assert_eq!(sheet.get_cell("D1"), Value::Null);

    sheet.set_formula("E1", "=A1*2");
    assert_eq!(sheet.get_cell("E1"), Value::Number(20.0));
    assert_eq!(sheet.get_cell("D1"), Value::Number(20.0));

    sheet.set_cell("A1", Value::Number(5.0));
    assert_eq!(sheet.get_cell("D1"), Value::Number(10.0));
}

/// ISSUES B.2: 自引用公式应返回 `#CYCLE!`，
/// 1A step 4 加了静态环检测后修复。
#[test]
fn self_referential_formula_should_be_cycle_error() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=A1+1");
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::CyclicRef));
}

/// ISSUES B.2: 互引用公式同样应返回 `#CYCLE!`。
#[test]
fn mutual_referential_formulas_should_be_cycle_error() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=B1+1");
    sheet.set_formula("B1", "=A1+1");
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::CyclicRef));
    assert_eq!(sheet.get_cell("B1"), Value::Error(ValueError::CyclicRef));
}

// (the previous `document_current_buggy_cycle_behavior` test has been
// removed: B.1/B.2 are fixed in 1A step 4 and the canonical regression
// tests above are now the source of truth)
