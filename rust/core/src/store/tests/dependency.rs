use std::cell::RefCell;
use std::rc::Rc;

use super::super::*;
use crate::atom::{AtomId, Value};

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
    assert_eq!(store.get(c), Value::Number(3.0));

    store.set(a, Value::Number(5.0));
    assert_eq!(store.get(b), Value::Number(10.0));
    assert_eq!(store.get(c), Value::Number(11.0));
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
    let mut store = Store::new();
    let a = store.create_atom(Value::Number(1.0));
    let b = store.create_derived(move |get| {
        if let Value::Number(n) = get(a) {
            Value::Number(n * 2.0)
        } else {
            panic!()
        }
    });
    let c = store.create_derived(move |get| {
        if let Value::Number(n) = get(b) {
            Value::Number(n + 1.0)
        } else {
            panic!()
        }
    });
    let d = store.create_derived(move |get| {
        if let (Value::Number(va), Value::Number(vb), Value::Number(vc)) = (get(a), get(b), get(c))
        {
            Value::Number(va + vb + vc)
        } else {
            panic!()
        }
    });

    assert_eq!(store.get(d), Value::Number(6.0));

    store.set(a, Value::Number(5.0));
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

    store.set(a, Value::Number(5.0));
    assert_eq!(store.get(b), Value::Number(5.0));
}

#[test]
#[should_panic(expected = "circular dependency")]
fn self_referential_atom_panics() {
    let mut store = Store::new();
    let placeholder = store.create_atom(Value::Number(0.0));
    let next_id = AtomId(placeholder.0 + 1);
    store.create_derived(move |get| get(next_id));
}

#[test]
fn dynamic_deps_switch_branch() {
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

    assert_eq!(store.get(d), Value::Number(10.0));

    store.set(a, Value::Number(15.0));
    assert_eq!(store.get(d), Value::Number(15.0));

    let count = Rc::new(RefCell::new(0u32));
    let count_clone = count.clone();
    store.sub(d, move || *count_clone.borrow_mut() += 1);

    store.set(b, Value::Number(99.0));
    assert_eq!(store.get(d), Value::Number(15.0));
    assert_eq!(*count.borrow(), 0);

    store.set(flag, Value::Number(0.0));
    assert_eq!(store.get(d), Value::Number(99.0));

    store.set(a, Value::Number(999.0));
    assert_eq!(store.get(d), Value::Number(99.0));

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

    store.set(a, Value::Number(11.0));
    assert_eq!(changes.borrow().len(), 1);

    store.set(flag, Value::Number(0.0));
    assert_eq!(changes.borrow().len(), 2);

    store.set(a, Value::Number(999.0));
    assert_eq!(changes.borrow().len(), 2);

    store.set(b, Value::Number(25.0));
    assert_eq!(changes.borrow().len(), 3);
}
