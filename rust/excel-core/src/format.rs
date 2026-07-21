use einfach_core::Value;

/// Per-cell display + style information. Phase 6.
///
/// Format is independent of the atom dependency graph — changing a cell's
/// format never triggers a recompute. The view layer reads `format(addr)`
/// alongside `get_cell(addr)` when rendering.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellFormat {
    pub number_format: NumberFormat,
    pub bold: bool,
    pub italic: bool,
    pub align: Align,
    pub font_size: Option<u32>,
    /// HTML color string (`#rrggbb` / `red` / etc.); `None` = default.
    pub color: Option<String>,
    pub background: Option<String>,
    /// Font family name (CSS-style). `None` = workbook default.
    pub font_family: Option<String>,
    pub underline: bool,
    pub strikethrough: bool,
    pub wrap_text: bool,
    /// Indent in Excel indent units (0..=15). Stored verbatim for round-trip.
    pub indent: u8,
    pub vertical_align: VerticalAlign,
    pub rotation: Rotation,
    pub borders: CellBorders,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VerticalAlign {
    #[default]
    Default,
    Top,
    Center,
    Bottom,
    Justify,
    Distributed,
}

/// Text rotation in degrees `[-90, 90]`, or the special `Vertical` mode for
/// character-stacked layout. Stored verbatim for JS round-trip.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rotation {
    #[default]
    None,
    Degrees(i16),
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BorderStyle {
    #[default]
    None,
    Thin,
    Medium,
    Thick,
    Dashed,
    Dotted,
    Double,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BorderSpec {
    pub style: BorderStyle,
    pub color: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CellBorders {
    pub top: Option<BorderSpec>,
    pub right: Option<BorderSpec>,
    pub bottom: Option<BorderSpec>,
    pub left: Option<BorderSpec>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum NumberFormat {
    #[default]
    General,
    /// Fixed decimal places.
    Decimal {
        digits: u8,
        thousands: bool,
    },
    Percent {
        digits: u8,
    },
    /// `¥1,234.56`
    Currency {
        symbol: String,
        digits: u8,
    },
    /// Custom strftime-like date format, e.g. "yyyy-mm-dd".
    Date(String),
    /// Excel-style custom numeric pattern. The formatter intentionally covers
    /// a small display subset while preserving the raw pattern for WASM/JS
    /// round-trip.
    Custom(String),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Default,
    Left,
    Center,
    Right,
}

impl CellFormat {
    /// Apply this format to a numeric value, returning the user-visible
    /// string. For non-numeric inputs the caller should fall back to the
    /// default display path.
    pub fn format_number(&self, n: f64) -> String {
        match &self.number_format {
            NumberFormat::General => default_number_string(n),
            NumberFormat::Decimal { digits, thousands } => format_fixed(n, *digits, *thousands, ""),
            NumberFormat::Percent { digits } => format_fixed(n * 100.0, *digits, false, "%"),
            NumberFormat::Currency { symbol, digits } => {
                let body = format_fixed(n, *digits, true, "");
                format!("{}{}", symbol, body)
            }
            NumberFormat::Date(_) => default_number_string(n),
            NumberFormat::Custom(pattern) => {
                format_custom_number(pattern, n).unwrap_or_else(|| default_number_string(n))
            }
        }
    }
}

fn default_number_string(n: f64) -> String {
    if n == n.floor() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Collapse a spill anchor's `Value::Array` to its top-left scalar. Twin of
/// `sheet::collapse_array_for_eval` on the display side: the boundary never
/// shows the `Array` variant, it shows what Excel shows when you look at an
/// array-formula anchor.
fn collapse_array_for_display(val: &Value) -> std::borrow::Cow<'_, Value> {
    match val {
        Value::Array(arr) => std::borrow::Cow::Owned(arr.get(0, 0).cloned().unwrap_or(Value::Null)),
        _ => std::borrow::Cow::Borrowed(val),
    }
}

/// The UNFORMATTED display string of a value — no `NumberFormat` applied.
///
/// THE single definition of "what this cell looks like as text" at the
/// engine boundary. `rust/wasm`'s private `value_to_display` delegates to
/// it, which is what makes it the exact string the `readSparseRange` /
/// `getCellDisplay` wire carries, and therefore the exact string the host's
/// TypeScript filter predicate (`solid/excel/src-vnext/adapter/
/// filter-predicate.ts`) compares against today.
///
/// That identity is the whole reason the E3 filter sink-down is
/// behaviour-preserving on the worker path: `Workbook::apply_filter` feeds
/// its predicate from here, so the Rust predicate reads byte-identical
/// input to what the TypeScript predicate reads over the wire. A second,
/// separately-maintained formatter in the engine would have re-opened
/// exactly the drift the port exists to close.
///
/// Number formats are deliberately NOT applied: neither side applies them
/// on this path either (`applyNumberFormatsToCells` runs on the projection
/// read, not on the predicate scan).
pub fn value_to_display(val: &Value) -> String {
    let val = collapse_array_for_display(val);
    match &*val {
        Value::Number(n) => default_number_string(*n),
        Value::Text(s) => s.clone(),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::Null => String::new(),
        Value::Error(e) => format!("{}", e),
        // Unreachable: collapsed above. Defensive fallback.
        Value::Array(_) => String::new(),
        // Lambdas are transient evaluator state — they never get persisted
        // into a cell. A defensive empty string keeps the boundary safe if
        // one ever leaks through.
        Value::Lambda(_) => String::new(),
    }
}

fn format_fixed(n: f64, digits: u8, thousands: bool, suffix: &str) -> String {
    let formatted = format!("{:.*}", digits as usize, n);
    let body = if thousands {
        // Insert thousands separators in the integer part.
        let (int_part, frac_part) = match formatted.split_once('.') {
            Some((i, f)) => (i, Some(f)),
            None => (formatted.as_str(), None),
        };
        let (sign, digits_str) = match int_part.strip_prefix('-') {
            Some(rest) => ("-", rest),
            None => ("", int_part),
        };
        let with_commas = insert_commas(digits_str);
        match frac_part {
            Some(f) => format!("{sign}{with_commas}.{f}"),
            None => format!("{sign}{with_commas}"),
        }
    } else {
        formatted
    };
    format!("{}{}", body, suffix)
}

#[derive(Debug, PartialEq, Eq)]
enum CustomFormatToken {
    Pattern(char),
    Literal(String),
}

fn format_custom_number(pattern: &str, n: f64) -> Option<String> {
    if !n.is_finite() {
        return None;
    }

    let sections = split_custom_sections(pattern);
    if sections.is_empty() {
        return None;
    }

    let (section, value) = if n < 0.0 && sections.len() > 1 {
        (sections[1].as_str(), -n)
    } else if n == 0.0 && sections.len() > 2 {
        (sections[2].as_str(), n)
    } else {
        (sections[0].as_str(), n)
    };

    format_custom_number_section(&strip_custom_bracket_tags(section), value)
}

fn split_custom_sections(pattern: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut buffer = String::new();
    let mut in_string = false;
    let mut in_bracket = false;

    for ch in pattern.chars() {
        if ch == '"' {
            in_string = !in_string;
            buffer.push(ch);
            continue;
        }
        if !in_string && ch == '[' {
            in_bracket = true;
            buffer.push(ch);
            continue;
        }
        if !in_string && ch == ']' {
            in_bracket = false;
            buffer.push(ch);
            continue;
        }
        if ch == ';' && !in_string && !in_bracket {
            sections.push(buffer);
            buffer = String::new();
            continue;
        }
        buffer.push(ch);
    }

    sections.push(buffer);
    sections
}

fn strip_custom_bracket_tags(section: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < section.len() {
        let ch = section[i..].chars().next().unwrap();
        if ch == '[' {
            if let Some(relative_end) = section[i + ch.len_utf8()..].find(']') {
                let end = i + ch.len_utf8() + relative_end;
                let tag = &section[i + ch.len_utf8()..end];
                if is_ignored_custom_bracket_tag(tag) {
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_ignored_custom_bracket_tag(tag: &str) -> bool {
    let trimmed = tag.trim();
    let lower = trimmed.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "black" | "white" | "red" | "green" | "blue" | "yellow" | "magenta" | "cyan"
    ) || lower.starts_with("color")
        || trimmed.starts_with('$')
        || matches!(trimmed.as_bytes().first(), Some(b'<' | b'>' | b'='))
}

fn format_custom_number_section(section: &str, n: f64) -> Option<String> {
    let tokens = tokenize_custom_number_section(section)?;
    let Some(first_pattern) = tokens
        .iter()
        .position(|token| matches!(token, CustomFormatToken::Pattern(_)))
    else {
        return Some(render_custom_literals(&tokens));
    };
    let last_pattern = tokens
        .iter()
        .rposition(|token| matches!(token, CustomFormatToken::Pattern(_)))
        .unwrap();

    if tokens[first_pattern..=last_pattern]
        .iter()
        .any(|token| !matches!(token, CustomFormatToken::Pattern(_)))
    {
        return None;
    }

    let prefix = render_custom_literals(&tokens[..first_pattern]);
    let suffix = render_custom_literals(&tokens[last_pattern + 1..]);
    let numeric_pattern: String = tokens[first_pattern..=last_pattern]
        .iter()
        .filter_map(|token| match token {
            CustomFormatToken::Pattern(ch) => Some(*ch),
            CustomFormatToken::Literal(_) => None,
        })
        .collect();
    let body = format_custom_number_pattern(n, &numeric_pattern)?;
    Some(format!("{prefix}{body}{suffix}"))
}

fn tokenize_custom_number_section(section: &str) -> Option<Vec<CustomFormatToken>> {
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < section.len() {
        let ch = section[i..].chars().next().unwrap();
        if ch == '"' {
            i += ch.len_utf8();
            let mut literal = String::new();
            let mut closed = false;
            while i < section.len() {
                let next = section[i..].chars().next().unwrap();
                if next == '"' {
                    let next_i = i + next.len_utf8();
                    if section[next_i..].starts_with('"') {
                        literal.push('"');
                        i = next_i + 1;
                        continue;
                    }
                    i = next_i;
                    closed = true;
                    break;
                }
                literal.push(next);
                i += next.len_utf8();
            }
            if !closed {
                return None;
            }
            tokens.push(CustomFormatToken::Literal(literal));
            continue;
        }
        if ch == '\\' {
            let next_i = i + ch.len_utf8();
            if next_i < section.len() {
                let next = section[next_i..].chars().next().unwrap();
                tokens.push(CustomFormatToken::Literal(next.to_string()));
                i = next_i + next.len_utf8();
            } else {
                tokens.push(CustomFormatToken::Literal("\\".into()));
                i = next_i;
            }
            continue;
        }
        if ch == '_' {
            let next_i = i + ch.len_utf8();
            if next_i < section.len() {
                let next = section[next_i..].chars().next().unwrap();
                i = next_i + next.len_utf8();
            } else {
                i = next_i;
            }
            tokens.push(CustomFormatToken::Literal(" ".into()));
            continue;
        }
        if ch == '*' {
            let next_i = i + ch.len_utf8();
            if next_i < section.len() {
                let next = section[next_i..].chars().next().unwrap();
                i = next_i + next.len_utf8();
            } else {
                i = next_i;
            }
            continue;
        }
        if matches!(ch, '0' | '#' | ',' | '.' | '%') {
            tokens.push(CustomFormatToken::Pattern(ch));
        } else {
            tokens.push(CustomFormatToken::Literal(ch.to_string()));
        }
        i += ch.len_utf8();
    }
    Some(tokens)
}

fn render_custom_literals(tokens: &[CustomFormatToken]) -> String {
    tokens
        .iter()
        .filter_map(|token| match token {
            CustomFormatToken::Literal(s) => Some(s.as_str()),
            CustomFormatToken::Pattern(_) => None,
        })
        .collect()
}

fn format_custom_number_pattern(n: f64, pattern: &str) -> Option<String> {
    let percent_count = pattern.chars().filter(|ch| *ch == '%').count();
    let numeric_pattern: String = pattern.chars().filter(|ch| *ch != '%').collect();
    if numeric_pattern.chars().filter(|ch| *ch == '.').count() > 1 {
        return None;
    }

    let (mut int_pattern, frac_pattern) = match numeric_pattern.split_once('.') {
        Some((int_part, frac_part)) => (int_part.to_string(), frac_part),
        None => (numeric_pattern, ""),
    };

    let mut scale_commas = 0;
    while int_pattern.ends_with(',') {
        scale_commas += 1;
        int_pattern.pop();
    }

    if int_pattern.is_empty()
        || !int_pattern.chars().all(|ch| matches!(ch, '0' | '#' | ','))
        || !frac_pattern.chars().all(|ch| matches!(ch, '0' | '#'))
    {
        return None;
    }

    let int_digits: String = int_pattern.chars().filter(|ch| *ch != ',').collect();
    if !int_digits.chars().any(|ch| matches!(ch, '0' | '#')) {
        return None;
    }

    let min_int_digits = int_digits.chars().filter(|ch| *ch == '0').count().max(1);
    let max_frac_digits = frac_pattern.chars().count().min(15);
    let required_frac_digits = frac_pattern
        .chars()
        .filter(|ch| *ch == '0')
        .count()
        .min(max_frac_digits);
    let scaled = (n * 100f64.powi(percent_count as i32)) / 1000f64.powi(scale_commas);
    let negative = scaled < 0.0;
    let rounded = format!("{:.*}", max_frac_digits, scaled.abs());
    let (mut whole, mut frac) = match rounded.split_once('.') {
        Some((whole, frac)) => (whole.to_string(), frac.to_string()),
        None => (rounded, String::new()),
    };

    if whole.len() < min_int_digits {
        whole = format!("{}{}", "0".repeat(min_int_digits - whole.len()), whole);
    }
    if int_pattern.contains(',') {
        whole = insert_commas(&whole);
    }
    while frac.len() > required_frac_digits && frac.ends_with('0') {
        frac.pop();
    }

    let sign = if negative { "-" } else { "" };
    let percent_suffix = "%".repeat(percent_count);
    if frac.is_empty() {
        Some(format!("{sign}{whole}{percent_suffix}"))
    } else {
        Some(format!("{sign}{whole}.{frac}{percent_suffix}"))
    }
}

/// Conditional formatting rule. Multiple rules apply in order — the first
/// match wins. If no rule matches, the cell uses its base CellFormat.
#[derive(Clone, Debug, PartialEq)]
pub struct ConditionalRule {
    pub condition: Condition,
    /// Style overrides applied when `condition` is true. Only the fields
    /// you set actually override the base format; `None` means inherit.
    pub overrides: StyleOverrides,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Condition {
    /// Numeric comparison against a constant.
    GreaterThan(f64),
    GreaterOrEqual(f64),
    LessThan(f64),
    LessOrEqual(f64),
    Equals(f64),
    /// Numeric within an inclusive range.
    Between(f64, f64),
    /// Cell value is an error (#DIV/0!, #VALUE!, etc.)
    IsError,
    /// Cell value is empty / Null.
    IsEmpty,
    /// Cell text contains a substring (case-insensitive).
    ContainsText(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StyleOverrides {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub color: Option<String>,
    pub background: Option<String>,
}

impl ConditionalRule {
    pub fn matches(&self, v: &Value) -> bool {
        match &self.condition {
            Condition::GreaterThan(t) => num_pred(v, |n| n > *t),
            Condition::GreaterOrEqual(t) => num_pred(v, |n| n >= *t),
            Condition::LessThan(t) => num_pred(v, |n| n < *t),
            Condition::LessOrEqual(t) => num_pred(v, |n| n <= *t),
            Condition::Equals(t) => num_pred(v, |n| n == *t),
            Condition::Between(lo, hi) => num_pred(v, |n| n >= *lo && n <= *hi),
            Condition::IsError => matches!(v, Value::Error(_)),
            Condition::IsEmpty => matches!(v, Value::Null),
            Condition::ContainsText(needle) => match v {
                Value::Text(s) => s.to_lowercase().contains(&needle.to_lowercase()),
                _ => false,
            },
        }
    }
}

fn num_pred(v: &Value, f: impl Fn(f64) -> bool) -> bool {
    match v {
        Value::Number(n) => f(*n),
        Value::Boolean(true) => f(1.0),
        Value::Boolean(false) => f(0.0),
        _ => false,
    }
}

/// Apply rules in order to a value. Returns the merged style — base format
/// with overrides from the first matching rule. Stable order: rules earlier
/// in the slice win when multiple match.
pub fn apply_rules(base: &CellFormat, rules: &[ConditionalRule], v: &Value) -> CellFormat {
    let mut out = base.clone();
    for rule in rules {
        if rule.matches(v) {
            if let Some(b) = rule.overrides.bold {
                out.bold = b;
            }
            if let Some(i) = rule.overrides.italic {
                out.italic = i;
            }
            if rule.overrides.color.is_some() {
                out.color = rule.overrides.color.clone();
            }
            if rule.overrides.background.is_some() {
                out.background = rule.overrides.background.clone();
            }
            break; // first match wins
        }
    }
    out
}

fn insert_commas(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 3);
    for (i, &b) in bytes.iter().enumerate() {
        let from_right = bytes.len() - i;
        if i > 0 && from_right % 3 == 0 {
            out.push(b',');
        }
        out.push(b);
    }
    String::from_utf8(out).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_general() {
        let f = CellFormat::default();
        assert_eq!(f.format_number(42.0), "42");
        assert_eq!(f.format_number(3.14), "3.14");
    }

    #[test]
    fn fixed_decimal_no_thousands() {
        let f = CellFormat {
            number_format: NumberFormat::Decimal {
                digits: 2,
                thousands: false,
            },
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.5), "1234.50");
    }

    #[test]
    fn fixed_decimal_with_thousands() {
        let f = CellFormat {
            number_format: NumberFormat::Decimal {
                digits: 2,
                thousands: true,
            },
            ..Default::default()
        };
        assert_eq!(f.format_number(1234567.5), "1,234,567.50");
        assert_eq!(f.format_number(-1234.5), "-1,234.50");
    }

    #[test]
    fn fixed_decimal_zero_digits_rounds_before_grouping() {
        let f = CellFormat {
            number_format: NumberFormat::Decimal {
                digits: 0,
                thousands: true,
            },
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.6), "1,235");
        assert_eq!(f.format_number(-1234.4), "-1,234");
    }

    #[test]
    fn percent() {
        let f = CellFormat {
            number_format: NumberFormat::Percent { digits: 1 },
            ..Default::default()
        };
        assert_eq!(f.format_number(0.125), "12.5%");
    }

    #[test]
    fn percent_zero_digits_scales_and_preserves_sign() {
        let f = CellFormat {
            number_format: NumberFormat::Percent { digits: 0 },
            ..Default::default()
        };
        assert_eq!(f.format_number(0.1234), "12%");
        assert_eq!(f.format_number(-0.5), "-50%");
    }

    #[test]
    fn rule_greater_than() {
        let r = ConditionalRule {
            condition: Condition::GreaterThan(100.0),
            overrides: StyleOverrides {
                color: Some("red".into()),
                ..Default::default()
            },
        };
        assert!(r.matches(&Value::Number(150.0)));
        assert!(!r.matches(&Value::Number(50.0)));
        assert!(!r.matches(&Value::Text("hi".into())));
    }

    #[test]
    fn rule_is_error() {
        use einfach_core::ValueError;
        let r = ConditionalRule {
            condition: Condition::IsError,
            overrides: Default::default(),
        };
        assert!(r.matches(&Value::Error(ValueError::DivisionByZero)));
        assert!(!r.matches(&Value::Number(0.0)));
    }

    #[test]
    fn rule_contains_text_case_insensitive() {
        let r = ConditionalRule {
            condition: Condition::ContainsText("ERR".into()),
            overrides: Default::default(),
        };
        assert!(r.matches(&Value::Text("error message".into())));
        assert!(!r.matches(&Value::Text("ok".into())));
    }

    #[test]
    fn apply_rules_first_match_wins() {
        let base = CellFormat::default();
        let rules = vec![
            ConditionalRule {
                condition: Condition::GreaterThan(100.0),
                overrides: StyleOverrides {
                    color: Some("red".into()),
                    ..Default::default()
                },
            },
            ConditionalRule {
                condition: Condition::GreaterThan(50.0),
                overrides: StyleOverrides {
                    color: Some("orange".into()),
                    ..Default::default()
                },
            },
        ];
        let f = apply_rules(&base, &rules, &Value::Number(150.0));
        assert_eq!(f.color, Some("red".into()));
        let f = apply_rules(&base, &rules, &Value::Number(75.0));
        assert_eq!(f.color, Some("orange".into()));
        let f = apply_rules(&base, &rules, &Value::Number(10.0));
        assert_eq!(f.color, None);
    }

    #[test]
    fn currency() {
        let f = CellFormat {
            number_format: NumberFormat::Currency {
                symbol: "¥".into(),
                digits: 2,
            },
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.56), "¥1,234.56");
    }

    #[test]
    fn currency_uses_symbol_grouping_and_configured_digits() {
        let f = CellFormat {
            number_format: NumberFormat::Currency {
                symbol: "$".into(),
                digits: 0,
            },
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.6), "$1,235");
    }

    #[test]
    fn custom_number_format_literals_scaling_and_bracket_tags() {
        let f = CellFormat {
            number_format: NumberFormat::Custom("#,##0.00\" kg\"".into()),
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.5), "1,234.50 kg");

        let f = CellFormat {
            number_format: NumberFormat::Custom("#,##0,,".into()),
            ..Default::default()
        };
        assert_eq!(f.format_number(1_234_567_890.0), "1,235");

        let f = CellFormat {
            number_format: NumberFormat::Custom("[Red][$¥-411]#,##0.0".into()),
            ..Default::default()
        };
        assert_eq!(f.format_number(1234.56), "1,234.6");
    }

    #[test]
    fn custom_number_format_sections() {
        let f = CellFormat {
            number_format: NumberFormat::Custom("0;[Red](0);\"-\"".into()),
            ..Default::default()
        };
        assert_eq!(f.format_number(12.0), "12");
        assert_eq!(f.format_number(-12.0), "(12)");
        assert_eq!(f.format_number(0.0), "-");
    }
}
