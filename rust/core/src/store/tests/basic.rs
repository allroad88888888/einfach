use super::super::*;
use crate::atom::{AtomId, Value};

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
