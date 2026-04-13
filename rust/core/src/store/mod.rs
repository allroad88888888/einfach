use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::atom::{AtomId, Value};

mod graph;
mod subscription;
mod write;

#[cfg(test)]
mod tests;

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
    /// derived atom -> set of atoms it depends on
    dependencies: HashMap<AtomId, HashSet<AtomId>>,
    /// atom -> set of derived atoms that depend on it
    back_deps: HashMap<AtomId, HashSet<AtomId>>,
    /// atom -> list of (sub_id, listener)
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

    /// Read the current value of an atom.
    pub fn get(&self, id: AtomId) -> Value {
        self.values
            .get(&id)
            .expect("atom not found in store")
            .clone()
    }
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}
