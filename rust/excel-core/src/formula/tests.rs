use crate::cell::{CellAddress, CellReference};
use einfach_core::ValueError;

use super::{
    parse_formula, serialize_formula, shift_formula_input, BinOperator, Expr,
};

fn cell(row: u32, col: u32) -> Expr {
    Expr::CellRef(CellReference::from_addr(CellAddress::new(row, col)))
}

fn absolute(row: u32, col: u32, abs_row: bool, abs_col: bool) -> CellReference {
    CellReference {
        addr: CellAddress::new(row, col),
        abs_col,
        abs_row,
        invalid: false,
        sheet_name: None,
    }
}

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
    assert_eq!(parse_formula("=A1"), Some(cell(0, 0)));
}

#[test]
fn parse_absolute_cell_ref() {
    assert_eq!(
        parse_formula("=$A$1"),
        Some(Expr::CellRef(absolute(0, 0, true, true)))
    );
    assert_eq!(
        parse_formula("=$B3"),
        Some(Expr::CellRef(absolute(2, 1, false, true)))
    );
}

#[test]
fn parse_cross_sheet_reference_and_range() {
    assert_eq!(
        parse_formula("=Sheet2!A1"),
        Some(Expr::CellRef(CellReference {
            addr: CellAddress::new(0, 0),
            abs_col: false,
            abs_row: false,
            invalid: false,
            sheet_name: Some("Sheet2".into()),
        }))
    );

    let parsed = parse_formula("=SUM(Sheet2!A1:B2)").unwrap();
    assert_eq!(serialize_formula(&parsed), "=SUM(Sheet2!A1:B2)");
}

#[test]
fn parse_addition() {
    assert_eq!(
        parse_formula("=A1+B1"),
        Some(Expr::BinOp {
            op: BinOperator::Add,
            left: Box::new(cell(0, 0)),
            right: Box::new(cell(0, 1)),
        })
    );
}

#[test]
fn parse_multiplication_before_addition() {
    let result = parse_formula("=A1+B1*2").unwrap();
    assert_eq!(
        result,
        Expr::BinOp {
            op: BinOperator::Add,
            left: Box::new(cell(0, 0)),
            right: Box::new(Expr::BinOp {
                op: BinOperator::Mul,
                left: Box::new(cell(0, 1)),
                right: Box::new(Expr::Number(2.0)),
            }),
        }
    );
}

#[test]
fn parse_parentheses() {
    let result = parse_formula("=(A1+B1)*2").unwrap();
    assert_eq!(
        result,
        Expr::BinOp {
            op: BinOperator::Mul,
            left: Box::new(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(cell(0, 0)),
                right: Box::new(cell(0, 1)),
            }),
            right: Box::new(Expr::Number(2.0)),
        }
    );
}

#[test]
fn parse_negation() {
    assert_eq!(
        parse_formula("=-A1"),
        Some(Expr::Negate(Box::new(cell(0, 0))))
    );
}

#[test]
fn parse_division() {
    assert_eq!(
        parse_formula("=A1/B1"),
        Some(Expr::BinOp {
            op: BinOperator::Div,
            left: Box::new(cell(0, 0)),
            right: Box::new(cell(0, 1)),
        })
    );
}

#[test]
fn parse_spaces() {
    assert_eq!(
        parse_formula("= A1 + B1 "),
        Some(Expr::BinOp {
            op: BinOperator::Add,
            left: Box::new(cell(0, 0)),
            right: Box::new(cell(0, 1)),
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
            args: vec![cell(0, 0), cell(0, 1)],
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
            args: vec![cell(0, 0)],
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
                start: CellReference::from_addr(CellAddress::new(0, 0)),
                end: CellReference::from_addr(CellAddress::new(2, 1)),
            }],
        }
    );
}

#[test]
fn parse_absolute_range() {
    let result = parse_formula("=SUM($A1:B$3)").unwrap();
    assert_eq!(
        result,
        Expr::FuncCall {
            name: "SUM".into(),
            args: vec![Expr::Range {
                start: absolute(0, 0, false, true),
                end: absolute(2, 1, true, false),
            }],
        }
    );
}

#[test]
fn parse_complex_formula() {
    let result = parse_formula("=(A1+B1)/2").unwrap();
    assert_eq!(
        result,
        Expr::BinOp {
            op: BinOperator::Div,
            left: Box::new(Expr::BinOp {
                op: BinOperator::Add,
                left: Box::new(cell(0, 0)),
                right: Box::new(cell(0, 1)),
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
fn parse_boolean_literal() {
    assert_eq!(parse_formula("=TRUE"), Some(Expr::Boolean(true)));
    assert_eq!(parse_formula("=FALSE"), Some(Expr::Boolean(false)));
}

#[test]
fn parse_error_literal() {
    assert_eq!(
        parse_formula("=#REF!"),
        Some(Expr::Error(ValueError::InvalidRef))
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
                cell(0, 0),
                Expr::FuncCall {
                    name: "SUM".into(),
                    args: vec![cell(0, 1), cell(0, 2)],
                },
            ],
        }
    );
}

#[test]
fn parse_comparison_operator() {
    assert_eq!(
        parse_formula("=A1>=10"),
        Some(Expr::BinOp {
            op: BinOperator::GreaterOrEqual,
            left: Box::new(cell(0, 0)),
            right: Box::new(Expr::Number(10.0)),
        })
    );
}

#[test]
fn parse_concat_operator() {
    assert_eq!(
        parse_formula("=A1&\"!\""),
        Some(Expr::BinOp {
            op: BinOperator::Concat,
            left: Box::new(cell(0, 0)),
            right: Box::new(Expr::Text("!".into())),
        })
    );
}

#[test]
fn parse_power_operator_is_right_associative() {
    assert_eq!(
        parse_formula("=2^3^2"),
        Some(Expr::BinOp {
            op: BinOperator::Power,
            left: Box::new(Expr::Number(2.0)),
            right: Box::new(Expr::BinOp {
                op: BinOperator::Power,
                left: Box::new(Expr::Number(3.0)),
                right: Box::new(Expr::Number(2.0)),
            }),
        })
    );
}

#[test]
fn shift_formula_moves_relative_refs() {
    assert_eq!(
        shift_formula_input("=A1+B2", 1, 2),
        Some("=C2+D3".into())
    );
}

#[test]
fn shift_formula_preserves_absolute_axes() {
    assert_eq!(
        shift_formula_input("=$A1+B$2+$C$3", 2, 4),
        Some("=$A3+F$2+$C$3".into())
    );
}

#[test]
fn serialize_formula_renders_nested_boolean_and_range_exprs() {
    let expr = Expr::FuncCall {
        name: "IF".into(),
        args: vec![
            Expr::BinOp {
                op: BinOperator::GreaterOrEqual,
                left: Box::new(Expr::FuncCall {
                    name: "SUM".into(),
                    args: vec![Expr::Range {
                        start: CellReference::from_addr(CellAddress::new(0, 0)),
                        end: CellReference::from_addr(CellAddress::new(1, 1)),
                    }],
                }),
                right: Box::new(Expr::Number(10.0)),
            },
            Expr::Boolean(true),
            Expr::Text("low".into()),
        ],
    };

    assert_eq!(serialize_formula(&expr), "=IF(SUM(A1:B2)>=10,TRUE,\"low\")");
}

#[test]
fn serialize_formula_preserves_absolute_and_mixed_refs() {
    let expr = parse_formula("=SUM($A1,B$2,$C$3)").unwrap();
    assert_eq!(serialize_formula(&expr), "=SUM($A1,B$2,$C$3)");
}

#[test]
fn shift_formula_moves_ranges_and_nested_relative_refs() {
    assert_eq!(
        shift_formula_input("=SUM(A1:B2)+IF(C3>0,D4,0)", 1, 2),
        Some("=SUM(C2:D3)+IF(E4>0,F5,0)".into())
    );
}

#[test]
fn shift_formula_returns_none_for_invalid_formula_input() {
    assert_eq!(shift_formula_input("=SUM(", 1, 1), None);
}

#[test]
fn shift_formula_out_of_bounds_produces_ref_error() {
    assert_eq!(shift_formula_input("=A1", -1, 0), Some("=#REF!".into()));
}
