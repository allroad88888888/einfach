/// Unique identifier for an atom in the store.
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct AtomId(pub(crate) u64);

impl AtomId {
    /// Create an AtomId from a raw u64. For testing only.
    pub fn from_raw(id: u64) -> Self {
        AtomId(id)
    }
}

/// Error types that can occur in cell formulas.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValueError {
    DivisionByZero, // #DIV/0!
    InvalidRef,     // #REF!
    InvalidValue,   // #VALUE!
    InvalidName,    // #NAME?
    CyclicRef,      // #CYCLE!
    /// Numeric result is infinite or NaN (e.g. POWER(2, 1e308)). Excel
    /// surfaces this as #NUM! — we use a distinct variant so callers can
    /// distinguish a type-coercion failure (#VALUE!) from an out-of-range
    /// numeric result (#NUM!).
    Overflow, // #NUM!
    /// A value of the wrong type was passed to an operator or function that
    /// required a specific type (e.g., text passed to an arithmetic operator
    /// that has no numeric coercion path). Distinct from `InvalidValue` which
    /// is a catch-all; `WrongType` signals specifically a type mismatch.
    WrongType, // #TYPE!
    /// A function was called with the wrong number of arguments. Excel shows
    /// this as a parse/compile error; we surface it at eval time as a
    /// distinct code so tests can assert precise argument-count checking.
    WrongArgCount, // #ARGS!
}

impl std::fmt::Display for ValueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValueError::DivisionByZero => write!(f, "#DIV/0!"),
            ValueError::InvalidRef => write!(f, "#REF!"),
            ValueError::InvalidValue => write!(f, "#VALUE!"),
            ValueError::InvalidName => write!(f, "#NAME?"),
            ValueError::CyclicRef => write!(f, "#CYCLE!"),
            ValueError::Overflow => write!(f, "#NUM!"),
            ValueError::WrongType => write!(f, "#TYPE!"),
            ValueError::WrongArgCount => write!(f, "#ARGS!"),
        }
    }
}

/// A value held by an atom.
#[derive(Clone, Debug)]
pub enum Value {
    Number(f64),
    Text(String),
    Boolean(bool),
    Null,
    Error(ValueError),
}

impl Value {
    /// Try to extract a number, returning None for non-numeric types.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// Try to extract text, returning None for non-text types.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    /// Try to extract a boolean.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Boolean(b) => Some(*b),
            _ => None,
        }
    }

    /// Returns true if this value is an error.
    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }

    /// Returns true if this value is null/empty.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            // All NaN values compare equal regardless of bit pattern. Without
            // this fallback, two #DIV/0!-induced NaNs from different code
            // paths (quiet vs signaling, different payloads) would be
            // considered different and trigger spurious downstream
            // recompute + notify (A.3).
            (Value::Number(a), Value::Number(b)) if a.is_nan() && b.is_nan() => true,
            (Value::Number(a), Value::Number(b)) => a.to_bits() == b.to_bits(),
            (Value::Text(a), Value::Text(b)) => a == b,
            (Value::Boolean(a), Value::Boolean(b)) => a == b,
            (Value::Null, Value::Null) => true,
            (Value::Error(a), Value::Error(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for Value {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_equality() {
        assert_eq!(Value::Number(1.0), Value::Number(1.0));
        assert_ne!(Value::Number(1.0), Value::Number(2.0));
    }

    #[test]
    fn text_equality() {
        assert_eq!(Value::Text("hello".into()), Value::Text("hello".into()));
        assert_ne!(Value::Text("hello".into()), Value::Text("world".into()));
    }

    #[test]
    fn cross_type_not_equal() {
        assert_ne!(Value::Number(1.0), Value::Text("1".into()));
    }

    #[test]
    fn nan_equality_bitwise() {
        assert_eq!(Value::Number(f64::NAN), Value::Number(f64::NAN));
    }

    #[test]
    fn nan_equality_across_different_payloads() {
        // Construct two distinct NaN bit patterns. Both should compare equal
        // — without the is_nan fallback they'd differ by bits.
        let a = f64::NAN;
        let b = f64::from_bits(0x7ff8_0000_0000_0001);
        assert_ne!(a.to_bits(), b.to_bits(), "test setup: bits should differ");
        assert_eq!(Value::Number(a), Value::Number(b));
    }

    #[test]
    fn positive_and_negative_zero() {
        assert_ne!(Value::Number(0.0), Value::Number(-0.0));
    }

    #[test]
    fn atom_id_equality() {
        assert_eq!(AtomId(1), AtomId(1));
        assert_ne!(AtomId(1), AtomId(2));
    }

    // Step 7: New type tests

    #[test]
    fn boolean_equality() {
        assert_eq!(Value::Boolean(true), Value::Boolean(true));
        assert_ne!(Value::Boolean(true), Value::Boolean(false));
    }

    #[test]
    fn null_equality() {
        assert_eq!(Value::Null, Value::Null);
    }

    #[test]
    fn error_equality() {
        assert_eq!(
            Value::Error(ValueError::DivisionByZero),
            Value::Error(ValueError::DivisionByZero)
        );
        assert_ne!(
            Value::Error(ValueError::DivisionByZero),
            Value::Error(ValueError::InvalidRef)
        );
    }

    #[test]
    fn null_not_equal_to_others() {
        assert_ne!(Value::Null, Value::Number(0.0));
        assert_ne!(Value::Null, Value::Text("".into()));
        assert_ne!(Value::Null, Value::Boolean(false));
    }

    #[test]
    fn error_not_equal_to_number() {
        assert_ne!(Value::Error(ValueError::InvalidValue), Value::Number(0.0));
    }

    #[test]
    fn as_number_works() {
        assert_eq!(Value::Number(3.14).as_number(), Some(3.14));
        assert_eq!(Value::Text("hi".into()).as_number(), None);
        assert_eq!(Value::Null.as_number(), None);
    }

    #[test]
    fn as_text_works() {
        assert_eq!(Value::Text("hi".into()).as_text(), Some("hi"));
        assert_eq!(Value::Number(1.0).as_text(), None);
    }

    #[test]
    fn as_bool_works() {
        assert_eq!(Value::Boolean(true).as_bool(), Some(true));
        assert_eq!(Value::Number(1.0).as_bool(), None);
    }

    #[test]
    fn is_error_works() {
        assert!(Value::Error(ValueError::DivisionByZero).is_error());
        assert!(!Value::Number(1.0).is_error());
    }

    #[test]
    fn is_null_works() {
        assert!(Value::Null.is_null());
        assert!(!Value::Number(0.0).is_null());
    }

    #[test]
    fn error_display() {
        assert_eq!(format!("{}", ValueError::DivisionByZero), "#DIV/0!");
        assert_eq!(format!("{}", ValueError::InvalidRef), "#REF!");
        assert_eq!(format!("{}", ValueError::CyclicRef), "#CYCLE!");
    }
}
