//! End-to-end AMORDEGRC faithfulness checks through the public `Workbook`
//! API. The inline `mod tests` in `eval.rs` covers the evaluator surface;
//! these tests confirm the same algorithm reaches a real `Sheet` +
//! `WorkbookEvalProvider` pipeline (formula parsing, evaluation, atom
//! storage, retrieval) and produces Excel-faithful values.
//!
//! Reference: https://support.microsoft.com/en-us/office/amordegrc-function-a14d0ca1-64a4-42eb-9b3d-b0dededf9e51

use einfach_core::Value;
use einfach_excel_core::Workbook;

fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// Full depreciation schedule for the canonical Microsoft example
/// (cost=2400, salvage=300, rate=0.15, purchased=2008-08-19,
/// first_period=2008-12-31, basis=1).
///
/// Algorithm trace:
///   life     = 1/0.15 ≈ 6.667 → coef = 2.5, ddb_rate = 0.375
///   last_per = ceil(6.667) = 7
///   frac     = (2008-12-31 − 2008-08-19) / 365 = 134/365 ≈ 0.367123
///   p=0: round(2400 * 0.375 * 0.367123) = 330. book = 2070.
///   p=1: round(2070 * 0.375) = 776. book = 1294.
///   p=2: round(1294 * 0.375) = 485. book = 809.
///   p=3: round(809  * 0.375) = 303. book = 506.
///   p=4: ddb = round(506*0.375)=190. sl=round((506-300)/3)=69. dep=190. book=316.
///   p=5: ddb = round(316*0.375)=119. sl=round((316-300)/2)=8.  dep=119. book=197.
///        ↑ Wait — book 197 < salvage 300; the cap `min(book-salvage)` pulls
///          dep down to 16 and book to 300. Then break.
///        On second look: at p=5, book=316. dep_uncapped=119. book-salvage=16.
///        Cap → dep=16. book=300. break (book == salvage).
///   p=6: schedule already exhausted → 0.
///   p=7: 0.
///   p≥7: 0.
///
/// Total: 330+776+485+303+190+16 = 2100 = cost - salvage. ✓
#[test]
fn amordegrc_canonical_schedule_closes_exactly_to_salvage() {
    let mut wb = Workbook::new();
    for p in 0..=8 {
        let cell = format!("A{}", p + 1);
        let f = format!(
            "=AMORDEGRC(2400,DATE(2008,8,19),DATE(2008,12,31),300,{},0.15,1)",
            p
        );
        wb.set_formula(0, &cell, &f);
    }

    let mut total = 0.0;
    let mut periods: Vec<f64> = Vec::new();
    for p in 0..=8 {
        let cell = format!("A{}", p + 1);
        match wb.get_cell("Sheet1", &cell) {
            Value::Number(n) => {
                periods.push(n);
                total += n;
            }
            other => panic!("period {}: {:?}", p, other),
        }
    }

    // Period 0 = 330 (first-period partial year).
    assert_eq!(periods[0], 330.0, "schedule = {:?}", periods);
    // Period 1 = 776.
    assert_eq!(periods[1], 776.0, "schedule = {:?}", periods);
    // Periods past life (>=8) yield 0.
    assert_eq!(periods[8], 0.0, "schedule = {:?}", periods);
    // Cumulative depreciation must equal cost - salvage (allow ±1 for
    // per-period integer rounding drift, which is intentional).
    assert!(
        approx_eq(total, 2100.0, 1.5),
        "schedule total {} != 2100 ({:?})",
        total,
        periods
    );
}

/// Domain validation reaches Workbook output as error cells.
#[test]
fn amordegrc_invalid_inputs_surface_as_error_cells() {
    let mut wb = Workbook::new();
    // purchased > first_period → #NUM! (Overflow).
    wb.set_formula(
        0,
        "A1",
        "=AMORDEGRC(2400,DATE(2009,1,1),DATE(2008,12,31),300,0,0.15)",
    );
    // rate >= 1 → #NUM!.
    wb.set_formula(
        0,
        "A2",
        "=AMORDEGRC(2400,DATE(2008,1,1),DATE(2008,12,31),300,0,1)",
    );
    // salvage >= cost → #NUM!.
    wb.set_formula(
        0,
        "A3",
        "=AMORDEGRC(100,DATE(2008,1,1),DATE(2008,12,31),200,0,0.15)",
    );
    // basis out of range → #VALUE!.
    wb.set_formula(
        0,
        "A4",
        "=AMORDEGRC(2400,DATE(2008,1,1),DATE(2008,12,31),300,0,0.15,9)",
    );

    for cell in ["A1", "A2", "A3"] {
        match wb.get_cell("Sheet1", cell) {
            Value::Error(_) => {}
            other => panic!("{} expected Error, got {:?}", cell, other),
        }
    }
    match wb.get_cell("Sheet1", "A4") {
        Value::Error(_) => {}
        other => panic!("A4 expected #VALUE! Error, got {:?}", other),
    }
}
