use std::cell::RefCell;
use std::rc::Rc;

use super::super::*;
use crate::atom::Value;

#[test]
fn writable_atom_basic() {
    let mut store = Store::new();
    let celsius = store.create_atom(Value::Number(0.0));

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

    assert_eq!(store.get(fahrenheit), Value::Number(32.0));

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
    assert_eq!(store.get(both), Value::Number(10.0));
}

#[test]
#[should_panic(expected = "cannot set a read-only derived atom")]
fn cannot_set_readonly_derived() {
    let mut store = Store::new();
    let a = store.create_atom(Value::Number(1.0));
    let b = store.create_derived(move |get| get(a));
    store.set(b, Value::Number(99.0));
}
