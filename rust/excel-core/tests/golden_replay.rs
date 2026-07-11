//! Golden replay fixtures — the drift oracle for the atom-delegation rewrite.
//!
//! P0 of `rust/docs/ATOM_DELEGATION_REWRITE_PLAN.md`: seeded op sequences ran
//! against the pre-rewrite engine once (`cargo test --test golden_replay
//! golden_generate -- --ignored`) and their observable end states were
//! committed under `tests/fixtures/`. The always-on replay tests re-run the
//! exact same op sequences against the current engine and diff the snapshot.
//!
//! The snapshot records VALUES ONLY (displays, formula texts, spill anchors)
//! — no counters, no timing. P7 approved a line-by-line fixture correction for
//! colliding `SEQUENCE` anchors and their downstream formulas: the public Sheet
//! facade returns `#SPILL!`, while the removed force-recompute bypass had
//! exposed raw arrays. The migration used the opt-in all-diff report and did
//! not regenerate fixtures. Every future replay mismatch remains an unapproved
//! behavior change. Do NOT regenerate fixtures to make a phase green; that
//! defeats the oracle (WORKPLAN §6).

use einfach_core::Value;
use einfach_excel_core::{CellAddress, CellRange, Workbook};

/// Same LCG as tests/scale_suite.rs — deterministic, seedable.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg(seed)
    }
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const SEEDS: [u64; 5] = [11, 23, 37, 41, 53];
const OPS_PER_SEED: usize = 2000;
const ROWS: u64 = 40;
const COLS: u64 = 12;
const SHEETS: [&str; 3] = ["Sheet1", "Beta", "Gamma"];

fn col_name(col: u64) -> String {
    // cols 0..12 stay single-letter; keep simple
    ((b'A' + col as u8) as char).to_string()
}

fn addr(rng: &mut Lcg) -> String {
    format!("{}{}", col_name(rng.below(COLS)), rng.below(ROWS) + 1)
}

/// A pool of formula templates covering point refs, aggregates, ranges,
/// cross-sheet refs, spills, conditionals and occasional cycle attempts.
/// `{A}`/`{B}` are replaced with random in-grid addresses.
const FORMULA_TEMPLATES: [&str; 14] = [
    "={A}+1",
    "={A}*2+{B}",
    "=SUM(A1:C10)",
    "=SUM(B:B)",
    "=COUNT(A1:D20)",
    "=AVERAGE(A1:A10)",
    "=IF({A}>10,{B},0)",
    "=Beta!{A}*2",
    "=Gamma!{A}+Sheet1!{B}",
    "=SEQUENCE(2,2)",
    "=SEQUENCE(3,1,{A})",
    "=MAX(A1:B5)+MIN(C1:C10)",
    "=LEN(CONCAT({A},\"x\"))",
    "={A}",
];

fn build_workbook(seed: u64, operation_count: usize) -> Workbook {
    let mut rng = Lcg::new(seed);
    let mut wb = Workbook::new(); // creates "Sheet1"
    wb.add_sheet("Beta");
    wb.add_sheet("Gamma");
    let trace = std::env::var_os("EINFACH_GOLDEN_TRACE").is_some();
    let trace_from = std::env::var("EINFACH_GOLDEN_TRACE_FROM")
        .ok()
        .map(|value| {
            value
                .parse::<usize>()
                .expect("EINFACH_GOLDEN_TRACE_FROM must be a usize")
        })
        .unwrap_or_default();

    for operation_index in 0..operation_count {
        let sheet_idx = rng.below(SHEETS.len() as u64) as usize;
        let operation_kind = rng.below(100);
        if trace && operation_index >= trace_from {
            eprintln!(
                "golden seed={seed} operation={operation_index} sheet={sheet_idx} kind={operation_kind}"
            );
        }
        match operation_kind {
            // 30% scalar writes
            0..=29 => {
                let a = addr(&mut rng);
                let v = match rng.below(3) {
                    0 => Value::Number(rng.below(1000) as f64 / 4.0),
                    1 => Value::Text(format!("t{}", rng.below(50))),
                    _ => Value::Boolean(rng.below(2) == 0),
                };
                wb.set_cell(sheet_idx, &a, v);
            }
            // 25% formula installs (cycle attempts included — deterministic
            // Ok(false) + #CYCLE! literal is part of the pinned behavior)
            30..=54 => {
                let a = addr(&mut rng);
                let template = FORMULA_TEMPLATES[rng.below(14) as usize];
                let f = template
                    .replace("{A}", &addr(&mut rng))
                    .replace("{B}", &addr(&mut rng));
                let _ = wb.set_formula(sheet_idx, &a, &f);
            }
            // 10% clears
            55..=64 => {
                let a = addr(&mut rng);
                wb.clear_cell(sheet_idx, &a);
            }
            // 5% range clears
            65..=69 => {
                let r0 = rng.below(ROWS) as u32;
                let c0 = rng.below(COLS) as u32;
                let r1 = (r0 + rng.below(5) as u32).min(ROWS as u32 - 1);
                let c1 = (c0 + rng.below(3) as u32).min(COLS as u32 - 1);
                let range = CellRange::new(CellAddress::new(r0, c0), CellAddress::new(r1, c1));
                wb.clear_range(sheet_idx, range);
            }
            // 10% structural edits
            70..=79 => {
                let at = rng.below(ROWS / 2) as u32;
                let count = rng.below(2) as u32 + 1;
                let structural_kind = rng.below(4);
                let sheet = wb.sheet_mut(sheet_idx).expect("sheet");
                match structural_kind {
                    0 => {
                        if trace && operation_index >= trace_from {
                            eprintln!("  insert_row at={at} count={count}");
                        }
                        sheet.insert_row(at, count);
                    }
                    1 => {
                        if trace && operation_index >= trace_from {
                            eprintln!("  delete_row at={at} count={count}");
                        }
                        sheet.delete_row(at, count);
                    }
                    2 => {
                        let col = rng.below(COLS / 2) as u32;
                        if trace && operation_index >= trace_from {
                            eprintln!("  insert_col at={col} count=1");
                        }
                        sheet.insert_col(col, 1);
                    }
                    _ => {
                        let col = rng.below(COLS / 2) as u32;
                        if trace && operation_index >= trace_from {
                            eprintln!("  delete_col at={col} count=1");
                        }
                        sheet.delete_col(col, 1);
                    }
                }
            }
            // 5% bulk loads (batch of 20)
            80..=84 => {
                let mut cells: Vec<(usize, String, Value)> = Vec::new();
                for _ in 0..20 {
                    let s = rng.below(SHEETS.len() as u64) as usize;
                    let a = addr(&mut rng);
                    let v = Value::Number(rng.below(500) as f64);
                    cells.push((s, a, v));
                }
                wb.bulk_load(|loader| {
                    for (s, a, v) in cells {
                        loader.set_cell(s, &a, v);
                    }
                });
            }
            // 15% read sampling (hydrates/evaluates — part of the sequence)
            _ => {
                let a = addr(&mut rng);
                let name = SHEETS[sheet_idx];
                let _ = wb.get_cell(name, &a);
            }
        }
    }
    wb
}

/// Canonical, engine-agnostic rendering of a Value. `{:?}` on f64 gives a
/// stable shortest-roundtrip repr on all supported toolchains.
fn render(v: &Value) -> String {
    match v {
        Value::Null => "∅".to_string(),
        Value::Number(n) => format!("N:{:?}", n),
        Value::Text(t) => format!("T:{}", t),
        Value::Boolean(b) => format!("B:{}", b),
        Value::Error(e) => format!("E:{}", e),
        Value::Array(arr) => {
            let (rows, cols) = arr.shape();
            let mut out = format!("A:{}x{}[", rows, cols);
            for r in 0..rows {
                for c in 0..cols {
                    if let Some(cell) = arr.get(r, c) {
                        out.push_str(&render(cell));
                    }
                    out.push(';');
                }
            }
            out.push(']');
            out
        }
        Value::Lambda(_) => "L:<lambda>".to_string(),
    }
}

fn snapshot(wb: &Workbook) -> String {
    let mut out = String::new();
    for (idx, name) in SHEETS.iter().enumerate() {
        out.push_str(&format!("== sheet {} ({}) ==\n", idx, name));
        let sheet = wb.sheet(idx).expect("sheet exists");
        let mut addrs = sheet.non_empty_addrs();
        addrs.sort();
        for a in addrs {
            let v = wb.get_cell(name, &a);
            let formula = sheet.get_formula(&a).unwrap_or_default();
            out.push_str(&format!("{} = {} | f: {}\n", a, render(&v), formula));
        }
    }
    out
}

fn fixture_path(seed: u64) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("golden_seed_{}.txt", seed))
}

/// One-time generator (P0). Run against the PRE-REWRITE engine only:
/// `cargo test --test golden_replay golden_generate -- --ignored`
#[test]
#[ignore]
fn golden_generate() {
    std::fs::create_dir_all(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"),
    )
    .expect("mkdir fixtures");
    for seed in SEEDS {
        let wb = build_workbook(seed, OPS_PER_SEED);
        let snap = snapshot(&wb);
        std::fs::write(fixture_path(seed), &snap).expect("write fixture");
        // A snapshot that is trivially empty would fence nothing.
        assert!(
            snap.lines().count() > 50,
            "seed {} produced a degenerate snapshot",
            seed
        );
    }
}

#[test]
fn golden_replay_all_seeds() {
    let report_all = std::env::var_os("EINFACH_GOLDEN_REPORT_ALL").is_some();
    let selected_seed = std::env::var("EINFACH_GOLDEN_SEED").ok().map(|value| {
        value
            .parse::<u64>()
            .expect("EINFACH_GOLDEN_SEED must be a u64")
    });
    let operation_count = std::env::var("EINFACH_GOLDEN_OPS")
        .ok()
        .map(|value| {
            value
                .parse::<usize>()
                .expect("EINFACH_GOLDEN_OPS must be a usize")
        })
        .unwrap_or(OPS_PER_SEED);
    assert!(
        operation_count <= OPS_PER_SEED,
        "EINFACH_GOLDEN_OPS cannot exceed {OPS_PER_SEED}"
    );
    let mut mismatches = Vec::new();
    for seed in SEEDS
        .into_iter()
        .filter(|seed| selected_seed.is_none_or(|selected| *seed == selected))
    {
        let expected = std::fs::read_to_string(fixture_path(seed)).unwrap_or_else(|_| {
            panic!(
                "missing fixture for seed {} — run the P0 generator first \
                 (cargo test --test golden_replay golden_generate -- --ignored)",
                seed
            )
        });
        let wb = build_workbook(seed, operation_count);
        let actual = snapshot(&wb);
        if operation_count != OPS_PER_SEED {
            eprintln!("golden diagnostic build completed seed={seed} operations={operation_count}");
            continue;
        }
        if expected != actual {
            // Default to the first diff so ordinary CI logs stay compact.
            // The opt-in report is useful when reviewing an explicitly
            // approved oracle migration without regenerating the fixtures.
            for (i, (e, a)) in expected.lines().zip(actual.lines()).enumerate() {
                if e != a {
                    let mismatch = format!(
                        "golden replay mismatch (seed {seed}) at line {}:\n  expected: {e}\n  actual:   {a}\n\
                         An unapproved observable-behavior change — see WORKPLAN §6.",
                        i + 1
                    );
                    if !report_all {
                        panic!("{mismatch}");
                    }
                    mismatches.push(mismatch);
                }
            }
            let expected_len = expected.lines().count();
            let actual_len = actual.lines().count();
            if expected_len != actual_len {
                let mismatch = format!(
                    "golden replay mismatch (seed {seed}): line count {expected_len} -> {actual_len}"
                );
                if !report_all {
                    panic!("{mismatch}");
                }
                mismatches.push(mismatch);
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} golden replay mismatch(es):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
