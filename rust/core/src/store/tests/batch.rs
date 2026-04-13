use std::cell::RefCell;
use std::rc::Rc;

use super::super::*;
use crate::atom::Value;

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

    store.batch(|s| {
        s.set(a, Value::Number(10.0));
        s.set(b, Value::Number(20.0));
    });

    assert_eq!(store.get(sum), Value::Number(30.0));
    assert_eq!(*notify_count.borrow(), 1);
}

#[test]
fn batch_no_notification_if_no_change() {
    let mut store = Store::new();
    let a = store.create_atom(Value::Number(5.0));
    let count = Rc::new(RefCell::new(0u32));
    let cc = count.clone();
    store.sub(a, move || *cc.borrow_mut() += 1);

    store.batch(|s| {
        s.set(a, Value::Number(5.0));
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
    });

    assert_eq!(store.get(a), Value::Number(2.0));
    assert_eq!(*count.borrow(), 1);
}

#[test]
fn batch_multiple_derived_single_propagation() {
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
        if let Value::Number(n) = get(a) {
            Value::Number(n + 10.0)
        } else {
            panic!()
        }
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
