//! Round-trip integration tests for the `HYPERLINK` and `IMAGE` formula
//! built-ins, exercised through a real `Workbook` (parse + eval + cache).
//!
//! The formula-level behaviour mirrors Excel; the actual clickable link
//! and inline image rendering are HOST INTEGRATION concerns. These tests
//! only assert what the Rust core surfaces:
//!
//!   - HYPERLINK: returns the friendly label (or the URL when omitted).
//!   - IMAGE: returns a structured `<IMAGE: ...>` text payload the JS
//!     side detects by prefix to swap in an `<img>` element.
//!
//! WEBSERVICE / FILTERXML are out of scope (HTTP + XML); see the
//! `// future:` comment in `eval.rs` near the HYPERLINK arm.

use einfach_core::Value;
use einfach_excel_core::Workbook;

#[test]
fn hyperlink_round_trip_friendly_name_and_cell_ref() {
    let mut wb = Workbook::new();
    // A1 holds a URL; B1 uses it via HYPERLINK with a friendly label;
    // B2 uses HYPERLINK with only the URL (label defaults to URL text).
    wb.set_cell(0, "A1", Value::Text("https://example.com".into()));
    wb.set_formula(0, "B1", "=HYPERLINK(A1, \"click me\")");
    wb.set_formula(0, "B2", "=HYPERLINK(A1)");
    assert_eq!(wb.get_cell("Sheet1", "B1"), Value::Text("click me".into()));
    assert_eq!(
        wb.get_cell("Sheet1", "B2"),
        Value::Text("https://example.com".into())
    );
}

#[test]
fn hyperlink_round_trip_error_propagation() {
    let mut wb = Workbook::new();
    // Division by zero inside HYPERLINK arguments propagates.
    wb.set_formula(0, "B1", "=HYPERLINK(1/0)");
    wb.set_formula(0, "B2", "=HYPERLINK(\"u\", 1/0)");
    assert!(matches!(wb.get_cell("Sheet1", "B1"), Value::Error(_)));
    assert!(matches!(wb.get_cell("Sheet1", "B2"), Value::Error(_)));
}

#[test]
fn image_round_trip_structured_payload() {
    let mut wb = Workbook::new();
    // Basic case + alt text + custom dimensions cover the three notable
    // surfaces of the `<IMAGE: ...>` payload format.
    wb.set_formula(0, "A1", "=IMAGE(\"https://example.com/cat.jpg\")");
    wb.set_formula(
        0,
        "A2",
        "=IMAGE(\"https://example.com/cat.jpg\", \"a cat\")",
    );
    wb.set_formula(0, "A3", "=IMAGE(\"u\", \"a\", 3, 120, 240)");
    // Invalid sizing surfaces #VALUE! — confirms the guard runs through
    // the real eval pipeline (not just the unit test harness).
    wb.set_formula(0, "A4", "=IMAGE(\"u\", \"a\", 7)");
    assert_eq!(
        wb.get_cell("Sheet1", "A1"),
        Value::Text("<IMAGE: https://example.com/cat.jpg>".into())
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A2"),
        Value::Text("<IMAGE: https://example.com/cat.jpg alt=\"a cat\">".into())
    );
    assert_eq!(
        wb.get_cell("Sheet1", "A3"),
        Value::Text("<IMAGE: u alt=\"a\" sizing=3 height=120 width=240>".into())
    );
    assert!(matches!(wb.get_cell("Sheet1", "A4"), Value::Error(_)));
}
