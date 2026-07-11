//! AtomFamily — the Rust port of the owner's getAtomFamily pattern
//! (`vanilla/core/src/utils/createFamilyAtomById.ts` over `createCacheStom`):
//! a keyed cache of atoms, created on first use (lazy), evictable.
//!
//! This is the load-bearing primitive of the atom-delegation rewrite
//! (WORKPLAN §1.3): per-cell atoms come from a family keyed by
//! `(sheet, address)`, so bulk imports materialize nothing, writes touch one
//! atom, and formulas depend only on cells they actually read — the
//! empirically-verified corrective to the historical C-1/C-2 pathologies.
//!
//! Differences from the TS utils (documented, not accidental):
//! - Creation goes through a caller-supplied closure returning an `AtomId`
//!   (any Store create API composes — primitive, derived, writable, eager
//!   bridge), instead of an `AtomSpec` enum.
//! - No implicit LRU `maxSize`: in TS, cache eviction just drops the entry
//!   and GC reclaims unreferenced atom state. Rust atoms live in the Store,
//!   so eviction is explicit (`evict`) and REFUSES while the atom still has
//!   dependents or subscribers — the engine owns its lifecycle policy.

use std::collections::HashMap;
use std::hash::Hash;

use crate::atom::AtomId;
use crate::store::Store;

pub struct AtomFamily<K: Eq + Hash + Clone> {
    map: HashMap<K, AtomId>,
    rev: HashMap<AtomId, K>,
}

impl<K: Eq + Hash + Clone> AtomFamily<K> {
    pub fn new() -> Self {
        AtomFamily {
            map: HashMap::new(),
            rev: HashMap::new(),
        }
    }

    /// Non-creating lookup (`cache.has` + `cache.get` in createCacheStom).
    pub fn get(&self, key: &K) -> Option<AtomId> {
        self.map.get(key).copied()
    }

    /// The family call itself: return the cached atom or create it on first
    /// use. `create` runs at most once per key.
    pub fn get_or_create(&mut self, key: K, create: impl FnOnce() -> AtomId) -> AtomId {
        if let Some(&id) = self.map.get(&key) {
            return id;
        }
        let id = create();
        self.map.insert(key.clone(), id);
        self.rev.insert(id, key);
        id
    }

    /// Reverse lookup: which key owns this atom?
    pub fn key_of(&self, id: AtomId) -> Option<&K> {
        self.rev.get(&id)
    }

    /// Destroy the keyed atom and drop the entry. Refuses (returns false,
    /// nothing changes) while the atom still has downstream dependents or
    /// live subscribers — eviction must never strand a reader.
    pub fn evict(&mut self, store: &Store, key: &K) -> bool {
        let Some(&id) = self.map.get(key) else {
            return false;
        };
        if store.has_dependents(id) || store.has_subscribers(id) {
            return false;
        }
        store.destroy_atom(id);
        self.map.remove(key);
        self.rev.remove(&id);
        true
    }

    /// Drop the entry WITHOUT destroying the atom — for engine paths that
    /// re-key an atom (structural edits) and re-insert it under a new key.
    pub fn detach(&mut self, key: &K) -> Option<AtomId> {
        let id = self.map.remove(key)?;
        self.rev.remove(&id);
        Some(id)
    }

    /// Re-insert a detached atom under a new key (the other half of the
    /// structural-edit rekey). Panics if the key is already occupied by a
    /// different atom — silent aliasing would corrupt the reverse map.
    pub fn attach(&mut self, key: K, id: AtomId) {
        if let Some(&existing) = self.map.get(&key) {
            assert!(
                existing == id,
                "AtomFamily::attach: key already holds a different atom"
            );
            return;
        }
        self.map.insert(key.clone(), id);
        self.rev.insert(id, key);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, AtomId)> {
        self.map.iter().map(|(k, &id)| (k, id))
    }
}

impl<K: Eq + Hash + Clone> Default for AtomFamily<K> {
    fn default() -> Self {
        Self::new()
    }
}
