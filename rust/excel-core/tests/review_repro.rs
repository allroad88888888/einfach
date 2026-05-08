//! 回归测试 — 来自代码 review 的发现。
//! 标 `#[ignore]` 的测试期望行为是修复后的目标。修复后应去 ignore 让测试通过。
//! 详见 `rust/docs/ISSUES.md`。

use einfach_core::{Value, ValueError};
use einfach_excel_core::Sheet;

/// ISSUES B.12: `batch_set` 不会像 `set_cell` 那样清掉已有公式。
/// 期望：批量写入到一个公式格之后，公式被清除。
#[test]
#[ignore = "B.12: batch_set 不清 formula_cells，已知 bug"]
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
#[test]
#[ignore = "B.1: cell_map 快照，已知 bug"]
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
/// 当前实际因 cell_map 快照绕过检测，读到 primitive 初值。
#[test]
#[ignore = "B.2: 自引用绕过环检测，已知 bug"]
fn self_referential_formula_should_be_cycle_error() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=A1+1");
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::CyclicRef));
}

/// ISSUES B.2: 互引用公式同样应返回 `#CYCLE!`。
#[test]
#[ignore = "B.2: 互引用绕过环检测，已知 bug"]
fn mutual_referential_formulas_should_be_cycle_error() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=B1+1");
    sheet.set_formula("B1", "=A1+1");
    assert_eq!(sheet.get_cell("A1"), Value::Error(ValueError::CyclicRef));
    assert_eq!(sheet.get_cell("B1"), Value::Error(ValueError::CyclicRef));
}

/// 文档化当前 buggy 行为，便于修复后对照消除（修了之后这个测试会失败）。
/// - `=A1+1` 写到 A1：A1 = Number(1.0)（应该是 #CYCLE!）
/// - `A1=B1+1, B1=A1+1`：A1=1, B1=2（应该都是 #CYCLE!）
#[test]
fn document_current_buggy_cycle_behavior() {
    let mut sheet = Sheet::new();
    sheet.set_formula("A1", "=A1+1");
    assert_eq!(
        sheet.get_cell("A1"),
        Value::Number(1.0),
        "当前 buggy 行为：自引用读 primitive Null=0+1=1。修 B.1/B.2 后此断言会失败，改 #CYCLE!"
    );

    let mut sheet2 = Sheet::new();
    sheet2.set_formula("A1", "=B1+1");
    sheet2.set_formula("B1", "=A1+1");
    assert_eq!(sheet2.get_cell("A1"), Value::Number(1.0));
    assert_eq!(sheet2.get_cell("B1"), Value::Number(2.0));
}
