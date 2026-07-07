//! Faithful Rust port of `vanilla/core/src/store.ts` (299 lines, the owner's
//! hand-written atom store). Function-per-function isomorphism is INV-1 of
//! `rust/docs/ATOM_DELEGATION_REWRITE_PLAN.md`:
//!
//! | store.ts            | store.rs                    |
//! |---------------------|-----------------------------|
//! | `readAtom`          | `Inner::read_atom` (iterative frame loop) |
//! | `setAtom`           | `Store::set` → `set_atom`   |
//! | `writeAtomState`    | `Inner::write_atom_state`   |
//! | `setAtomState`      | `Inner::set_atom_state`     |
//! | `dependenciesChange`| `Inner::dependencies_change` (iterative) |
//! | `flushPending`      | `flush_pending`             |
//! | `publishAtom`       | `publish_atom`              |
//! | `subscribeAtom`     | `Store::sub`                |
//! | `clearDependencies` | commit-time dep diff in `commit_read` |
//! | `clear`             | `Store::clear` (incl. audit C-7 pending purge) |
//!
//! Permitted mechanical deviations (each also a ledger row in the WORKPLAN):
//! - DV-1: no Promise machinery — async branches of setAtom/setAtomState/
//!   dependenciesChange do not exist here (`Value` has no async variant).
//! - DV-2: `Object.is` reference snapshots become per-atom GENERATION
//!   counters. `generation` increments exactly when store.ts would replace
//!   the stored reference (a value-changing `setAtomState`), so
//!   `gen == snapshot` ⟹ `Object.is` would pass. The converse differs only
//!   under ABA, costing one spurious re-derive that equality-pruning absorbs.
//!   Additionally Rust `PartialEq` (with `Arc::ptr_eq`/NaN fast paths in
//!   `Value`) prunes strictly MORE than reference equality — fewer publishes
//!   for structurally-equal replacements, never fewer recomputations of
//!   changed values.
//! - DV-3: the recursive `readAtom` getter-pull and `dependenciesChange`
//!   walk are implemented with explicit work stacks plus a NeedsDep
//!   scratch-commit protocol (see `read_atom`), because 100k-deep formula
//!   chains overflow a 1 MB WASM stack. Semantics are unchanged: a faulted
//!   read discards its scratch (committed deps stay intact — preserving the
//!   store.ts:47-51 "cached value with no dep entry is unconditionally
//!   fresh" behavior), computes the missing deps bottom-up, then re-runs.
//!   Recompute counters bump ONLY on completed runs.
//! - DV-4: `settled-memo` — a global `write_seq` plus per-atom `settled_at`
//!   lets `dependencies_change` skip re-validating an atom that was already
//!   confirmed fresh at the current write sequence. Pure memoization of a
//!   deterministic check (no value can have moved in between); required to
//!   keep bulk writes into shared dependents O(N + E) instead of O(N·deps).
//! - Store-level cross-atom cycle detection panics (store.ts would
//!   stack-overflow; the excel engine detects cycles at the evaluator level
//!   and never lets the store see them). Self-reads return the cached/init
//!   value without an edge, exactly like store.ts:97-102.
//! - `batch()` is the explicit form of what a vanilla write-function body
//!   gets implicitly (sets deferred, one flush at the end); kept because
//!   the engine already uses it.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use crate::atom::{AtomId, Value};

/// Tracked/untracked read access handed to derived read functions.
/// `get` is store.ts's tracked `getter`; `peek` is `options.getter`
/// (the noWatch getter) / `getter.peek` — a full read with no edge recorded.
pub struct ReadArgs<'a> {
    inner: &'a Rc<RefCell<Inner>>,
    scratch: &'a RefCell<Scratch>,
}

impl ReadArgs<'_> {
    pub fn get(&self, id: AtomId) -> Value {
        read_dep(self.inner, self.scratch, id, true)
    }

    /// Untracked read (`noWatchGetter`): computes if needed, records no edge.
    pub fn peek(&self, id: AtomId) -> Value {
        read_dep(self.inner, self.scratch, id, false)
    }
}

/// Read/write access handed to writable-atom write functions
/// (store.ts `writeAtomState`'s `readAtom` + `setter` pair).
pub struct WriteArgs<'a> {
    store: &'a Store,
    self_id: AtomId,
}

impl WriteArgs<'_> {
    /// Untracked read (store.ts passes raw `readAtom` as the write getter).
    pub fn get(&self, id: AtomId) -> Value {
        read_atom(&self.store.inner, id)
    }

    /// store.ts `writeAtomState::setter`: writing the atom itself severs its
    /// dependencies and stores the value directly (selfSetDoesNotTriggerGetter
    /// contract); writing another atom recurses into its write path. Flushing
    /// is deferred to the outermost `set` — vanilla's `isSync` mechanics.
    pub fn set(&self, id: AtomId, value: Value) {
        if id == self.self_id {
            let mut inner = self.store.inner.borrow_mut();
            inner.sever_dependencies(id);
            inner.set_atom_state(id, value);
        } else {
            self.store.write_atom_state(id, value);
        }
    }

    /// Self-set without knowing your own id (vanilla write fns close over
    /// their own atom entity; a Rust write fn is built before its id exists).
    pub fn set_self(&self, value: Value) {
        self.set(self.self_id, value);
    }
}

type ReadFn = Rc<dyn Fn(&ReadArgs) -> Value>;
type WriteFn = Rc<dyn Fn(&WriteArgs, Value)>;

/// Trait-based subscription target (unchanged from the previous store — the
/// WASM crate's `JsCallbackListener` and `Fn()` closures both satisfy it).
pub trait CellListener: 'static {
    fn on_change(&self);
}

impl<F: Fn() + 'static> CellListener for F {
    fn on_change(&self) {
        self()
    }
}

type Listener = Rc<dyn CellListener>;

/// Unique identifier for a subscription.
#[derive(Clone, Copy, Hash, Eq, PartialEq, Debug)]
pub struct SubscriptionId(u64);

/// Insertion-ordered reverse-dependency set. JS `Set` iterates in insertion
/// order and store.ts's `dependenciesChange` visit order (hence recompute
/// counter determinism) depends on it; re-adding an existing member keeps its
/// original position, so commit-time dep diffs that leave an edge in place
/// preserve order exactly like `Set.add` of a present key.
#[derive(Default)]
struct BackDeps {
    by_seq: BTreeMap<u64, AtomId>,
    seq_of: HashMap<AtomId, u64>,
    next_seq: u64,
}

impl BackDeps {
    fn insert(&mut self, id: AtomId) {
        if self.seq_of.contains_key(&id) {
            return;
        }
        self.seq_of.insert(id, self.next_seq);
        self.by_seq.insert(self.next_seq, id);
        self.next_seq += 1;
    }
    fn remove(&mut self, id: AtomId) {
        if let Some(seq) = self.seq_of.remove(&id) {
            self.by_seq.remove(&seq);
        }
    }
    fn is_empty(&self) -> bool {
        self.by_seq.is_empty()
    }
    fn len(&self) -> usize {
        self.by_seq.len()
    }
    fn iter_ordered(&self) -> impl Iterator<Item = AtomId> + '_ {
        self.by_seq.values().copied()
    }
}

/// Insertion-ordered pending map. store.ts `pendingMap.set(atom, prev)`
/// updates the value of an existing key while keeping its position; drain
/// order is insertion order.
#[derive(Default)]
struct PendingQueue {
    order: Vec<AtomId>,
    entries: HashMap<AtomId, Option<Value>>,
}

impl PendingQueue {
    /// Vanilla quirk preserved: a repeated set OVERWRITES the recorded prev
    /// with the latest one (store.ts:217), so an a→b→a batch still publishes.
    fn upsert(&mut self, id: AtomId, prev: Option<Value>) {
        if self.entries.insert(id, prev).is_none() {
            self.order.push(id);
        }
    }
    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    fn drain_ordered(&mut self) -> Vec<(AtomId, Option<Value>)> {
        let order = std::mem::take(&mut self.order);
        let mut entries = std::mem::take(&mut self.entries);
        order
            .into_iter()
            .filter_map(|id| entries.remove(&id).map(|prev| (id, prev)))
            .collect()
    }
    fn clear(&mut self) {
        self.order.clear();
        self.entries.clear();
    }
}

struct AtomRecord {
    /// Current state. `None` = never read (store.ts: absent from
    /// `atomStateMap`).
    value: Option<Value>,
    /// DV-2 generation: bumped exactly when `value` is replaced.
    generation: u64,
    /// Initial value for primitive atoms (`atom.init`).
    init: Option<Value>,
    read_fn: Option<ReadFn>,
    write_fn: Option<WriteFn>,
    /// Committed dependency snapshots in read order: `(dep, dep_generation)`.
    /// `None` = no `dependenciesMap` entry — store.ts:47-51: such an atom
    /// with a cached value is unconditionally fresh.
    deps: Option<Vec<(AtomId, u64)>>,
    back_deps: BackDeps,
    /// True while this atom's read is on the frame stack (cycle guard and
    /// store.ts:97-102 self-read detection).
    computing: bool,
    /// Force-staleness flag (public `invalidate`, used by the engine's
    /// cycle-dissolve path from P4 on).
    stale: bool,
    /// DV-4 settled-memo stamp.
    settled_at: u64,
}

impl AtomRecord {
    fn new_primitive(init: Value) -> Self {
        AtomRecord {
            value: None,
            generation: 0,
            init: Some(init),
            read_fn: None,
            write_fn: None,
            deps: None,
            back_deps: BackDeps::default(),
            computing: false,
            stale: false,
            settled_at: 0,
        }
    }
    fn new_derived(read_fn: ReadFn, write_fn: Option<WriteFn>) -> Self {
        AtomRecord {
            value: None,
            generation: 0,
            init: None,
            read_fn: None,
            write_fn,
            deps: None,
            back_deps: BackDeps::default(),
            computing: false,
            stale: false,
            settled_at: 0,
        }
        .with_read(read_fn)
    }
    fn with_read(mut self, read_fn: ReadFn) -> Self {
        self.read_fn = Some(read_fn);
        self
    }
}

struct Scratch {
    /// Read-order `(dep, generation)` pairs recorded by the tracked getter.
    deps: Vec<(AtomId, u64)>,
    /// dep → index into `deps` — keeps per-get dedup O(1) so a large fan-in
    /// read (SUM over 100k members) stays linear (codex P1 review P2 #4).
    dep_index: HashMap<AtomId, usize>,
    /// Deps that must be computed before this read can complete (order kept,
    /// set-backed dedup).
    needed: Vec<AtomId>,
    needed_set: std::collections::HashSet<AtomId>,
    faulted: bool,
    self_id: AtomId,
}

impl Scratch {
    fn new(self_id: AtomId) -> Self {
        Scratch {
            deps: Vec::new(),
            dep_index: HashMap::new(),
            needed: Vec::new(),
            needed_set: std::collections::HashSet::new(),
            faulted: false,
            self_id,
        }
    }

    fn record_dep(&mut self, id: AtomId, gen: u64) {
        match self.dep_index.get(&id) {
            Some(&idx) => self.deps[idx].1 = gen,
            None => {
                self.dep_index.insert(id, self.deps.len());
                self.deps.push((id, gen));
            }
        }
    }

    fn record_needed(&mut self, id: AtomId) {
        if self.needed_set.insert(id) {
            self.needed.push(id);
        }
        self.faulted = true;
    }
}

struct Inner {
    /// Monotonic ids, no slot reuse — matches the previous store (and keeps
    /// stale AtomIds in pending/subscriptions from aliasing a new atom).
    records: HashMap<AtomId, AtomRecord>,
    next_id: u64,
    pending: PendingQueue,
    /// Write-side cycle guard (defensive divergence kept from the previous
    /// store: two writable atoms setting each other must panic, not abort
    /// the WASM instance via stack exhaustion).
    setting: Vec<AtomId>,
    /// DV-4: bumped on every value-changing `set_atom_state`.
    write_seq: u64,
    subscriptions: HashMap<AtomId, Vec<(SubscriptionId, Listener)>>,
    sub_index: HashMap<SubscriptionId, AtomId>,
    next_sub_id: u64,
    batch_depth: u32,
    /// Current native nesting of read-fn execution (DV-3 hybrid budget).
    read_depth: usize,
    /// Cumulative COMPLETED derived read-fn runs (faulted partials excluded).
    recompute_count: usize,
    /// Cumulative dependents visited by `dependencies_change` (the successor
    /// of the old engine's dirty-BFS visit counter).
    flush_visit_count: usize,
}

impl Inner {
    fn record(&self, id: AtomId) -> &AtomRecord {
        self.records
            .get(&id)
            .unwrap_or_else(|| panic!("atom {:?} not found in store", id))
    }
    fn record_mut(&mut self, id: AtomId) -> &mut AtomRecord {
        self.records
            .get_mut(&id)
            .unwrap_or_else(|| panic!("atom {:?} not found in store", id))
    }
    fn has(&self, id: AtomId) -> bool {
        self.records.contains_key(&id)
    }

    /// Shallow freshness — the literal translation of store.ts:47-62:
    /// present state + (no dep entry ⇒ fresh | every dep snapshot still
    /// current). Never recurses; consistency at rest is guaranteed by the
    /// eager flush, exactly as in vanilla.
    fn is_fresh(&self, id: AtomId) -> bool {
        let rec = self.record(id);
        if rec.value.is_none() || rec.stale {
            return false;
        }
        match &rec.deps {
            None => true,
            Some(deps) => deps
                .iter()
                .all(|(dep, gen)| self.has(*dep) && self.record(*dep).generation == *gen),
        }
    }

    /// store.ts `clearDependencies` — severs this atom's forward edges and
    /// the matching reverse edges. Used by the self-set branch and destroy;
    /// ordinary re-reads use the commit-time diff instead (same end state).
    fn sever_dependencies(&mut self, id: AtomId) {
        let old = self.record_mut(id).deps.take();
        if let Some(old) = old {
            for (dep, _) in old {
                if self.has(dep) {
                    self.record_mut(dep).back_deps.remove(id);
                }
            }
        }
    }

    /// store.ts `setAtomState` minus the Promise branch: PartialEq
    /// short-circuit, store, generation bump, pending entry with prev.
    /// Returns true when the value actually changed.
    fn set_atom_state(&mut self, id: AtomId, value: Value) -> bool {
        let rec = self.record(id);
        let prev = rec.value.clone();
        if let Some(prev_v) = &prev {
            if *prev_v == value {
                return false;
            }
        }
        let rec = self.record_mut(id);
        rec.value = Some(value);
        rec.generation += 1;
        self.write_seq += 1;
        self.pending.upsert(id, prev);
        true
    }
}

fn listeners_snapshot(inner: &Rc<RefCell<Inner>>, id: AtomId) -> Vec<Listener> {
    inner
        .borrow()
        .subscriptions
        .get(&id)
        .map(|subs| subs.iter().map(|(_, l)| l.clone()).collect())
        .unwrap_or_default()
}

/// store.ts `publishAtom` — snapshot the listener list, release all borrows,
/// dispatch. Listeners may synchronously re-enter the store (`set`, `sub`);
/// re-entrant sets land in `pending` and drain in the enclosing flush loop.
fn publish_atom(inner: &Rc<RefCell<Inner>>, id: AtomId) {
    for listener in listeners_snapshot(inner, id) {
        listener.on_change();
    }
}

/// The tracked/untracked dep read shared by `ReadArgs::get` / `peek`.
fn read_dep(inner: &Rc<RefCell<Inner>>, scratch: &RefCell<Scratch>, id: AtomId, track: bool) -> Value {
    let self_id = scratch.borrow().self_id;
    {
        let inner_ref = inner.borrow();
        if !inner_ref.has(id) {
            panic!("atom {:?} not found in store", id);
        }
        // store.ts:97-102 — reading yourself inside your own read fn returns
        // the cached state (or init) without registering an edge.
        if id == self_id {
            let rec = inner_ref.record(id);
            return rec
                .value
                .clone()
                .or_else(|| rec.init.clone())
                .expect("self-read of a derived atom before first commit");
        }
        if inner_ref.record(id).computing {
            panic!(
                "circular dependency detected: atom {:?} depends on atom {:?} which is being computed",
                self_id, id
            );
        }
        if inner_ref.is_fresh(id) {
            let rec = inner_ref.record(id);
            let value = rec.value.clone().expect("fresh atom has a value");
            let gen = rec.generation;
            drop(inner_ref);
            if track {
                scratch.borrow_mut().record_dep(id, gen);
            }
            return value;
        }
        // Primitive that was never read: seed from init in place (this is
        // vanilla's readAtom(dep) bottoming out on a primitive).
        if inner_ref.record(id).read_fn.is_none() {
            drop(inner_ref);
            let value = seed_primitive(inner, id);
            if track {
                let gen = inner.borrow().record(id).generation;
                scratch.borrow_mut().record_dep(id, gen);
            }
            return value;
        }
    }
    // Stale/uncomputed derived dep. Two DV-3 sub-paths:
    //
    // 1. Within the recursion budget, compute it inline via a nested
    //    read_atom — this is vanilla's recursive getter pull verbatim, and
    //    every read fn observes correctly-typed dep values. UI-tier atom
    //    graphs never nest deeper than this.
    // 2. Past the budget (deep formula chains), FAULT: record the needed dep
    //    and return a Value::Null placeholder. The current run's result and
    //    scratch are discarded; the frame loop computes the dep bottom-up
    //    (iteratively, native stack stays capped at the budget) and re-runs
    //    the faulting read. Read fns must therefore tolerate — not panic on —
    //    unexpected Null from the tracked getter; the engine's evaluator does
    //    so naturally, and the run's output is never committed.
    let depth = inner.borrow().read_depth;
    if depth < READ_RECURSION_BUDGET {
        let _depth_guard = ReadDepthGuard::enter(inner);
        let value = read_atom(inner, id);
        drop(_depth_guard);
        if track {
            let gen = inner.borrow().record(id).generation;
            scratch.borrow_mut().record_dep(id, gen);
        }
        return value;
    }
    scratch.borrow_mut().record_needed(id);
    Value::Null
}

/// RAII guard for the DV-3 nesting counter — a panicking read fn must not
/// leave `read_depth` elevated (that would silently push all future reads
/// onto the fault path).
struct ReadDepthGuard {
    inner: Rc<RefCell<Inner>>,
}

impl ReadDepthGuard {
    fn enter(inner: &Rc<RefCell<Inner>>) -> Self {
        inner.borrow_mut().read_depth += 1;
        ReadDepthGuard {
            inner: inner.clone(),
        }
    }
}

impl Drop for ReadDepthGuard {
    fn drop(&mut self) {
        self.inner.borrow_mut().read_depth -= 1;
    }
}

/// RAII guard for the per-atom `computing` flag — a panicking read fn must
/// not leave the flag set (false circular-dependency panics on later reads;
/// codex P1 review P2 #1, the old store's RecomputeGuard equivalent).
struct ComputingGuard {
    inner: Rc<RefCell<Inner>>,
    id: AtomId,
}

impl ComputingGuard {
    fn enter(inner: &Rc<RefCell<Inner>>, id: AtomId) -> Self {
        inner.borrow_mut().record_mut(id).computing = true;
        ComputingGuard {
            inner: inner.clone(),
            id,
        }
    }
}

impl Drop for ComputingGuard {
    fn drop(&mut self) {
        let mut inner = self.inner.borrow_mut();
        if inner.has(self.id) {
            inner.record_mut(self.id).computing = false;
        }
    }
}

/// RAII guard for the write-side cycle list (old store's SetGuard).
struct SettingGuard {
    inner: Rc<RefCell<Inner>>,
    id: AtomId,
}

impl SettingGuard {
    fn enter(inner: &Rc<RefCell<Inner>>, id: AtomId) -> Self {
        {
            let mut inner_mut = inner.borrow_mut();
            if inner_mut.setting.contains(&id) {
                panic!(
                    "write-side circular dependency detected: atom {:?} is already being set",
                    id
                );
            }
            inner_mut.setting.push(id);
        }
        SettingGuard {
            inner: inner.clone(),
            id,
        }
    }
}

impl Drop for SettingGuard {
    fn drop(&mut self) {
        self.inner.borrow_mut().setting.retain(|s| *s != self.id);
    }
}

/// RAII guard for `batch_depth` (old store's BatchGuard).
struct BatchGuard {
    inner: Rc<RefCell<Inner>>,
}

impl BatchGuard {
    fn enter(inner: &Rc<RefCell<Inner>>) -> Self {
        inner.borrow_mut().batch_depth += 1;
        BatchGuard {
            inner: inner.clone(),
        }
    }
}

impl Drop for BatchGuard {
    fn drop(&mut self) {
        self.inner.borrow_mut().batch_depth -= 1;
    }
}

/// Native-stack budget for the recursive half of the DV-3 hybrid: deep
/// enough that hand-written atom graphs always take the faithful recursive
/// path, shallow enough that a 1 MB WASM stack cannot overflow (≈1 KB per
/// nesting level).
const READ_RECURSION_BUDGET: usize = 256;

/// First read of a primitive: state ← init, pending entry seeded exactly like
/// vanilla's first `readAtom` (nextState = atom.init → setAtomState).
fn seed_primitive(inner: &Rc<RefCell<Inner>>, id: AtomId) -> Value {
    let mut inner_mut = inner.borrow_mut();
    let init = inner_mut
        .record(id)
        .init
        .clone()
        .expect("primitive atom has an init value");
    inner_mut.set_atom_state(id, init.clone());
    init
}

/// store.ts `readAtom`, iterative (DV-3). Returns the atom's fresh value.
fn read_atom(inner: &Rc<RefCell<Inner>>, root: AtomId) -> Value {
    // Fast paths that need no frame.
    {
        let inner_ref = inner.borrow();
        if !inner_ref.has(root) {
            panic!("atom {:?} not found in store", root);
        }
        if inner_ref.is_fresh(root) {
            return inner_ref.record(root).value.clone().expect("fresh value");
        }
        if inner_ref.record(root).read_fn.is_none() {
            drop(inner_ref);
            return seed_primitive(inner, root);
        }
    }

    let mut stack: Vec<AtomId> = vec![root];
    while let Some(&id) = stack.last() {
        // A parent's retry re-validates; anything fresh just pops.
        let (fresh, is_primitive) = {
            let inner_ref = inner.borrow();
            (inner_ref.is_fresh(id), inner_ref.record(id).read_fn.is_none())
        };
        if fresh {
            stack.pop();
            let mut inner_mut = inner.borrow_mut();
            let seq = inner_mut.write_seq;
            inner_mut.record_mut(id).settled_at = seq;
            continue;
        }
        if is_primitive {
            seed_primitive(inner, id);
            stack.pop();
            continue;
        }

        let read_fn = {
            let inner_ref = inner.borrow();
            inner_ref
                .record(id)
                .read_fn
                .clone()
                .expect("derived atom has read fn")
        };
        let computing_guard = ComputingGuard::enter(inner, id);
        let scratch = RefCell::new(Scratch::new(id));
        // No borrows held across the read fn — its getter re-borrows per call
        // and may fault. The guard clears `computing` even if the fn panics.
        let next_value = {
            let args = ReadArgs {
                inner,
                scratch: &scratch,
            };
            read_fn(&args)
        };
        drop(computing_guard);
        let Scratch {
            deps: new_deps,
            needed,
            faulted,
            ..
        } = scratch.into_inner();

        let mut inner_mut = inner.borrow_mut();
        if faulted {
            // Discard scratch entirely; committed deps stay intact (the
            // store.ts:47-51 trap this protocol exists to avoid). Compute
            // the missing deps first, then retry this frame.
            drop(inner_mut);
            for dep in needed.into_iter().rev() {
                stack.push(dep);
            }
            continue;
        }
        commit_read(&mut inner_mut, id, new_deps, next_value);
        stack.pop();
    }

    inner
        .borrow()
        .record(root)
        .value
        .clone()
        .expect("read_atom leaves the root computed")
}

/// Commit of a completed read: replace the dep set (diff-based so unchanged
/// edges keep their position in the dep's insertion-ordered back-set — the
/// exact end state of vanilla's clearDependencies + re-add), store the value
/// via `set_atom_state`, stamp settled, count the completed run.
fn commit_read(inner: &mut Inner, id: AtomId, new_deps: Vec<(AtomId, u64)>, value: Value) {
    let old_deps = inner.record_mut(id).deps.take().unwrap_or_default();
    // Set-backed diff keeps large fan-in commits linear (codex P1 review).
    let new_dep_set: std::collections::HashSet<AtomId> =
        new_deps.iter().map(|(d, _)| *d).collect();
    for (old_dep, _) in &old_deps {
        if !new_dep_set.contains(old_dep) && inner.has(*old_dep) {
            inner.record_mut(*old_dep).back_deps.remove(id);
        }
    }
    for (dep, _) in &new_deps {
        inner.record_mut(*dep).back_deps.insert(id);
    }
    // store.ts creates a dependenciesMap entry only when the getter ran at
    // least once; a zero-dep read stays entry-less and is cached forever.
    inner.record_mut(id).deps = if new_deps.is_empty() {
        None
    } else {
        Some(new_deps)
    };
    let rec = inner.record_mut(id);
    rec.stale = false;
    inner.set_atom_state(id, value);
    let seq = inner.write_seq;
    let rec = inner.record_mut(id);
    rec.settled_at = seq;
    inner.recompute_count += 1;
}

/// store.ts `dependenciesChange`, iterative pre-order DFS with change
/// pruning and the DV-4 settled-memo. Visits back-dependents in insertion
/// order; a dependent whose re-read leaves its value unchanged prunes its
/// subtree.
fn dependencies_change(inner: &Rc<RefCell<Inner>>, root: AtomId) {
    let mut stack: Vec<AtomId> = Vec::new();
    {
        let inner_ref = inner.borrow();
        if !inner_ref.has(root) {
            return;
        }
        for dep in inner_ref.record(root).back_deps.iter_ordered() {
            stack.push(dep);
        }
        // Preserve store.ts forEach order under LIFO processing.
        stack.reverse();
    }
    while let Some(id) = stack.pop() {
        {
            let mut inner_mut = inner.borrow_mut();
            if !inner_mut.has(id) {
                continue;
            }
            inner_mut.flush_visit_count += 1;
            let seq = inner_mut.write_seq;
            if inner_mut.record(id).settled_at == seq {
                continue; // DV-4: already confirmed at this write sequence
            }
        }
        let before_gen = inner.borrow().record(id).generation;
        let _ = read_atom(inner, id);
        let (after_gen, children): (u64, Vec<AtomId>) = {
            let inner_ref = inner.borrow();
            let rec = inner_ref.record(id);
            (rec.generation, rec.back_deps.iter_ordered().collect())
        };
        if after_gen == before_gen {
            continue; // Object.is prune — subtree not visited
        }
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
}

/// store.ts `flushPending`: drain in insertion order; for each drained entry
/// re-derive its dependents, then publish it if its post-flush state differs
/// from the recorded prev. Re-entrant sets from listeners land in `pending`
/// and are drained by the same while loop.
fn flush_pending(inner: &Rc<RefCell<Inner>>) {
    loop {
        let drained = {
            let mut inner_mut = inner.borrow_mut();
            if inner_mut.pending.is_empty() {
                return;
            }
            inner_mut.pending.drain_ordered()
        };
        for (id, prev) in drained {
            dependencies_change(inner, id);
            let changed = {
                let inner_ref = inner.borrow();
                if !inner_ref.has(id) {
                    false
                } else {
                    let current = &inner_ref.record(id).value;
                    match (current, &prev) {
                        (Some(c), Some(p)) => c != p,
                        (Some(_), None) => true,
                        (None, _) => false,
                    }
                }
            };
            if changed {
                publish_atom(inner, id);
            }
        }
    }
}

/// The central state container — a faithful port of the vanilla store.
/// All methods take `&self` (the TS store is a bundle of closures over
/// shared maps; `Rc<RefCell<Inner>>` is the Rust spelling of that), so
/// listeners holding a clone can synchronously re-enter, exactly like JS.
pub struct Store {
    inner: Rc<RefCell<Inner>>,
}

impl Clone for Store {
    fn clone(&self) -> Self {
        Store {
            inner: self.inner.clone(),
        }
    }
}

impl Store {
    pub fn new() -> Self {
        Store {
            inner: Rc::new(RefCell::new(Inner {
                records: HashMap::new(),
                next_id: 0,
                pending: PendingQueue::default(),
                setting: Vec::new(),
                write_seq: 0,
                subscriptions: HashMap::new(),
                sub_index: HashMap::new(),
                next_sub_id: 0,
                batch_depth: 0,
                read_depth: 0,
                recompute_count: 0,
                flush_visit_count: 0,
            })),
        }
    }

    fn alloc(&self, record: AtomRecord) -> AtomId {
        let mut inner = self.inner.borrow_mut();
        let id = AtomId::from_raw(inner.next_id);
        inner.next_id += 1;
        inner.records.insert(id, record);
        id
    }

    /// Create a primitive atom with an initial value (`atom(init)`).
    pub fn create_atom(&self, init: Value) -> AtomId {
        self.alloc(AtomRecord::new_primitive(init))
    }

    /// Create a read-only derived atom (`atom(read)`).
    ///
    /// BRIDGE(delete-by: P4-exit): unlike vanilla (lazy until first read),
    /// this legacy-signature API computes eagerly at creation because the
    /// current sheet engine's spill targets rely on the back-dep edge
    /// existing immediately (`has_dependents` guards anchor destruction).
    /// New code should use the vanilla-faithful `create_derived_ctx`.
    pub fn create_derived(
        &self,
        read_fn: impl Fn(&dyn Fn(AtomId) -> Value) -> Value + 'static,
    ) -> AtomId {
        let id = self.create_derived_ctx(move |args| read_fn(&|id| args.get(id)));
        let _ = read_atom(&self.inner, id);
        id
    }

    /// Full-context variant exposing the untracked `peek` (noWatch getter).
    /// LAZY like vanilla: nothing computes until the first read.
    pub fn create_derived_ctx(&self, read_fn: impl Fn(&ReadArgs) -> Value + 'static) -> AtomId {
        self.alloc(AtomRecord::new_derived(Rc::new(read_fn), None))
    }

    /// Create a writable derived atom (`atom(read, write)`).
    pub fn create_writable(
        &self,
        read_fn: impl Fn(&ReadArgs) -> Value + 'static,
        write_fn: impl Fn(&WriteArgs, Value) + 'static,
    ) -> AtomId {
        self.alloc(AtomRecord::new_derived(
            Rc::new(read_fn),
            Some(Rc::new(write_fn)),
        ))
    }

    /// Read the current value (store.ts `readAtom` via the public getter).
    /// Note the vanilla quirk kept on purpose: a bare read that (re)computes
    /// parks pending entries which publish on the NEXT flush; `sub` and every
    /// `set` flush, so this is unobservable through normal use.
    pub fn get(&self, id: AtomId) -> Value {
        read_atom(&self.inner, id)
    }

    /// store.ts `setAtom`: write, then flush (synchronously — no async
    /// values in this port).
    pub fn set(&self, id: AtomId, value: Value) {
        self.write_atom_state(id, value);
        if self.inner.borrow().batch_depth == 0 {
            flush_pending(&self.inner);
        }
    }

    /// store.ts `writeAtomState`: writable atoms delegate to their write fn
    /// (whose setter defers flushing — vanilla `isSync`); primitives assert
    /// and store directly.
    fn write_atom_state(&self, id: AtomId, value: Value) {
        let write_fn = {
            let inner = self.inner.borrow();
            if !inner.has(id) {
                panic!("atom {:?} not found in store", id);
            }
            inner.record(id).write_fn.clone()
        };
        if let Some(write_fn) = write_fn {
            // RAII: a panicking write fn must not leave the id in `setting`
            // (poisoned guard — codex P1 review P2 #2, old SetGuard).
            let _guard = SettingGuard::enter(&self.inner, id);
            let args = WriteArgs {
                store: self,
                self_id: id,
            };
            write_fn(&args, value);
            return;
        }
        {
            let inner = self.inner.borrow();
            assert!(
                inner.record(id).read_fn.is_none(),
                "cannot set a read-only derived atom"
            );
        }
        self.inner.borrow_mut().set_atom_state(id, value);
    }

    /// Execute several writes with one flush at the end — the explicit form
    /// of a vanilla write-fn body. Nested batches flush once at depth 0.
    /// The depth guard survives a panicking body (codex P1 review P2 #3,
    /// old BatchGuard) — otherwise every later `set` would defer forever.
    pub fn batch(&self, f: impl FnOnce(&Self)) {
        {
            let _guard = BatchGuard::enter(&self.inner);
            f(self);
        }
        if self.inner.borrow().batch_depth == 0 {
            flush_pending(&self.inner);
        }
    }

    /// Public flush for engine call sites that used bare reads.
    pub fn flush(&self) {
        flush_pending(&self.inner);
    }

    /// Force-mark a derived atom stale so its next read re-runs the read fn
    /// (engine cycle-dissolve). No-op on primitives and missing atoms.
    pub fn invalidate(&self, id: AtomId) {
        let mut inner = self.inner.borrow_mut();
        if inner.has(id) && inner.record(id).read_fn.is_some() {
            inner.record_mut(id).stale = true;
        }
    }

    /// Reverse-reachability over live back-dep edges: is any of `targets`
    /// reachable from `roots`? (Install-time cycle check for the engine.)
    pub fn reverse_reachable(&self, roots: &[AtomId], targets: &[AtomId]) -> bool {
        let inner = self.inner.borrow();
        let mut seen: Vec<AtomId> = Vec::new();
        let mut stack: Vec<AtomId> = roots.to_vec();
        while let Some(id) = stack.pop() {
            if targets.contains(&id) {
                return true;
            }
            if seen.contains(&id) || !inner.has(id) {
                continue;
            }
            seen.push(id);
            for dep in inner.record(id).back_deps.iter_ordered() {
                stack.push(dep);
            }
        }
        false
    }

    /// store.ts `subscribeAtom` via the public `sub` name (vanilla's store
    /// object exposes it as `sub` too).
    pub fn sub(&self, id: AtomId, listener: impl CellListener) -> SubscriptionId {
        self.subscribe_atom(id, Rc::new(listener))
    }

    /// Boxed variant for adapter layers (kept from the previous store).
    pub fn sub_boxed(&self, id: AtomId, listener: Box<dyn CellListener>) -> SubscriptionId {
        self.subscribe_atom(id, Rc::from(listener))
    }

    /// store.ts `subscribeAtom`: mount by reading, flush, then register.
    fn subscribe_atom(&self, id: AtomId, listener: Listener) -> SubscriptionId {
        let _ = read_atom(&self.inner, id);
        flush_pending(&self.inner);
        let mut inner = self.inner.borrow_mut();
        let sub_id = SubscriptionId(inner.next_sub_id);
        inner.next_sub_id += 1;
        inner
            .subscriptions
            .entry(id)
            .or_default()
            .push((sub_id, listener));
        inner.sub_index.insert(sub_id, id);
        sub_id
    }

    /// Remove a subscription. O(1) via the reverse index.
    pub fn unsub(&self, sub_id: SubscriptionId) {
        let mut inner = self.inner.borrow_mut();
        if let Some(atom_id) = inner.sub_index.remove(&sub_id) {
            if let Some(subs) = inner.subscriptions.get_mut(&atom_id) {
                subs.retain(|(id, _)| *id != sub_id);
                if subs.is_empty() {
                    inner.subscriptions.remove(&atom_id);
                }
            }
        }
    }

    pub fn has_atom(&self, id: AtomId) -> bool {
        self.inner.borrow().has(id)
    }

    /// Returns true if any other atom currently depends on `id`.
    pub fn has_dependents(&self, id: AtomId) -> bool {
        let inner = self.inner.borrow();
        inner.has(id) && !inner.record(id).back_deps.is_empty()
    }

    /// Destroy an atom and free all references to it. Panics if live
    /// downstream derived atoms remain (callers destroy dependents first).
    pub fn destroy_atom(&self, id: AtomId) {
        {
            let inner = self.inner.borrow();
            if !inner.has(id) {
                return;
            }
            if !inner.record(id).back_deps.is_empty() {
                panic!(
                    "cannot destroy atom {:?}: has {} live downstream derived atom(s)",
                    id,
                    inner.record(id).back_deps.len()
                );
            }
        }
        let mut inner = self.inner.borrow_mut();
        inner.sever_dependencies(id);
        if let Some(subs) = inner.subscriptions.remove(&id) {
            for (sub_id, _) in subs {
                inner.sub_index.remove(&sub_id);
            }
        }
        inner.records.remove(&id);
    }

    /// store.ts `clear()`: fresh maps AND a purged pendingMap (audit C-7 —
    /// old-world pending flushes must not leak into the new world).
    /// DIVERGENCE(store.ts): vanilla atoms are external objects that survive
    /// clear and re-materialize from `init` on next read; Rust atom
    /// definitions live in the store, so held AtomIds are dead after clear.
    /// The C-7 protective intent (no ghost flushes) is preserved and tested.
    pub fn clear(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.records.clear();
        inner.pending.clear();
        inner.setting.clear();
        inner.subscriptions.clear();
        inner.sub_index.clear();
        inner.write_seq = 0;
        inner.recompute_count = 0;
        inner.flush_visit_count = 0;
    }

    // === #[doc(hidden)] debug probes (closed-form fence counters) ===

    #[doc(hidden)]
    pub fn debug_total_atom_count(&self) -> usize {
        self.inner.borrow().records.len()
    }

    #[doc(hidden)]
    pub fn debug_derived_atom_count(&self) -> usize {
        let inner = self.inner.borrow();
        inner
            .records
            .values()
            .filter(|r| r.read_fn.is_some())
            .count()
    }

    #[doc(hidden)]
    pub fn debug_dependent_count(&self, id: AtomId) -> usize {
        let inner = self.inner.borrow();
        if inner.has(id) {
            inner.record(id).back_deps.len()
        } else {
            0
        }
    }

    /// Total committed dependency edges (successor of the engine's
    /// dep-graph stats).
    #[doc(hidden)]
    pub fn debug_dependency_edge_count(&self) -> usize {
        let inner = self.inner.borrow();
        inner
            .records
            .values()
            .map(|r| r.deps.as_ref().map_or(0, |d| d.len()))
            .sum()
    }

    /// Completed derived read-fn runs since creation (never counts faulted
    /// partials — the DV-3 counter rule).
    #[doc(hidden)]
    pub fn debug_recompute_count(&self) -> usize {
        self.inner.borrow().recompute_count
    }

    /// Dependents visited by `dependencies_change` (successor of the old
    /// dirty-BFS visit counter).
    #[doc(hidden)]
    pub fn debug_flush_visit_count(&self) -> usize {
        self.inner.borrow().flush_visit_count
    }
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}
