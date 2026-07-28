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
    Null,           // #NULL!
    DivisionByZero, // #DIV/0!
    NotAvailable,   // #N/A
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
    /// A dynamic-array formula attempted to spill into a cell that already
    /// holds a non-empty value (primitive, formula, or another spill range).
    /// Excel shows this as `#SPILL!`. The anchor cell holds this error and
    /// the would-be spill targets remain unchanged.
    Spill, // #SPILL!
    /// Excel calculation-engine error for results that cannot be represented
    /// in the current scalar/array context, such as a nested dynamic array
    /// returned from a higher-order array callback.
    Calc, // #CALC!
    /// An async custom-formula call is in flight: the cell holds this error
    /// until the host resolves the pending Promise, at which point the
    /// per-call result atom is written and dependents recompute. Propagates
    /// through the normal error short-circuit so dependents show pending too.
    Busy, // #BUSY!
}

impl std::fmt::Display for ValueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValueError::Null => write!(f, "#NULL!"),
            ValueError::DivisionByZero => write!(f, "#DIV/0!"),
            ValueError::NotAvailable => write!(f, "#N/A"),
            ValueError::InvalidRef => write!(f, "#REF!"),
            ValueError::InvalidValue => write!(f, "#VALUE!"),
            ValueError::InvalidName => write!(f, "#NAME?"),
            ValueError::CyclicRef => write!(f, "#CYCLE!"),
            ValueError::Overflow => write!(f, "#NUM!"),
            ValueError::WrongType => write!(f, "#TYPE!"),
            ValueError::WrongArgCount => write!(f, "#ARGS!"),
            ValueError::Spill => write!(f, "#SPILL!"),
            ValueError::Calc => write!(f, "#CALC!"),
            ValueError::Busy => write!(f, "#BUSY!"),
        }
    }
}

/// A rectangular block of values produced by a dynamic-array (spill)
/// formula. Stored row-major (`row * cols + col`). Wrapped in `Arc` at the
/// `Value::Array` boundary so cloning is cheap — the spilled cell's
/// derived atom calls `arr.get(di, dj)` on every read, and we never want
/// to deep-copy the whole array per read.
#[derive(Debug)]
pub struct ArrayData {
    pub rows: u32,
    pub cols: u32,
    pub data: Vec<Value>, // row-major: index = row * cols + col
}

impl ArrayData {
    /// Construct a new ArrayData. Panics if `data.len() != rows * cols`.
    pub fn new(rows: u32, cols: u32, data: Vec<Value>) -> Self {
        assert_eq!(
            data.len() as u64,
            rows as u64 * cols as u64,
            "ArrayData::new: data.len() ({}) must equal rows ({}) * cols ({})",
            data.len(),
            rows,
            cols
        );
        ArrayData { rows, cols, data }
    }

    /// Fetch a single element by 0-based (row, col). None if out of range.
    pub fn get(&self, row: u32, col: u32) -> Option<&Value> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        let idx = (row as usize) * (self.cols as usize) + (col as usize);
        self.data.get(idx)
    }

    /// Shape as `(rows, cols)`.
    pub fn shape(&self) -> (u32, u32) {
        (self.rows, self.cols)
    }
}

/// Trait object implemented by lambda payloads. The actual lambda body
/// (the `Expr` AST) lives in `einfach-excel-core` to avoid pulling the
/// formula parser into `einfach-core`; we keep `Value` framework-neutral
/// by exposing just enough surface here (`arity`, `param_names`, equality
/// via `Arc::ptr_eq`) and let the formula evaluator downcast through
/// `as_any` when it actually needs the body to apply the lambda.
///
/// Why a trait + downcast rather than embedding `Expr` directly in
/// `Value`? `Expr` is defined in `einfach-excel-core` (the formula
/// engine), and `Value` ships in `einfach-core` (used by the atom store
/// for arbitrary state, not just formula results). A direct enum variant
/// would force a circular dependency. The trait keeps `Value::Lambda`
/// opaque at the core boundary and the excel-core layer reaches the
/// body through `as_any` + `downcast_ref::<ExcelLambda>`.
pub trait LambdaValue: std::fmt::Debug + Send + Sync {
    fn arity(&self) -> usize;
    fn param_names(&self) -> &[String];
    /// Hook for downcasting to the concrete payload (e.g. `ExcelLambda`
    /// in the formula evaluator). The default impl returns `self` so any
    /// implementor satisfies the contract without writing boilerplate;
    /// concrete impls can leave it as-is.
    fn as_any(&self) -> &dyn std::any::Any;
}

/// A value held by an atom.
#[derive(Clone, Debug)]
pub enum Value {
    Number(f64),
    Text(String),
    Boolean(bool),
    Null,
    Error(ValueError),
    /// A rectangular block of scalar values produced by a dynamic-array
    /// formula. The `Sheet` layer expands this into derived atoms at the
    /// spill targets; the top-level boundary (WASM) collapses `Array` to
    /// the top-left element so JS consumers never observe this variant.
    Array(std::sync::Arc<ArrayData>),
    /// A first-class lambda value. Constructed by `=LAMBDA(p1, ..., body)`
    /// in the formula evaluator and consumed by the array higher-order
    /// functions (MAP / REDUCE / SCAN / BYROW / BYCOL / MAKEARRAY) or by
    /// immediate application (`=LAMBDA(x, x*x)(5)`). The Arc'd trait
    /// object hides the AST body from this crate; equality is `ptr_eq`
    /// (two lambdas are the same iff they share the same Arc).
    Lambda(std::sync::Arc<dyn LambdaValue>),
}

impl Value {
    /// Try to extract a number, returning None for non-numeric types.
    /// `Array` is intentionally rejected — callers operate on scalars.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// Try to extract text, returning None for non-text types.
    /// `Array` is intentionally rejected — callers operate on scalars.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    /// Try to extract a boolean.
    /// `Array` is intentionally rejected — callers operate on scalars.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Boolean(b) => Some(*b),
            _ => None,
        }
    }

    /// Returns true if this value is an error.
    /// `Array` is NOT an error even if some elements inside are errors —
    /// per-element error handling happens on the spilled-cell derived atoms.
    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error(_))
    }

    /// Returns true if this value is null/empty.
    /// `Array` is never null (it's a populated block).
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
            (Value::Array(a), Value::Array(b)) => {
                // Fast path: same Arc means same data.
                if std::sync::Arc::ptr_eq(a, b) {
                    return true;
                }
                // Shape + element-wise compare. Recurses through
                // `Value::eq` so nested NaN parity etc. is preserved.
                a.rows == b.rows && a.cols == b.cols && a.data == b.data
            }
            // Lambdas compare by Arc identity only — there's no structural
            // equality on lambda bodies (an `Expr` AST is involved and lives
            // in another crate). Two distinct `=LAMBDA(x, x)` evaluations
            // produce distinct Arcs and are therefore unequal even though
            // their source text matches. This is fine because lambdas are
            // produced/consumed within a single evaluation chain — they
            // don't get persisted into the cell-store as durable equal values.
            (Value::Lambda(a), Value::Lambda(b)) => std::sync::Arc::ptr_eq(a, b),
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

    #[test]
    fn busy_error_display() {
        assert_eq!(ValueError::Busy.to_string(), "#BUSY!");
        assert_eq!(Value::Error(ValueError::Busy), Value::Error(ValueError::Busy));
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
        assert_eq!(format!("{}", ValueError::Null), "#NULL!");
        assert_eq!(format!("{}", ValueError::NotAvailable), "#N/A");
        assert_eq!(format!("{}", ValueError::InvalidRef), "#REF!");
        assert_eq!(format!("{}", ValueError::CyclicRef), "#CYCLE!");
        assert_eq!(format!("{}", ValueError::Calc), "#CALC!");
    }
}
