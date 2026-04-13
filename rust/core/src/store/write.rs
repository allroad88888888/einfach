use std::collections::HashSet;

use crate::atom::{AtomId, Value};

use super::Store;

impl Store {
    /// Write a new value to an atom.
    /// - Primitive atoms: writes directly.
    /// - Writable derived atoms: delegates to write_fn.
    /// - Read-only derived atoms: panics.
    pub fn set(&mut self, id: AtomId, value: Value) {
        if let Some(write_fn) = self.write_fns.get(&id).cloned() {
            let mut sets_to_apply: Vec<(AtomId, Value)> = Vec::new();
            write_fn(
                &mut |target_id: AtomId, val: Value| {
                    sets_to_apply.push((target_id, val));
                },
                value,
            );
            self.batch(|s| {
                for (target_id, val) in sets_to_apply {
                    s.set(target_id, val);
                }
            });
            return;
        }

        assert!(
            !self.read_fns.contains_key(&id),
            "cannot set a read-only derived atom"
        );
        assert!(self.values.contains_key(&id), "atom not found in store");

        let old = self.values.get(&id);
        if old == Some(&value) {
            return;
        }

        self.values.insert(id, value);

        if self.batch_depth > 0 {
            self.pending_dirty.push(id);
            return;
        }

        self.propagate_and_notify(&[id]);
    }

    /// Execute a function that may call set() multiple times.
    /// Propagation and notification happen once at the end.
    pub fn batch(&mut self, f: impl FnOnce(&mut Self)) {
        self.batch_depth += 1;
        f(self);
        self.batch_depth -= 1;

        if self.batch_depth == 0 && !self.pending_dirty.is_empty() {
            let dirty = std::mem::take(&mut self.pending_dirty);
            self.propagate_and_notify(&dirty);
        }
    }

    /// Propagate changes from dirty roots and notify subscribers.
    pub(super) fn propagate_and_notify(&mut self, dirty_roots: &[AtomId]) {
        let mut unique_roots = Vec::new();
        let mut seen = HashSet::new();
        for &root in dirty_roots {
            if seen.insert(root) {
                unique_roots.push(root);
            }
        }

        let mut all_affected = HashSet::new();
        for &root in &unique_roots {
            for id in self.collect_affected(root) {
                all_affected.insert(id);
            }
        }

        let sorted = self.topological_sort(&all_affected);
        let mut changed: Vec<AtomId> = unique_roots;

        for derived_id in sorted {
            let old = self.values.get(&derived_id).cloned();
            self.recompute(derived_id);
            let new_val = self.values.get(&derived_id);
            if old.as_ref() != new_val {
                changed.push(derived_id);
            }
        }

        self.notify(&changed);
    }
}
