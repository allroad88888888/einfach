/// Unique identifier for an atom in the store.
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct AtomId(pub(crate) u64);

/// A value held by an atom. Currently supports numbers and text.
#[derive(Clone, Debug)]
pub enum Value {
    Number(f64),
    Text(String),
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Value::Number(a), Value::Number(b)) => a.to_bits() == b.to_bits(),
            (Value::Text(a), Value::Text(b)) => a == b,
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
        // NaN should equal itself (bitwise comparison)
        assert_eq!(Value::Number(f64::NAN), Value::Number(f64::NAN));
    }

    #[test]
    fn positive_and_negative_zero() {
        // +0.0 and -0.0 have different bits, so they should not be equal
        assert_ne!(Value::Number(0.0), Value::Number(-0.0));
    }

    #[test]
    fn atom_id_equality() {
        assert_eq!(AtomId(1), AtomId(1));
        assert_ne!(AtomId(1), AtomId(2));
    }
}
