use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::atom::{AtomId, Value};

/// Read function for derived atoms. Takes a getter and returns a computed value.
type ReadFn = Rc<dyn Fn(&dyn Fn(AtomId) -> Value) -> Value>;

/// Write function for writable derived atoms. Takes a setter and the new value.
type WriteFn = Rc<dyn Fn(&mut dyn FnMut(AtomId, Value), Value)>;

/// Listener callback invoked when a subscribed atom's value changes.
type Listener = Rc<dyn Fn()>;

/// Unique identifier for a subscription.
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct SubscriptionId(u64);

/// The central state container. Manages atom values and their relationships.
pub struct Store {
    values: HashMap<AtomId, Value>,
    read_fns: HashMap<AtomId, ReadFn>,
    write_fns: HashMap<AtomId, WriteFn>,
    /// derived atom → set of atoms it depends on
    dependencies: HashMap<AtomId, HashSet<AtomId>>,
    /// atom → set of derived atoms that depend on it
    back_deps: HashMap<AtomId, HashSet<AtomId>>,
    /// atom → list of (sub_id, listener)
    subscriptions: HashMap<AtomId, Vec<(SubscriptionId, Listener)>>,
    next_id: u64,
    next_sub_id: u64,
    /// Batch nesting depth. When > 0, set() defers propagation.
    batch_depth: u32,
    /// Atoms dirtied during a batch, pending propagation.
    pending_dirty: Vec<AtomId>,
}

// Thread-local to track dependencies during read_fn evaluation
thread_local! {
    static TRACKING: RefCell<Option<HashSet<AtomId>>> = RefCell::new(None);
    // Set of atoms currently being computed (for cycle detection)
    static COMPUTING: RefCell<HashSet<AtomId>> = RefCell::new(HashSet::new());
}

impl Store {
    pub fn new() -> Self {
        Store {
            values: HashMap::new(),
            read_fns: HashMap::new(),
            write_fns: HashMap::new(),
            dependencies: HashMap::new(),
            back_deps: HashMap::new(),
            subscriptions: HashMap::new(),
            next_id: 0,
            next_sub_id: 0,
            batch_depth: 0,
            pending_dirty: Vec::new(),
        }
    }

    fn alloc_id(&mut self) -> AtomId {
        let id = AtomId(self.next_id);
        self.next_id += 1;
        id
    }

    /// Create a primitive atom with an initial value.
    pub fn create_atom(&mut self, init: Value) -> AtomId {
        let id = self.alloc_id();
        self.values.insert(id, init);
        id
    }

    /// Create a read-only derived atom whose value is computed from other atoms.
    pub fn create_derived(
        &mut self,
        read_fn: impl Fn(&dyn Fn(AtomId) -> Value) -> Value + 'static,
    ) -> AtomId {
        let id = self.alloc_id();
        self.read_fns.insert(id, Rc::new(read_fn));
        // Compute initial value + track deps
        self.recompute(id);
        id
    }

    /// Create a writable derived atom with both read and write functions.
    /// The write_fn receives a setter closure and the value being written.
    pub fn create_writable(
        &mut self,
        read_fn: impl Fn(&dyn Fn(AtomId) -> Value) -> Value + 'static,
        write_fn: impl Fn(&mut dyn FnMut(AtomId, Value), Value) + 'static,
    ) -> AtomId {
        let id = self.alloc_id();
        self.read_fns.insert(id, Rc::new(read_fn));
        self.write_fns.insert(id, Rc::new(write_fn));
        self.recompute(id);
        id
    }

    /// Recompute a derived atom's value and update its dependency graph.
    fn recompute(&mut self, id: AtomId) {
        let read_fn = self.read_fns.get(&id).expect("not a derived atom").clone();

        // Cycle detection: mark this atom as being computed
        let already_computing = COMPUTING.with(|c| !c.borrow_mut().insert(id));
        if already_computing {
            panic!("circular dependency detected involving atom {:?}", id);
        }

        // Snapshot current values so the read_fn can access them
        let values = &self.values as *const HashMap<AtomId, Value>;

        // Start tracking
        TRACKING.with(|t| *t.borrow_mut() = Some(HashSet::new()));

        // The getter: reads a value and records the dep
        let getter = |dep_id: AtomId| -> Value {
            // Check for cycle: if dep_id is currently being computed, it's a cycle
            let is_cycle = COMPUTING.with(|c| c.borrow().contains(&dep_id));
            if is_cycle {
                panic!(
                    "circular dependency detected: atom {:?} depends on atom {:?} which is being computed",
                    dep_id, dep_id
                );
            }

            TRACKING.with(|t| {
                if let Some(ref mut deps) = *t.borrow_mut() {
                    deps.insert(dep_id);
                }
            });
            // Safety: we only read from values, no mutation during read_fn call
            unsafe {
                if let Some(val) = (*values).get(&dep_id) {
                    return val.clone();
                }
            }
            panic!("atom {:?} not found in store", dep_id);
        };

        let new_value = read_fn(&getter);

        // Remove from computing set
        COMPUTING.with(|c| c.borrow_mut().remove(&id));

        // Collect tracked deps
        let new_deps = TRACKING.with(|t| t.borrow_mut().take().unwrap());

        // Update dependency graph: remove old back_deps, add new ones
        if let Some(old_deps) = self.dependencies.get(&id) {
            for old_dep in old_deps {
                if let Some(backs) = self.back_deps.get_mut(old_dep) {
                    backs.remove(&id);
                }
            }
        }
        for dep in &new_deps {
            self.back_deps.entry(*dep).or_default().insert(id);
        }
        self.dependencies.insert(id, new_deps);

        // Store computed value
        self.values.insert(id, new_value);
    }

    /// Read the current value of an atom.
    pub fn get(&self, id: AtomId) -> Value {
        self.values
            .get(&id)
            .expect("atom not found in store")
            .clone()
    }

    /// Write a new value to an atom.
    /// - Primitive atoms: writes directly.
    /// - Writable derived atoms: delegates to write_fn.
    /// - Read-only derived atoms: panics.
    pub fn set(&mut self, id: AtomId, value: Value) {
        // If it has a write_fn, delegate to it
        if let Some(write_fn) = self.write_fns.get(&id).cloned() {
            // Collect the sets that write_fn wants to make
            let mut sets_to_apply: Vec<(AtomId, Value)> = Vec::new();
            write_fn(
                &mut |target_id: AtomId, val: Value| {
                    sets_to_apply.push((target_id, val));
                },
                value,
            );
            // Apply them in a batch
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
            return; // no change
        }

        self.values.insert(id, value);

        if self.batch_depth > 0 {
            // Inside batch: defer propagation
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
    fn propagate_and_notify(&mut self, dirty_roots: &[AtomId]) {
        // Deduplicate dirty roots
        let mut unique_roots = Vec::new();
        let mut seen = HashSet::new();
        for &root in dirty_roots {
            if seen.insert(root) {
                unique_roots.push(root);
            }
        }

        // Collect all affected derived atoms from all dirty roots
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

    /// Subscribe to value changes on an atom. Returns a subscription id for unsubscribing.
    pub fn sub(&mut self, id: AtomId, listener: impl Fn() + 'static) -> SubscriptionId {
        let sub_id = SubscriptionId(self.next_sub_id);
        self.next_sub_id += 1;
        self.subscriptions
            .entry(id)
            .or_default()
            .push((sub_id, Rc::new(listener)));
        sub_id
    }

    /// Remove a subscription.
    pub fn unsub(&mut self, sub_id: SubscriptionId) {
        for subs in self.subscriptions.values_mut() {
            subs.retain(|(id, _)| *id != sub_id);
        }
    }

    /// Notify all subscribers of the given atoms.
    fn notify(&self, changed: &[AtomId]) {
        for id in changed {
            if let Some(subs) = self.subscriptions.get(id) {
                for (_, listener) in subs {
                    listener();
                }
            }
        }
    }

    /// Collect all derived atoms transitively affected by a change to `root`.
    fn collect_affected(&self, root: AtomId) -> HashSet<AtomId> {
        let mut affected = HashSet::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if affected.insert(back) {
                        stack.push(back);
                    }
                }
            }
        }
        affected
    }

    /// Topological sort of affected derived atoms (dependencies first).
    fn topological_sort(&self, affected: &HashSet<AtomId>) -> Vec<AtomId> {
        let mut in_degree: HashMap<AtomId, usize> = HashMap::new();
        for &id in affected {
            in_degree.entry(id).or_insert(0);
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if affected.contains(&back) {
                        *in_degree.entry(back).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut queue: Vec<AtomId> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();
        let mut result = Vec::new();

        while let Some(id) = queue.pop() {
            result.push(id);
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if let Some(deg) = in_degree.get_mut(&back) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push(back);
                        }
                    }
                }
            }
        }

        result
    }
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // === Step 2: Primitive atom tests ===

    #[test]
    fn create_and_get_number() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(0.0));
        assert_eq!(store.get(a), Value::Number(0.0));
    }

    #[test]
    fn set_number() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(0.0));
        store.set(a, Value::Number(5.0));
        assert_eq!(store.get(a), Value::Number(5.0));
    }

    #[test]
    fn create_and_get_text() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Text("hello".into()));
        assert_eq!(store.get(a), Value::Text("hello".into()));
    }

    #[test]
    fn set_text() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Text("hello".into()));
        store.set(a, Value::Text("world".into()));
        assert_eq!(store.get(a), Value::Text("world".into()));
    }

    #[test]
    fn multiple_atoms_independent() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_atom(Value::Number(2.0));
        store.set(a, Value::Number(10.0));
        assert_eq!(store.get(a), Value::Number(10.0));
        assert_eq!(store.get(b), Value::Number(2.0));
    }

    #[test]
    fn unique_ids() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(0.0));
        let b = store.create_atom(Value::Number(0.0));
        assert_ne!(a, b);
    }

    #[test]
    #[should_panic(expected = "atom not found")]
    fn get_nonexistent_atom_panics() {
        let store = Store::new();
        store.get(AtomId(999));
    }

    #[test]
    #[should_panic(expected = "atom not found")]
    fn set_nonexistent_atom_panics() {
        let mut store = Store::new();
        store.set(AtomId(999), Value::Number(1.0));
    }

    // === Step 3: Derived atom tests ===

    #[test]
    fn derived_atom_basic() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(3.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) {
                Value::Number(n * 2.0)
            } else {
                panic!("expected number")
            }
        });
        assert_eq!(store.get(b), Value::Number(6.0));
    }

    #[test]
    fn derived_updates_on_set() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(3.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) {
                Value::Number(n * 2.0)
            } else {
                panic!("expected number")
            }
        });
        assert_eq!(store.get(b), Value::Number(6.0));

        store.set(a, Value::Number(5.0));
        assert_eq!(store.get(b), Value::Number(10.0));
    }

    #[test]
    fn multi_level_derived() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) {
                Value::Number(n * 2.0)
            } else {
                panic!("expected number")
            }
        });
        let c = store.create_derived(move |get| {
            if let Value::Number(n) = get(b) {
                Value::Number(n + 1.0)
            } else {
                panic!("expected number")
            }
        });
        assert_eq!(store.get(c), Value::Number(3.0)); // 1*2 + 1

        store.set(a, Value::Number(5.0));
        assert_eq!(store.get(b), Value::Number(10.0));
        assert_eq!(store.get(c), Value::Number(11.0)); // 5*2 + 1
    }

    #[test]
    fn derived_with_multiple_deps() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(2.0));
        let b = store.create_atom(Value::Number(3.0));
        let c = store.create_derived(move |get| {
            if let (Value::Number(x), Value::Number(y)) = (get(a), get(b)) {
                Value::Number(x + y)
            } else {
                panic!("expected numbers")
            }
        });
        assert_eq!(store.get(c), Value::Number(5.0));

        store.set(a, Value::Number(10.0));
        assert_eq!(store.get(c), Value::Number(13.0));

        store.set(b, Value::Number(20.0));
        assert_eq!(store.get(c), Value::Number(30.0));
    }

    #[test]
    #[should_panic(expected = "cannot set a read-only derived atom")]
    fn cannot_set_derived_atom() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| get(a));
        store.set(b, Value::Number(99.0));
    }

    #[test]
    fn fan_in_chain() {
        // a=1, b=a*2=2, c=b+1=3, d=a+b+c=6
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) { Value::Number(n * 2.0) } else { panic!() }
        });
        let c = store.create_derived(move |get| {
            if let Value::Number(n) = get(b) { Value::Number(n + 1.0) } else { panic!() }
        });
        let d = store.create_derived(move |get| {
            if let (Value::Number(va), Value::Number(vb), Value::Number(vc)) =
                (get(a), get(b), get(c))
            {
                Value::Number(va + vb + vc)
            } else {
                panic!()
            }
        });

        assert_eq!(store.get(d), Value::Number(6.0)); // 1 + 2 + 3

        store.set(a, Value::Number(5.0));
        // b=10, c=11, d=5+10+11=26
        assert_eq!(store.get(b), Value::Number(10.0));
        assert_eq!(store.get(c), Value::Number(11.0));
        assert_eq!(store.get(d), Value::Number(26.0));
    }

    #[test]
    fn no_recompute_on_same_value() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(5.0));
        let b = store.create_derived(move |get| get(a));
        assert_eq!(store.get(b), Value::Number(5.0));

        // Setting same value should be a no-op
        store.set(a, Value::Number(5.0));
        assert_eq!(store.get(b), Value::Number(5.0));
    }

    // === Step 5: Subscription tests ===

    #[test]
    fn sub_fires_on_set() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        store.sub(a, move || {
            *count_clone.borrow_mut() += 1;
        });

        store.set(a, Value::Number(2.0));
        assert_eq!(*count.borrow(), 1);

        store.set(a, Value::Number(3.0));
        assert_eq!(*count.borrow(), 2);
    }

    #[test]
    fn sub_does_not_fire_on_same_value() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(5.0));
        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        store.sub(a, move || {
            *count_clone.borrow_mut() += 1;
        });

        store.set(a, Value::Number(5.0)); // same value
        assert_eq!(*count.borrow(), 0);
    }

    #[test]
    fn unsub_stops_notifications() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        let sub_id = store.sub(a, move || {
            *count_clone.borrow_mut() += 1;
        });

        store.set(a, Value::Number(2.0));
        assert_eq!(*count.borrow(), 1);

        store.unsub(sub_id);
        store.set(a, Value::Number(3.0));
        assert_eq!(*count.borrow(), 1); // no more notifications
    }

    #[test]
    fn sub_on_derived_fires_on_upstream_change() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) {
                Value::Number(n * 2.0)
            } else {
                panic!()
            }
        });

        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        store.sub(b, move || {
            *count_clone.borrow_mut() += 1;
        });

        store.set(a, Value::Number(5.0));
        assert_eq!(*count.borrow(), 1);
        assert_eq!(store.get(b), Value::Number(10.0));
    }

    #[test]
    fn sub_on_derived_no_fire_if_value_unchanged() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        // derived always returns constant 42 regardless of a
        let b = store.create_derived(move |get| {
            let _ = get(a); // depend on a but ignore its value
            Value::Number(42.0)
        });

        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        store.sub(b, move || {
            *count_clone.borrow_mut() += 1;
        });

        store.set(a, Value::Number(999.0));
        // b still = 42, so listener should NOT fire
        assert_eq!(*count.borrow(), 0);
        assert_eq!(store.get(b), Value::Number(42.0));
    }

    #[test]
    fn multiple_subscribers() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(0.0));

        let c1 = Rc::new(RefCell::new(0u32));
        let c2 = Rc::new(RefCell::new(0u32));
        let c1c = c1.clone();
        let c2c = c2.clone();

        store.sub(a, move || *c1c.borrow_mut() += 1);
        store.sub(a, move || *c2c.borrow_mut() += 1);

        store.set(a, Value::Number(1.0));
        assert_eq!(*c1.borrow(), 1);
        assert_eq!(*c2.borrow(), 1);
    }

    // === Step 6: Cycle detection + dynamic dependencies ===

    #[test]
    #[should_panic(expected = "circular dependency")]
    fn self_referential_atom_panics() {
        let mut store = Store::new();
        // Create a placeholder atom first, then try to create a derived that reads itself
        let placeholder = store.create_atom(Value::Number(0.0));
        // This derived tries to read the atom that will be assigned id = placeholder.0 + 1
        let next_id = AtomId(placeholder.0 + 1);
        store.create_derived(move |get| get(next_id));
    }

    #[test]
    fn dynamic_deps_switch_branch() {
        let mut store = Store::new();
        let flag = store.create_atom(Value::Number(1.0));
        let a = store.create_atom(Value::Number(10.0));
        let b = store.create_atom(Value::Number(20.0));

        // Derived reads a when flag > 0, otherwise reads b
        let d = store.create_derived(move |get| {
            if let Value::Number(f) = get(flag) {
                if f > 0.0 {
                    get(a)
                } else {
                    get(b)
                }
            } else {
                panic!()
            }
        });

        // Initially flag=1 so d reads a=10
        assert_eq!(store.get(d), Value::Number(10.0));

        // Change a → d updates
        store.set(a, Value::Number(15.0));
        assert_eq!(store.get(d), Value::Number(15.0));

        // Change b → d should NOT update (it depends on a, not b)
        let count = Rc::new(RefCell::new(0u32));
        let count_clone = count.clone();
        store.sub(d, move || *count_clone.borrow_mut() += 1);

        store.set(b, Value::Number(99.0));
        assert_eq!(store.get(d), Value::Number(15.0));
        assert_eq!(*count.borrow(), 0); // d didn't change

        // Switch flag to 0 → d should now read b
        store.set(flag, Value::Number(0.0));
        assert_eq!(store.get(d), Value::Number(99.0));

        // Now change a → d should NOT update (depends on b now)
        store.set(a, Value::Number(999.0));
        assert_eq!(store.get(d), Value::Number(99.0));

        // Change b → d SHOULD update
        store.set(b, Value::Number(50.0));
        assert_eq!(store.get(d), Value::Number(50.0));
    }

    #[test]
    fn dynamic_deps_listener_tracks_correctly() {
        let mut store = Store::new();
        let flag = store.create_atom(Value::Number(1.0));
        let a = store.create_atom(Value::Number(10.0));
        let b = store.create_atom(Value::Number(20.0));

        let d = store.create_derived(move |get| {
            if let Value::Number(f) = get(flag) {
                if f > 0.0 { get(a) } else { get(b) }
            } else {
                panic!()
            }
        });

        let changes = Rc::new(RefCell::new(Vec::<String>::new()));
        let changes_clone = changes.clone();
        store.sub(d, move || changes_clone.borrow_mut().push("changed".into()));

        // Changing a triggers d (currently depends on a)
        store.set(a, Value::Number(11.0));
        assert_eq!(changes.borrow().len(), 1);

        // Switch to b branch
        store.set(flag, Value::Number(0.0));
        // d changed from 11 to 20
        assert_eq!(changes.borrow().len(), 2);

        // Now changing a should NOT trigger d
        store.set(a, Value::Number(999.0));
        assert_eq!(changes.borrow().len(), 2); // unchanged

        // Changing b SHOULD trigger d
        store.set(b, Value::Number(25.0));
        assert_eq!(changes.borrow().len(), 3);
    }

    // === Step 8: Batch updates ===

    #[test]
    fn batch_defers_propagation() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_atom(Value::Number(2.0));
        let sum = store.create_derived(move |get| {
            if let (Value::Number(x), Value::Number(y)) = (get(a), get(b)) {
                Value::Number(x + y)
            } else {
                panic!()
            }
        });

        let notify_count = Rc::new(RefCell::new(0u32));
        let nc = notify_count.clone();
        store.sub(sum, move || *nc.borrow_mut() += 1);

        // Without batch: 2 separate notifications
        // With batch: 1 notification at the end
        store.batch(|s| {
            s.set(a, Value::Number(10.0));
            s.set(b, Value::Number(20.0));
        });

        assert_eq!(store.get(sum), Value::Number(30.0));
        assert_eq!(*notify_count.borrow(), 1); // only 1 notification
    }

    #[test]
    fn batch_no_notification_if_no_change() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(5.0));
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        store.sub(a, move || *cc.borrow_mut() += 1);

        store.batch(|s| {
            s.set(a, Value::Number(5.0)); // same value, should be no-op
        });

        assert_eq!(*count.borrow(), 0);
    }

    #[test]
    fn batch_nested() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(0.0));
        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        store.sub(a, move || *cc.borrow_mut() += 1);

        store.batch(|s| {
            s.set(a, Value::Number(1.0));
            s.batch(|s2| {
                s2.set(a, Value::Number(2.0));
            });
            // Still inside outer batch, no notification yet
        });

        assert_eq!(store.get(a), Value::Number(2.0));
        assert_eq!(*count.borrow(), 1); // only 1 notification total
    }

    #[test]
    fn batch_multiple_derived_single_propagation() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) { Value::Number(n * 2.0) } else { panic!() }
        });
        let c = store.create_derived(move |get| {
            if let Value::Number(n) = get(a) { Value::Number(n + 10.0) } else { panic!() }
        });

        let b_count = Rc::new(RefCell::new(0u32));
        let c_count = Rc::new(RefCell::new(0u32));
        let bc = b_count.clone();
        let cc = c_count.clone();
        store.sub(b, move || *bc.borrow_mut() += 1);
        store.sub(c, move || *cc.borrow_mut() += 1);

        store.batch(|s| {
            s.set(a, Value::Number(5.0));
        });

        assert_eq!(store.get(b), Value::Number(10.0));
        assert_eq!(store.get(c), Value::Number(15.0));
        assert_eq!(*b_count.borrow(), 1);
        assert_eq!(*c_count.borrow(), 1);
    }

    // === Step 9: Writable atoms ===

    #[test]
    fn writable_atom_basic() {
        let mut store = Store::new();
        let celsius = store.create_atom(Value::Number(0.0));

        // Fahrenheit: reads celsius, writes back to celsius
        let fahrenheit = store.create_writable(
            move |get| {
                if let Value::Number(c) = get(celsius) {
                    Value::Number(c * 9.0 / 5.0 + 32.0)
                } else {
                    panic!()
                }
            },
            move |set, val| {
                if let Value::Number(f) = val {
                    set(celsius, Value::Number((f - 32.0) * 5.0 / 9.0));
                }
            },
        );

        // Read: 0°C = 32°F
        assert_eq!(store.get(fahrenheit), Value::Number(32.0));

        // Write 212°F → should set celsius to 100
        store.set(fahrenheit, Value::Number(212.0));
        assert_eq!(store.get(celsius), Value::Number(100.0));
        assert_eq!(store.get(fahrenheit), Value::Number(212.0));
    }

    #[test]
    fn writable_atom_triggers_subscribers() {
        let mut store = Store::new();
        let base = store.create_atom(Value::Number(10.0));
        let doubled = store.create_writable(
            move |get| {
                if let Value::Number(n) = get(base) {
                    Value::Number(n * 2.0)
                } else {
                    panic!()
                }
            },
            move |set, val| {
                if let Value::Number(n) = val {
                    set(base, Value::Number(n / 2.0));
                }
            },
        );

        let count = Rc::new(RefCell::new(0u32));
        let cc = count.clone();
        store.sub(doubled, move || *cc.borrow_mut() += 1);

        store.set(doubled, Value::Number(100.0));
        assert_eq!(store.get(base), Value::Number(50.0));
        assert_eq!(store.get(doubled), Value::Number(100.0));
        assert_eq!(*count.borrow(), 1);
    }

    #[test]
    fn writable_atom_sets_multiple_atoms() {
        let mut store = Store::new();
        let x = store.create_atom(Value::Number(0.0));
        let y = store.create_atom(Value::Number(0.0));

        // A writable atom that distributes a value to both x and y
        let both = store.create_writable(
            move |get| {
                if let (Value::Number(a), Value::Number(b)) = (get(x), get(y)) {
                    Value::Number(a + b)
                } else {
                    panic!()
                }
            },
            move |set, val| {
                if let Value::Number(n) = val {
                    set(x, Value::Number(n));
                    set(y, Value::Number(n));
                }
            },
        );

        store.set(both, Value::Number(5.0));
        assert_eq!(store.get(x), Value::Number(5.0));
        assert_eq!(store.get(y), Value::Number(5.0));
        assert_eq!(store.get(both), Value::Number(10.0)); // 5 + 5
    }

    #[test]
    #[should_panic(expected = "cannot set a read-only derived atom")]
    fn cannot_set_readonly_derived() {
        let mut store = Store::new();
        let a = store.create_atom(Value::Number(1.0));
        let b = store.create_derived(move |get| get(a));
        store.set(b, Value::Number(99.0));
    }
}
