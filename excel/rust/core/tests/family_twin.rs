//! AtomFamily behavioral tests — the Rust twin of the owner's getAtomFamily
//! pattern (createFamilyAtomById/createCacheStom): keyed cache, lazy
//! creation (create fn runs at most once per key), explicit safe eviction.
//! Plus the leak fence: create/evict churn returns the store to baseline.

use std::cell::Cell;
use std::rc::Rc;

use einfach_core::{AtomFamily, Store, Value};

fn n(v: f64) -> Value {
    Value::Number(v)
}

#[test]
fn get_or_create_caches_per_key() {
    let store = Store::new();
    let mut family: AtomFamily<(u32, u32)> = AtomFamily::new();
    let creations = Rc::new(Cell::new(0u32));

    let c = creations.clone();
    let a1 = family.get_or_create((0, 0), || {
        c.set(c.get() + 1);
        store.create_atom(n(1.0))
    });
    let c = creations.clone();
    let a2 = family.get_or_create((0, 0), || {
        c.set(c.get() + 1);
        store.create_atom(n(2.0))
    });

    assert_eq!(a1, a2, "same key returns the same atom");
    assert_eq!(creations.get(), 1, "create runs at most once per key");
    assert_eq!(family.len(), 1);
    assert_eq!(family.key_of(a1), Some(&(0, 0)));
}

#[test]
fn lazy_creation_only_on_use() {
    let store = Store::new();
    let mut family: AtomFamily<u32> = AtomFamily::new();

    assert_eq!(store.debug_total_atom_count(), 0);
    assert!(family.get(&7).is_none());
    assert_eq!(store.debug_total_atom_count(), 0, "get() never creates");

    let id = family.get_or_create(7, || store.create_atom(n(7.0)));
    assert_eq!(store.debug_total_atom_count(), 1);
    assert_eq!(family.get(&7), Some(id));
}

#[test]
fn evict_destroys_and_returns_store_to_baseline() {
    let store = Store::new();
    let mut family: AtomFamily<u32> = AtomFamily::new();
    for i in 0..1000 {
        family.get_or_create(i, || store.create_atom(n(i as f64)));
    }
    assert_eq!(store.debug_total_atom_count(), 1000);

    for i in 0..1000 {
        assert!(family.evict(&store, &i));
    }
    assert_eq!(store.debug_total_atom_count(), 0, "no leaked atoms");
    assert!(family.is_empty());
}

#[test]
fn evict_refuses_while_dependents_exist() {
    let store = Store::new();
    let mut family: AtomFamily<u32> = AtomFamily::new();
    let base = family.get_or_create(1, || store.create_atom(n(5.0)));
    let derived = store.create_derived_ctx(move |args| args.get(base));
    let _ = store.get(derived);

    assert!(!family.evict(&store, &1), "live dependent blocks eviction");
    assert_eq!(family.len(), 1);
    assert_eq!(store.get(base).as_number(), Some(5.0));
}

#[test]
fn evict_refuses_while_subscribed() {
    let store = Store::new();
    let mut family: AtomFamily<u32> = AtomFamily::new();
    let id = family.get_or_create(1, || store.create_atom(n(0.0)));
    let sub = store.sub(id, || {});

    assert!(!family.evict(&store, &1), "live subscriber blocks eviction");

    store.unsub(sub);
    assert!(family.evict(&store, &1), "eviction proceeds after unsub");
    assert_eq!(store.debug_total_atom_count(), 0);
}

#[test]
fn detach_rekeys_without_destroying() {
    let store = Store::new();
    let mut family: AtomFamily<u32> = AtomFamily::new();
    let id = family.get_or_create(1, || store.create_atom(n(42.0)));

    let detached = family.detach(&1).expect("entry exists");
    assert_eq!(detached, id);
    assert!(store.has_atom(id), "detach keeps the atom alive");
    assert!(family.get(&1).is_none());

    family.attach(2, id);
    assert_eq!(family.get(&2), Some(id));
    assert_eq!(family.key_of(id), Some(&2));
}

/// The family works as the derive factory too — formula-cell shape preview:
/// per-key derived atoms reading per-key primitives, all lazy.
#[test]
fn family_of_derived_atoms() {
    let store = Store::new();
    let mut cells: AtomFamily<u32> = AtomFamily::new();
    let mut formulas: AtomFamily<u32> = AtomFamily::new();

    for i in 0..10 {
        cells.get_or_create(i, || store.create_atom(n(i as f64)));
    }
    let store_for_read = store.clone();
    let cell_5 = cells.get(&5).unwrap();
    let f = formulas.get_or_create(5, || {
        store_for_read
            .create_derived_ctx(move |args| n(args.get(cell_5).as_number().unwrap_or(0.0) * 10.0))
    });

    assert_eq!(store.get(f).as_number(), Some(50.0));
    store.set(cell_5, n(7.0));
    assert_eq!(store.get(f).as_number(), Some(70.0));
}
