use einfach_core::Value;

use crate::cell::CellAddress;

/// One reversible cell-level edit. Stores the previous and next state so
/// undo and redo can both be implemented as "apply this in reverse".
///
/// `formula` is set when the slot held a formula; `value` is set when the
/// slot held a primitive value (or was empty / Null).
#[derive(Clone, Debug, PartialEq)]
pub struct CellSnapshot {
    pub addr: CellAddress,
    pub value: Option<Value>,
    pub formula: Option<String>,
}

impl CellSnapshot {
    pub fn empty(addr: CellAddress) -> Self {
        CellSnapshot {
            addr,
            value: None,
            formula: None,
        }
    }
    pub fn value(addr: CellAddress, v: Value) -> Self {
        CellSnapshot {
            addr,
            value: Some(v),
            formula: None,
        }
    }
    pub fn formula(addr: CellAddress, f: String) -> Self {
        CellSnapshot {
            addr,
            value: None,
            formula: Some(f),
        }
    }
}

/// A user-initiated edit grouped as one undo unit. Multi-cell paste / clear
/// becomes a single Edit so undo restores the whole rectangle in one step.
#[derive(Clone, Debug, PartialEq)]
pub struct Edit {
    pub before: Vec<CellSnapshot>,
    pub after: Vec<CellSnapshot>,
}

/// Bounded undo / redo history. Pushing a new edit when redo entries exist
/// drops them — the timeline forks at the most recent action.
#[derive(Default, Debug)]
pub struct UndoStack {
    undo: Vec<Edit>,
    redo: Vec<Edit>,
    capacity: usize,
}

impl UndoStack {
    pub fn new(capacity: usize) -> Self {
        UndoStack {
            undo: Vec::new(),
            redo: Vec::new(),
            capacity,
        }
    }

    pub fn push(&mut self, edit: Edit) {
        self.redo.clear();
        self.undo.push(edit);
        if self.capacity > 0 && self.undo.len() > self.capacity {
            // Drop the oldest entry rather than refusing the new one.
            let drop_n = self.undo.len() - self.capacity;
            self.undo.drain(0..drop_n);
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Pop one entry from the undo side and move it to redo. Returns the
    /// `before` snapshots so the caller can restore them.
    pub fn undo(&mut self) -> Option<Edit> {
        let edit = self.undo.pop()?;
        let cloned = edit.clone();
        self.redo.push(edit);
        Some(cloned)
    }

    pub fn redo(&mut self) -> Option<Edit> {
        let edit = self.redo.pop()?;
        let cloned = edit.clone();
        self.undo.push(edit);
        Some(cloned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(addr: CellAddress, n: f64) -> CellSnapshot {
        CellSnapshot::value(addr, Value::Number(n))
    }

    #[test]
    fn push_clears_redo() {
        let mut s = UndoStack::new(0);
        let e1 = Edit {
            before: vec![snap(CellAddress::new(0, 0), 1.0)],
            after: vec![snap(CellAddress::new(0, 0), 2.0)],
        };
        s.push(e1);
        s.undo();
        assert!(s.can_redo());
        let e2 = Edit {
            before: vec![],
            after: vec![],
        };
        s.push(e2);
        assert!(!s.can_redo(), "new push must clear redo");
    }

    #[test]
    fn undo_redo_cycle() {
        let mut s = UndoStack::new(0);
        let e = Edit {
            before: vec![snap(CellAddress::new(0, 0), 1.0)],
            after: vec![snap(CellAddress::new(0, 0), 2.0)],
        };
        s.push(e.clone());
        let popped = s.undo().unwrap();
        assert_eq!(popped, e);
        let re = s.redo().unwrap();
        assert_eq!(re, e);
    }

    #[test]
    fn capacity_drops_oldest() {
        let mut s = UndoStack::new(2);
        for i in 0..5 {
            s.push(Edit {
                before: vec![snap(CellAddress::new(0, 0), i as f64)],
                after: vec![snap(CellAddress::new(0, 0), (i + 1) as f64)],
            });
        }
        assert_eq!(s.undo.len(), 2);
        // Newest two should remain.
        let last = s.undo().unwrap();
        assert_eq!(last.before[0].value, Some(Value::Number(4.0)));
    }
}
