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
    fn percent() {
        let f = CellFormat {
            number_format: NumberFormat::Percent { digits: 1 },
            ..Default::default()
        };
        assert_eq!(f.format_number(0.125), "12.5%");
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
}
