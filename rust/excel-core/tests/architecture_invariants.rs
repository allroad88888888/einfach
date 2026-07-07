//! Executable tripwires for the atom-delegation rewrite.
//!
//! See `rust/docs/ATOM_DELEGATION_REWRITE_PLAN.md`. These tests read source
//! files and assert on the ABSENCE of parallel-dependency-graph machinery
//! (phase-gated) and the STABILITY of the WASM public API. A future agent
//! that reintroduces an address→formula index — even one that passes every
//! behavioral test — fails here. That is the point (WORKPLAN §6: doing so
//! without an INV amendment is a P0 defect).
//!
//! Phase progression is a one-line edit of `PHASE` below, landed in the same
//! commit as the phase's exit gate — loud and reviewable by design.

use std::fs;
use std::path::{Path, PathBuf};

/// Current rewrite phase. Advance ONLY at a phase exit gate (WORKPLAN §3).
const PHASE: u8 = 1;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn sheet_rs() -> String {
    read(&manifest_dir().join("src/sheet.rs"))
}

fn workbook_rs() -> String {
    read(&manifest_dir().join("src/workbook.rs"))
}

fn store_rs() -> String {
    read(&manifest_dir().join("../core/src/store.rs"))
}

fn wasm_lib_rs() -> String {
    read(&manifest_dir().join("../wasm/src/lib.rs"))
}

/// Identifiers that must be GONE once the given phase is reached.
/// (identifier, first-phase-where-forbidden, files-to-check)
const FORBIDDEN: &[(&str, u8, &[&str])] = &[
    // P4 exit: point-dependency half of the parallel graph deleted
    ("cell_dependents", 4, &["sheet", "workbook"]),
    ("mark_dependents_dirty", 4, &["sheet", "workbook"]),
    // P5 exit: range index deleted
    ("RangeDependentIndex", 5, &["sheet", "workbook"]),
    ("range_dependents", 5, &["sheet", "workbook"]),
    ("coalesced_dirty_into", 5, &["sheet"]),
    // P6 exit: everything else
    ("CrossSheetDeps", 6, &["sheet", "workbook"]),
    ("has_cross_sheet_refs", 6, &["sheet", "workbook"]),
    ("prewarm_formula_chain", 6, &["sheet"]),
    ("collect_prewarm_refs", 6, &["sheet"]),
    ("would_create_cycle", 6, &["sheet", "workbook"]),
    ("FormulaCache", 6, &["sheet", "workbook"]),
    ("dirty_visit_count", 6, &["sheet", "workbook"]),
    // P6 exit: the old eager-push store machinery
    ("topological_sort", 6, &["store"]),
    ("collect_affected", 6, &["store"]),
    ("propagate_and_notify", 6, &["store"]),
    ("propagate_force", 6, &["store"]),
    ("force_recompute_derived", 6, &["store"]),
];

/// Type shapes that constitute a parallel dependency graph, whatever they
/// are named. Checked whitespace-insensitively from P4 on. INV-2 allowlist
/// lives in dedicated modules (range family geometry, spill claims) — those
/// map addresses to range keys / anchors, never to dependent formula cells,
/// and they must not use these shapes.
const FORBIDDEN_SHAPES: &[(&str, u8)] = &[
    ("HashMap<CellAddress,HashSet<CellAddress", 4),
    ("HashMap<(usize,CellAddress),HashSet", 6),
];

/// Functions that must EXIST in the faithful store from P1 on (positive
/// isomorphism smoke — INV-1).
const REQUIRED_STORE_FNS: &[(&str, u8)] = &[
    ("fn read_atom", 1),
    ("fn dependencies_change", 1),
    ("fn flush_pending", 1),
    ("fn publish_atom", 1),
    ("fn subscribe_atom", 1),
];

fn file_by_key(key: &str) -> String {
    match key {
        "sheet" => sheet_rs(),
        "workbook" => workbook_rs(),
        "store" => store_rs(),
        other => panic!("unknown file key {other}"),
    }
}

#[test]
fn forbidden_identifiers_absent_for_current_phase() {
    let mut violations = Vec::new();
    for (ident, from_phase, files) in FORBIDDEN {
        if PHASE < *from_phase {
            continue;
        }
        for key in *files {
            let src = file_by_key(key);
            if src.contains(ident) {
                violations.push(format!("{key}.rs still contains `{ident}` (forbidden since P{from_phase})"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "parallel-graph machinery survived its deletion phase:\n  {}\nSee WORKPLAN §2/§6.",
        violations.join("\n  ")
    );
}

#[test]
fn forbidden_type_shapes_absent_for_current_phase() {
    let strip = |s: &str| s.replace([' ', '\n', '\t'], "");
    let sources = [("sheet", strip(&sheet_rs())), ("workbook", strip(&workbook_rs()))];
    let mut violations = Vec::new();
    for (shape, from_phase) in FORBIDDEN_SHAPES {
        if PHASE < *from_phase {
            continue;
        }
        for (name, src) in &sources {
            if src.contains(shape) {
                violations.push(format!("{name}.rs contains forbidden dep-graph shape `{shape}`"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "address→formula dependency shape reintroduced (INV-2):\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn required_store_functions_present_for_current_phase() {
    let src = store_rs();
    let missing: Vec<&str> = REQUIRED_STORE_FNS
        .iter()
        .filter(|(_, from)| PHASE >= *from)
        .filter(|(f, _)| !src.contains(f))
        .map(|(f, _)| *f)
        .collect();
    assert!(
        missing.is_empty(),
        "store.rs is missing store.ts-isomorphic functions (INV-1): {missing:?}"
    );
}

/// INV-8: transitional code is tagged `BRIDGE(delete-by: P<n>-exit)` and none
/// of it survives P6. At every phase, ALL occurrences of the word BRIDGE in
/// the reactive-core files must be well-formed markers whose phase has not
/// already passed (codex P0 review P3: malformed/untagged shims must not
/// evade the policy).
#[test]
fn bridge_markers_within_policy() {
    let mut total = 0;
    let mut violations = Vec::new();
    for key in ["sheet", "workbook", "store"] {
        let src = file_by_key(key);
        for (line_no, line) in src.lines().enumerate() {
            let mut rest = line;
            while let Some(pos) = rest.find("BRIDGE") {
                rest = &rest[pos + "BRIDGE".len()..];
                total += 1;
                let phase = rest
                    .strip_prefix("(delete-by: P")
                    .and_then(|t| t.chars().next())
                    .and_then(|c| c.to_digit(10))
                    .filter(|_| rest.contains("-exit)"));
                match phase {
                    None => violations.push(format!(
                        "{key}.rs:{}: BRIDGE without well-formed `(delete-by: P<n>-exit)` tag",
                        line_no + 1
                    )),
                    Some(p) if (PHASE as u32) >= p => violations.push(format!(
                        "{key}.rs:{}: BRIDGE(delete-by: P{p}-exit) survived past its phase (now P{PHASE})",
                        line_no + 1
                    )),
                    Some(_) => {}
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "INV-8 violations:\n  {}",
        violations.join("\n  ")
    );
    if PHASE >= 6 {
        assert_eq!(total, 0, "INV-8: {total} BRIDGE marker(s) survived P6 exit");
    }
}

/// INV-4: the WASM public surface is frozen. Snapshot committed at P0;
/// additive-only changes require regenerating the snapshot IN THE SAME
/// commit with the addition visible in the diff.
#[test]
fn wasm_public_api_signatures_unchanged() {
    let snapshot_path = manifest_dir().join("tests/fixtures/wasm_api_signatures.txt");
    let expected = read(&snapshot_path);
    let actual = extract_wasm_signatures(&wasm_lib_rs());
    let expected_set: Vec<&str> = expected.lines().filter(|l| !l.is_empty()).collect();
    let actual_set: Vec<String> = actual;

    // Removals / modifications are hard failures; additions demand a
    // regenerated snapshot so the diff is explicit.
    let mut missing = Vec::new();
    for sig in &expected_set {
        if !actual_set.iter().any(|a| a == sig) {
            missing.push(*sig);
        }
    }
    assert!(
        missing.is_empty(),
        "INV-4: WASM public API signatures removed/changed:\n  {}",
        missing.join("\n  ")
    );
    let mut added = Vec::new();
    for sig in &actual_set {
        if !expected_set.iter().any(|e| e == sig) {
            added.push(sig.clone());
        }
    }
    assert!(
        added.is_empty(),
        "WASM public API grew without regenerating the snapshot (allowed only \
         additively + in the same commit):\n  {}\nRegenerate: cargo test --test \
         architecture_invariants wasm_snapshot_generate -- --ignored",
        added.join("\n  ")
    );
}

/// Full-fidelity signature capture (codex P0 review P2): each entry is
/// `<impl owner> :: <wasm_bindgen attrs incl. js_name> :: <complete signature>`,
/// with multi-line signatures joined until the body brace and whitespace
/// normalized. Renaming a js_name, changing a parameter on a wrapped line,
/// or moving a method between impls all change the captured entry.
fn extract_wasm_signatures(src: &str) -> Vec<String> {
    let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut sigs = Vec::new();
    let mut owner = String::from("<free>");
    let mut pending_attrs: Vec<String> = Vec::new();
    let mut lines = src.lines().map(str::trim).peekable();
    while let Some(line) = lines.next() {
        if line.starts_with("impl ") {
            owner = normalize(line.trim_end_matches('{').trim());
            pending_attrs.clear();
        } else if line.starts_with("#[wasm_bindgen") {
            // attribute may itself wrap lines until its closing `]`
            let mut attr = line.to_string();
            while !attr.trim_end().ends_with(']') {
                match lines.next() {
                    Some(cont) => attr.push_str(cont),
                    None => break,
                }
            }
            pending_attrs.push(normalize(&attr));
        } else if line.starts_with("pub fn ") {
            let mut sig = line.to_string();
            while !sig.contains('{') && !sig.trim_end().ends_with(';') {
                match lines.next() {
                    Some(cont) => {
                        sig.push(' ');
                        sig.push_str(cont);
                    }
                    None => break,
                }
            }
            let sig = normalize(sig.split('{').next().unwrap_or(&sig).trim());
            sigs.push(format!("{owner} :: [{}] :: {sig}", pending_attrs.join(" ")));
            pending_attrs.clear();
        } else if !line.starts_with("#[") && !line.is_empty() && !line.starts_with("//") {
            // any other code line breaks attr→fn adjacency
            pending_attrs.clear();
        }
    }
    sigs.sort();
    sigs
}

/// One-time snapshot generator (P0), rerun only for approved additive changes.
#[test]
#[ignore]
fn wasm_snapshot_generate() {
    let dir = manifest_dir().join("tests/fixtures");
    fs::create_dir_all(&dir).expect("mkdir fixtures");
    let sigs = extract_wasm_signatures(&wasm_lib_rs());
    assert!(sigs.len() > 100, "suspiciously few WASM signatures: {}", sigs.len());
    fs::write(dir.join("wasm_api_signatures.txt"), sigs.join("\n") + "\n").expect("write snapshot");
}
