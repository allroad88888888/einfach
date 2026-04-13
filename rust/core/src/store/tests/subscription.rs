use std::cell::RefCell;
use std::rc::Rc;

use super::super::*;
use crate::atom::Value;

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

    store.set(a, Value::Number(5.0));
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
    assert_eq!(*count.borrow(), 1);
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
    let b = store.create_derived(move |get| {
        let _ = get(a);
        Value::Number(42.0)
    });

    let count = Rc::new(RefCell::new(0u32));
    let count_clone = count.clone();
    store.sub(b, move || {
        *count_clone.borrow_mut() += 1;
    });

    store.set(a, Value::Number(999.0));
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
