//! Twin tests — each test here is a port of a specific core/core jest test
//! (file + name cited above each), pinning INV-1 isomorphism behaviorally.
//! Adaptations required by the Rust surface are marked TWIN-ADAPT with the
//! reason; semantic divergences reference their DV-# ledger row in
//! `excel/rust/docs/ATOM_DELEGATION_REWRITE_PLAN.md` §5.
//!
//! Sources: store.test.ts, atom.test.ts, atom.complex.test.ts,
//! selfSetDoesNotTriggerGetter.test.ts, noWatchGetter.test.ts,
//! performance.test.ts. (asyncDependenciesChange / selectAtom* are DV-1
//! no-async and utils-layer — no twins.)

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use einfach_core::{Store, Value};

fn n(v: f64) -> Value {
    Value::Number(v)
}
fn t(v: &str) -> Value {
    Value::Text(v.to_string())
}
fn as_n(v: Value) -> f64 {
    v.as_number().expect("number value")
}
fn as_t(v: Value) -> String {
    v.as_text().expect("text value").to_string()
}

// ===== store.test.ts =====

/// store.test.ts «createStore: 应该创建一个新的store实例»
/// TWIN-ADAPT: vanilla shares one atom object across stores; Rust AtomIds are
/// store-scoped, so isolation is asserted with per-store atoms.
#[test]
fn create_store_instances_are_isolated() {
    let store1 = Store::new();
    let store2 = Store::new();
    let count1 = store1.create_atom(n(0.0));
    let count2 = store2.create_atom(n(0.0));

    store1.set(count1, n(1.0));
    assert_eq!(as_n(store1.get(count1)), 1.0);
    assert_eq!(as_n(store2.get(count2)), 0.0);
}

/// store.test.ts «store.getter: 应该获取atom的当前值»
#[test]
fn getter_returns_current_value() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    assert_eq!(as_n(store.get(count)), 0.0);
    store.set(count, n(1.0));
    assert_eq!(as_n(store.get(count)), 1.0);
}

/// store.test.ts «store.getter: 应该计算派生atom的值»
#[test]
fn getter_computes_derived_value() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let double = store.create_derived_ctx(move |args| n(as_n(args.get(count)) * 2.0));
    assert_eq!(as_n(store.get(double)), 0.0);
    store.set(count, n(5.0));
    assert_eq!(as_n(store.get(double)), 10.0);
}

/// store.test.ts «store.setter: 应该设置可写派生atom的值»
#[test]
fn setter_writes_through_writable_derived() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let double = store.create_writable(
        move |args| n(as_n(args.get(count)) * 2.0),
        move |args, value| {
            args.set(count, n(as_n(value) / 2.0));
        },
    );
    store.set(double, n(10.0));
    assert_eq!(as_n(store.get(count)), 5.0);
    assert_eq!(as_n(store.get(double)), 10.0);
}

/// store.test.ts «store.sub: 应该订阅atom值的变化» (+unsub half)
#[test]
fn sub_notifies_on_change_and_unsub_stops() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let calls = Rc::new(Cell::new(0u32));
    let c = calls.clone();
    let sub = store.sub(count, move || c.set(c.get() + 1));

    store.set(count, n(1.0));
    assert_eq!(calls.get(), 1);

    store.unsub(sub);
    store.set(count, n(2.0));
    assert_eq!(calls.get(), 1);
}

/// store.test.ts «store.sub: 应该订阅派生atom值的变化»
#[test]
fn sub_on_derived_notifies_on_dep_change() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let double = store.create_derived_ctx(move |args| n(as_n(args.get(count)) * 2.0));
    let calls = Rc::new(Cell::new(0u32));
    let c = calls.clone();
    let sub = store.sub(double, move || c.set(c.get() + 1));

    store.set(count, n(1.0));
    assert_eq!(calls.get(), 1);

    store.unsub(sub);
    store.set(count, n(2.0));
    assert_eq!(calls.get(), 1);
}

/// store.test.ts «clear() 丢弃旧世界的 pending 刷新（审计 C-7，防御性）»
/// TWIN-ADAPT: no async setters (DV-1); the old-world pending entry is parked
/// by a bare batched write instead, and DV clear() kills atom definitions
/// (see store.rs clear doc). The protective intent is identical: nothing
/// from before clear() may ghost-recompute or ghost-publish after it.
#[test]
fn clear_discards_old_world_pending() {
    let store = Store::new();
    let base = store.create_atom(n(0.0));
    let derives = Rc::new(Cell::new(0u32));
    let d = derives.clone();
    let derived = store.create_derived_ctx(move |args| {
        d.set(d.get() + 1);
        n(as_n(args.get(base)) + 1.0)
    });
    let _ = store.get(derived);
    let baseline = derives.get();

    // Park a pending entry without flushing (batch body defers the flush),
    // then clear mid-batch: the entry must not leak into the new world.
    store.batch(|s| {
        s.set(base, n(1.0));
        s.clear();
    });
    store.flush();

    assert_eq!(derives.get(), baseline, "old-world entry ghost-recomputed");
    // New world works from scratch.
    let base2 = store.create_atom(n(0.0));
    assert_eq!(as_n(store.get(base2)), 0.0);
}

// ===== atom.test.ts =====

/// atom.test.ts «基本功能» (init / update / complex value)
#[test]
fn primitive_atom_basics() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    assert_eq!(as_n(store.get(count)), 0.0);
    store.set(count, n(1.0));
    assert_eq!(as_n(store.get(count)), 1.0);

    let user = store.create_atom(t("John:30"));
    assert_eq!(as_t(store.get(user)), "John:30");
    store.set(user, t("Jane:25"));
    assert_eq!(as_t(store.get(user)), "Jane:25");
}

/// atom.test.ts «派生atom: …再派生一个» + «嵌套的派生atom»
#[test]
fn derived_of_derived() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let double = store.create_derived_ctx(move |args| n(as_n(args.get(count)) * 2.0));
    let triple = store.create_derived_ctx(move |args| n(as_n(args.get(double)) * 3.0));
    assert_eq!(as_n(store.get(triple)), 0.0);
    store.set(count, n(5.0));
    assert_eq!(as_n(store.get(triple)), 30.0);
    assert_eq!(as_n(store.get(double)), 10.0);
}

/// atom.test.ts «应该支持多个依赖的派生atom»
#[test]
fn derived_with_multiple_deps() {
    let store = Store::new();
    let first = store.create_atom(t("John"));
    let last = store.create_atom(t("Doe"));
    let full = store.create_derived_ctx(move |args| {
        t(&format!(
            "{} {}",
            as_t(args.get(first)),
            as_t(args.get(last))
        ))
    });
    assert_eq!(as_t(store.get(full)), "John Doe");
    store.set(first, t("Jane"));
    assert_eq!(as_t(store.get(full)), "Jane Doe");
    store.set(last, t("Smith"));
    assert_eq!(as_t(store.get(full)), "Jane Smith");
}

/// atom.test.ts «订阅: 应该在atom值变化时通知订阅者» (two changes then unsub)
#[test]
fn sub_counts_two_changes_then_unsub() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let calls = Rc::new(Cell::new(0u32));
    let c = calls.clone();
    let sub = store.sub(count, move || c.set(c.get() + 1));

    store.set(count, n(1.0));
    assert_eq!(calls.get(), 1);
    store.set(count, n(2.0));
    assert_eq!(calls.get(), 2);

    store.unsub(sub);
    store.set(count, n(3.0));
    assert_eq!(calls.get(), 2);
}

/// atom.test.ts «在订阅回调中更新其他atom时，派生atom应该正常更新»
/// Pins flushPending re-entrancy: a listener that synchronously sets another
/// atom must leave every atom consistent and fire each listener exactly once
/// per change.
#[test]
fn listener_setting_other_atom_keeps_world_consistent() {
    let store = Store::new();
    let count = store.create_atom(n(0.0));
    let double = store.create_derived_ctx(move |args| n(as_n(args.get(count)) * 2.0));
    let triple = store.create_derived_ctx(move |args| n(as_n(args.get(count)) * 3.0));
    let secondary = store.create_atom(n(10.0));

    let secondary_calls = Rc::new(Cell::new(0u32));
    let sc = secondary_calls.clone();
    let secondary_sub = store.sub(secondary, move || sc.set(sc.get() + 1));

    let count_calls = Rc::new(Cell::new(0u32));
    let cc = count_calls.clone();
    let reentrant = store.clone();
    let count_sub = store.sub(count, move || {
        cc.set(cc.get() + 1);
        let current = as_n(reentrant.get(count));
        reentrant.set(secondary, n(current + 5.0));
    });

    assert_eq!(as_n(store.get(count)), 0.0);
    assert_eq!(as_n(store.get(double)), 0.0);
    assert_eq!(as_n(store.get(triple)), 0.0);
    assert_eq!(as_n(store.get(secondary)), 10.0);
    assert_eq!(count_calls.get(), 0);
    assert_eq!(secondary_calls.get(), 0);

    store.set(count, n(3.0));
    assert_eq!(as_n(store.get(count)), 3.0);
    assert_eq!(as_n(store.get(double)), 6.0);
    assert_eq!(as_n(store.get(triple)), 9.0);
    assert_eq!(as_n(store.get(secondary)), 8.0);
    assert_eq!(count_calls.get(), 1);
    assert_eq!(secondary_calls.get(), 1);

    store.set(count, n(7.0));
    assert_eq!(as_n(store.get(double)), 14.0);
    assert_eq!(as_n(store.get(triple)), 21.0);
    assert_eq!(as_n(store.get(secondary)), 12.0);
    assert_eq!(count_calls.get(), 2);
    assert_eq!(secondary_calls.get(), 2);

    store.unsub(count_sub);
    store.set(count, n(10.0));
    assert_eq!(as_n(store.get(double)), 20.0);
    assert_eq!(as_n(store.get(triple)), 30.0);
    assert_eq!(as_n(store.get(secondary)), 12.0);
    assert_eq!(count_calls.get(), 2);
    assert_eq!(secondary_calls.get(), 2);

    store.unsub(secondary_sub);
}

/// atom.test.ts «在订阅回调中更新派生atom的依赖时，派生atom应该正常更新»
#[test]
fn listener_setting_dep_updates_derived_once() {
    let store = Store::new();
    let base = store.create_atom(n(1.0));
    let derived = store.create_derived_ctx(move |args| n(as_n(args.get(base)) * 10.0));
    let control = store.create_atom(n(0.0));

    let base_calls = Rc::new(Cell::new(0u32));
    let derived_calls = Rc::new(Cell::new(0u32));
    let control_calls = Rc::new(Cell::new(0u32));
    let bc = base_calls.clone();
    let dc = derived_calls.clone();
    let xc = control_calls.clone();

    let base_sub = store.sub(base, move || bc.set(bc.get() + 1));
    let derived_sub = store.sub(derived, move || dc.set(dc.get() + 1));
    let reentrant = store.clone();
    let control_sub = store.sub(control, move || {
        xc.set(xc.get() + 1);
        let current = as_n(reentrant.get(control));
        reentrant.set(base, n(current * 2.0));
    });

    assert_eq!(as_n(store.get(derived)), 10.0);

    store.set(control, n(5.0));
    assert_eq!(as_n(store.get(control)), 5.0);
    assert_eq!(as_n(store.get(base)), 10.0);
    assert_eq!(as_n(store.get(derived)), 100.0);
    assert_eq!(control_calls.get(), 1);
    assert_eq!(base_calls.get(), 1);
    assert_eq!(derived_calls.get(), 1);

    store.unsub(control_sub);
    store.set(control, n(8.0));
    assert_eq!(as_n(store.get(base)), 10.0);
    assert_eq!(as_n(store.get(derived)), 100.0);
    assert_eq!(control_calls.get(), 1);
    assert_eq!(base_calls.get(), 1);
    assert_eq!(derived_calls.get(), 1);

    store.unsub(base_sub);
    store.unsub(derived_sub);
}

// ===== atom.complex.test.ts =====

/// atom.complex.test.ts «应该正确处理复杂的依赖网络» (exact closed-form values)
#[test]
fn complex_dependency_network() {
    let store = Store::new();
    let a = store.create_atom(n(1.0));
    let b = store.create_atom(n(2.0));
    let c = store.create_atom(n(3.0));

    let ab_sum = store.create_derived_ctx(move |args| n(as_n(args.get(a)) + as_n(args.get(b))));
    let bc_product = store.create_derived_ctx(move |args| n(as_n(args.get(b)) * as_n(args.get(c))));
    let complex = store.create_derived_ctx(move |args| {
        n(as_n(args.get(ab_sum)) * as_n(args.get(bc_product)) - as_n(args.get(a)))
    });

    assert_eq!(as_n(store.get(ab_sum)), 3.0);
    assert_eq!(as_n(store.get(bc_product)), 6.0);
    assert_eq!(as_n(store.get(complex)), 17.0);

    store.set(a, n(4.0));
    assert_eq!(as_n(store.get(ab_sum)), 6.0);
    assert_eq!(as_n(store.get(bc_product)), 6.0);
    assert_eq!(as_n(store.get(complex)), 32.0);

    store.set(b, n(5.0));
    assert_eq!(as_n(store.get(ab_sum)), 9.0);
    assert_eq!(as_n(store.get(bc_product)), 15.0);
    assert_eq!(as_n(store.get(complex)), 131.0);

    store.set(c, n(6.0));
    assert_eq!(as_n(store.get(ab_sum)), 9.0);
    assert_eq!(as_n(store.get(bc_product)), 30.0);
    assert_eq!(as_n(store.get(complex)), 266.0);
}

/// atom.complex.test.ts «应该处理基于条件的动态依赖» — the full branch-switch
/// choreography, pinning clearDependencies-per-re-read (via commit diff).
#[test]
fn dynamic_deps_switch_branch() {
    let store = Store::new();
    let condition = store.create_atom(Value::Boolean(true));
    let a = store.create_atom(n(5.0));
    let b = store.create_atom(n(10.0));

    let dynamic = store.create_derived_ctx(move |args| {
        if args.get(condition).as_bool().unwrap_or(false) {
            args.get(a)
        } else {
            args.get(b)
        }
    });

    assert_eq!(as_n(store.get(dynamic)), 5.0);

    store.set(condition, Value::Boolean(false));
    assert_eq!(as_n(store.get(dynamic)), 10.0);

    store.set(b, n(20.0));
    assert_eq!(as_n(store.get(dynamic)), 20.0);

    store.set(condition, Value::Boolean(true));
    assert_eq!(as_n(store.get(dynamic)), 5.0);

    store.set(a, n(15.0));
    assert_eq!(as_n(store.get(dynamic)), 15.0);
}

/// atom.complex.test.ts «具有多层写入的可写派生atom»
/// TWIN-ADAPT: name split by ASCII '-' instead of CJK slicing.
#[test]
fn multi_layer_writable_writes() {
    let store = Store::new();
    let first = store.create_atom(t("Zhang"));
    let last = store.create_atom(t("San"));

    let full = store.create_writable(
        move |args| {
            t(&format!(
                "{}-{}",
                as_t(args.get(first)),
                as_t(args.get(last))
            ))
        },
        move |args, value| {
            let s = as_t(value);
            let (f, l) = s.split_once('-').expect("name has one dash");
            args.set(first, t(f));
            args.set(last, t(l));
        },
    );
    let greeting = store.create_writable(
        move |args| t(&format!("Hello, {}!", as_t(args.get(full)))),
        move |args, value| {
            let s = as_t(value);
            let name = s
                .strip_prefix("Hello, ")
                .and_then(|r| r.strip_suffix('!'))
                .expect("greeting shape");
            args.set(full, t(name));
        },
    );

    assert_eq!(as_t(store.get(full)), "Zhang-San");
    assert_eq!(as_t(store.get(greeting)), "Hello, Zhang-San!");

    store.set(full, t("Li-Si"));
    assert_eq!(as_t(store.get(first)), "Li");
    assert_eq!(as_t(store.get(last)), "Si");
    assert_eq!(as_t(store.get(greeting)), "Hello, Li-Si!");

    store.set(greeting, t("Hello, Wang-Wu!"));
    assert_eq!(as_t(store.get(first)), "Wang");
    assert_eq!(as_t(store.get(last)), "Wu");
    assert_eq!(as_t(store.get(full)), "Wang-Wu");
    assert_eq!(as_t(store.get(greeting)), "Hello, Wang-Wu!");
}

/// atom.complex.test.ts «带有副作用的写入操作» — write fn reads via
/// WriteArgs::get (store.ts passes raw readAtom as the write getter).
#[test]
fn write_with_side_effects() {
    let store = Store::new();
    let counter = store.create_atom(n(0.0));
    let log: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));

    let log_for_write = log.clone();
    let logging = store.create_writable(
        move |args| args.get(counter),
        move |args, value| {
            let prev = as_n(args.get(counter));
            let next = as_n(value);
            log_for_write
                .borrow_mut()
                .push(format!("Counter changed: {} -> {}", prev, next));
            args.set(counter, n(next));
        },
    );

    assert_eq!(as_n(store.get(logging)), 0.0);
    assert_eq!(log.borrow().len(), 0);

    store.set(logging, n(5.0));
    assert_eq!(as_n(store.get(logging)), 5.0);
    assert_eq!(log.borrow().as_slice(), ["Counter changed: 0 -> 5"]);

    store.set(logging, n(8.0));
    assert_eq!(as_n(store.get(logging)), 8.0);
    assert_eq!(
        log.borrow().as_slice(),
        ["Counter changed: 0 -> 5", "Counter changed: 5 -> 8"]
    );
}

/// atom.complex.test.ts «应该只在值真正改变时通知订阅者»
/// DV-2 ADAPT: vanilla uses Object.is (reference identity) so a structurally
/// equal but fresh object notifies; Rust PartialEq prunes it. Asserted here
/// as the documented divergence: structural-equal replacement → NO notify;
/// genuine change → notify.
#[test]
fn notify_only_on_real_change_partial_eq() {
    let store = Store::new();
    let data = store.create_atom(t("count:0"));
    let calls = Rc::new(Cell::new(0u32));
    let c = calls.clone();
    store.sub(data, move || c.set(c.get() + 1));

    // Structurally equal replacement — vanilla would notify (new reference),
    // PartialEq prunes (DV-2: strictly fewer publishes, never staleness).
    store.set(data, t("count:0"));
    assert_eq!(calls.get(), 0);

    store.set(data, t("count:1"));
    assert_eq!(calls.get(), 1);

    store.set(data, t("count:1"));
    assert_eq!(calls.get(), 1);
}

/// atom.complex.test.ts «间接依赖更新时的选择性通知»
#[test]
fn selective_notification_on_indirect_deps() {
    let store = Store::new();
    let a = store.create_atom(n(1.0));
    let b = store.create_atom(n(2.0));

    let derived_a = store.create_derived_ctx(move |args| n(as_n(args.get(a)) * 2.0));
    let derived_ab = store.create_derived_ctx(move |args| n(as_n(args.get(a)) + as_n(args.get(b))));

    let calls_a = Rc::new(Cell::new(0u32));
    let calls_ab = Rc::new(Cell::new(0u32));
    let ca = calls_a.clone();
    let cab = calls_ab.clone();
    store.sub(derived_a, move || ca.set(ca.get() + 1));
    store.sub(derived_ab, move || cab.set(cab.get() + 1));

    store.set(a, n(3.0));
    assert_eq!(calls_a.get(), 1);
    assert_eq!(calls_ab.get(), 1);

    store.set(b, n(4.0));
    assert_eq!(calls_a.get(), 1);
    assert_eq!(calls_ab.get(), 2);
}

/// atom.complex.test.ts «应该缓存计算结果直到依赖变化»
#[test]
fn caches_until_dep_change() {
    let store = Store::new();
    let count = store.create_atom(n(1.0));
    let computes = Rc::new(Cell::new(0u32));
    let k = computes.clone();
    let expensive = store.create_derived_ctx(move |args| {
        k.set(k.get() + 1);
        n(as_n(args.get(count)) * 10.0)
    });

    assert_eq!(as_n(store.get(expensive)), 10.0);
    assert_eq!(computes.get(), 1);

    assert_eq!(as_n(store.get(expensive)), 10.0);
    assert_eq!(computes.get(), 1);

    store.set(count, n(2.0));
    assert_eq!(as_n(store.get(expensive)), 20.0);
    assert_eq!(computes.get(), 2);

    for _ in 0..5 {
        assert_eq!(as_n(store.get(expensive)), 20.0);
    }
    assert_eq!(computes.get(), 2);
}

// ===== selfSetDoesNotTriggerGetter.test.ts =====

/// «self-set 断开依赖并在依赖变更后保持设置值» — including the value
/// changing TYPE (number → text), which the Value enum expresses directly.
#[test]
fn self_set_severs_deps_and_persists() {
    let store = Store::new();
    let base = store.create_atom(n(0.0));
    let derived = store.create_writable(
        move |args| args.get(base),
        |args, value| {
            args.set_self(value);
        },
    );

    assert_eq!(as_n(store.get(derived)), 0.0);

    store.set(derived, t("persisted"));
    store.set(base, n(123.0));

    assert_eq!(as_t(store.get(derived)), "persisted");
}

// ===== noWatchGetter.test.ts =====

/// «监听atom的变化» (tracked baseline)
#[test]
fn tracked_getter_follows_changes() {
    let store = Store::new();
    let a = store.create_atom(n(0.0));
    let b = store.create_derived_ctx(move |args| n(as_n(args.get(a)) + 1.0));
    store.set(a, n(10.0));
    assert_eq!(as_n(store.get(b)), 11.0);
}

/// «不监听atom的变化»
#[test]
fn peek_does_not_track() {
    let store = Store::new();
    let a = store.create_atom(n(0.0));
    let b = store.create_derived_ctx(move |args| n(as_n(args.peek(a)) + 1.0));
    assert_eq!(as_n(store.get(b)), 1.0);
    store.set(a, n(10.0));
    assert_eq!(as_n(store.get(b)), 1.0);
}

/// «不监听atom的变化-再嵌套一层»
#[test]
fn peek_of_tracked_derived_does_not_track() {
    let store = Store::new();
    let a = store.create_atom(n(0.0));
    let b = store.create_derived_ctx(move |args| n(as_n(args.get(a)) + 1.0));
    let c = store.create_derived_ctx(move |args| n(as_n(args.peek(b)) + 1.0));
    assert_eq!(as_n(store.get(c)), 2.0);
    store.set(a, n(10.0));
    assert_eq!(as_n(store.get(c)), 2.0);
}

/// «不监听atom的变化-再嵌套一层-再设置一次»
#[test]
fn peek_nested_with_extra_dep_set() {
    let store = Store::new();
    let a = store.create_atom(n(0.0));
    let aa = store.create_atom(n(3.0));
    let b = store.create_derived_ctx(move |args| {
        let _ = args.get(aa);
        n(as_n(args.get(a)) + 1.0)
    });
    let c = store.create_derived_ctx(move |args| n(as_n(args.peek(b)) + 1.0));
    assert_eq!(as_n(store.get(c)), 2.0);
    store.set(a, n(10.0));
    store.set(aa, n(10.0));
    assert_eq!(as_n(store.get(c)), 2.0);
}

// ===== performance.test.ts =====

/// «应该高效处理大量atom的更新» — the semantic core: a writable atom whose
/// write fn sets 1000 primitives produces exactly ONE notification for a
/// downstream merged derived (renderCount == 1), with all values updated
/// atomically. (selectAtom indirection is utils-layer; merged derive reads
/// the primitives directly.)
#[test]
fn batched_write_of_1000_atoms_publishes_merged_derive_once() {
    let store = Store::new();
    let options: Vec<_> = (0..1000).map(|i| store.create_atom(n(i as f64))).collect();

    let options_for_merge = options.clone();
    let merged = store.create_derived_ctx(move |args| {
        let sum: f64 = options_for_merge.iter().map(|&o| as_n(args.get(o))).sum();
        n(sum)
    });
    let initial: f64 = (0..1000).map(|i| i as f64).sum();
    assert_eq!(as_n(store.get(merged)), initial);

    let render_count = Rc::new(Cell::new(0u32));
    let rc = render_count.clone();
    store.sub(merged, move || rc.set(rc.get() + 1));

    let options_for_write = options.clone();
    let update_all = store.create_writable(
        |_args| n(0.0),
        move |args, _value| {
            for (i, &o) in options_for_write.iter().enumerate() {
                args.set(o, n((i + 1000) as f64));
            }
        },
    );

    store.set(update_all, n(1.0));

    let updated: f64 = (0..1000).map(|i| (i + 1000) as f64).sum();
    assert_eq!(as_n(store.get(merged)), updated);
    assert_eq!(render_count.get(), 1, "batched write must publish once");
    assert_eq!(as_n(store.get(options[0])), 1000.0);
    assert_eq!(as_n(store.get(options[999])), 1999.0);
}

// ===== New core fences (WORKPLAN P1: deep chains + settled-memo) =====

/// Chain links use `unwrap_or(0.0)` because chains deeper than the DV-3
/// recursion budget cross the FAULT path, where the tracked getter may hand
/// a to-be-computed dep back as Value::Null (the run is discarded and
/// re-executed) — the documented deep-chain read-fn contract.
fn build_chain(store: &Store, depth: usize) -> (einfach_core::AtomId, einfach_core::AtomId) {
    let head = store.create_atom(n(0.0));
    let mut prev = head;
    for _ in 0..depth {
        let link = store
            .create_derived_ctx(move |args| n(args.get(prev).as_number().unwrap_or(0.0) + 1.0));
        prev = link;
    }
    (head, prev)
}

/// Cold pull of a 100k-deep chain must not overflow the stack (DV-3 NeedsDep
/// frame loop) and must complete each link exactly once.
#[test]
fn chain_100k_cold_read_is_iterative_and_linear() {
    let store = Store::new();
    let depth = 100_000;
    let (_, tail) = build_chain(&store, depth);

    let before = store.debug_recompute_count();
    assert_eq!(as_n(store.get(tail)), depth as f64);
    let evals = store.debug_recompute_count() - before;
    assert_eq!(evals, depth, "each link completes exactly once");

    // Re-read: fully cached.
    let before = store.debug_recompute_count();
    assert_eq!(as_n(store.get(tail)), depth as f64);
    assert_eq!(store.debug_recompute_count() - before, 0);
}

/// Head write into a fully-hydrated 100k chain: iterative
/// dependencies_change, one recompute per link, one visit per link.
#[test]
fn chain_100k_head_write_flush_is_iterative_and_linear() {
    let store = Store::new();
    let depth = 100_000;
    let (head, tail) = build_chain(&store, depth);
    let _ = store.get(tail);
    store.flush();

    let evals_before = store.debug_recompute_count();
    let visits_before = store.debug_flush_visit_count();
    store.set(head, n(1.0));
    assert_eq!(
        store.debug_recompute_count() - evals_before,
        depth,
        "each link re-derives exactly once during the flush"
    );
    // Closed form 2N−1, straight from vanilla flushPending mechanics:
    // round 1 drains [head] and the dependencies_change walk re-derives all
    // N links (N visits, each bumping write_seq so settled-memo stamps go
    // stale); round 2 drains the N re-derived links and each walk revalidates
    // its single dependent (N−1 visits, all pruned as unchanged, 0 evals).
    assert_eq!(
        store.debug_flush_visit_count() - visits_before,
        2 * depth - 1,
        "N re-derive visits + (N-1) second-round revalidation visits"
    );
    assert_eq!(as_n(store.get(tail)), (depth + 1) as f64);
}

// ===== unwind-safety guards (ports of the old store's A.5/A.6/A.11 fences,
// re-mandated by the codex P1 review) =====

/// Old store «batch_panic_does_not_leak_depth»: a panicking batch body must
/// not leave batch_depth elevated (or every later set would defer forever).
#[test]
fn batch_panic_does_not_leak_depth() {
    let store = Store::new();
    let a = store.create_atom(n(1.0));
    let calls = Rc::new(Cell::new(0u32));
    let c = calls.clone();
    store.sub(a, move || c.set(c.get() + 1));

    let store_for_panic = store.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        store_for_panic.batch(|s| {
            s.set(a, n(2.0));
            panic!("intentional panic in batch");
        });
    }));
    assert!(result.is_err());

    store.set(a, n(99.0));
    assert_eq!(as_n(store.get(a)), 99.0);
    assert!(calls.get() >= 1, "subscriber must fire after the panic");
}

/// Old store «recompute_panic_does_not_leak_thread_locals»: a panicking read
/// fn must not leave the computing flag set (false cycle panics) nor the
/// nesting counter elevated (silent fault-path degradation).
#[test]
fn read_fn_panic_does_not_poison_computing_state() {
    let store = Store::new();
    let a = store.create_atom(n(1.0));
    let boom = store.create_derived_ctx(move |args| {
        let _ = args.get(a);
        panic!("intentional panic in read fn");
    });
    let observer = store.create_derived_ctx(move |args| args.get(boom));

    let store_for_panic = store.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store_for_panic.get(observer);
    }));
    assert!(result.is_err());

    // A fresh graph on the same store must work cleanly afterwards.
    let b = store.create_atom(n(10.0));
    let c = store.create_derived_ctx(move |args| n(as_n(args.get(b)) * 2.0));
    assert_eq!(as_n(store.get(c)), 20.0);
    store.set(b, n(5.0));
    assert_eq!(as_n(store.get(c)), 10.0);
}

/// New-store twin of the old «writable_atoms_mutual_set_panics» hardening:
/// a panicking write fn must not leave the write-cycle guard armed.
#[test]
fn write_fn_panic_does_not_poison_setting_guard() {
    let store = Store::new();
    let base = store.create_atom(n(0.0));
    let strict = store.create_writable(
        move |args| args.get(base),
        move |args, value| {
            if as_n(value.clone()) < 0.0 {
                panic!("negative writes rejected");
            }
            args.set(base, value);
        },
    );

    let store_for_panic = store.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        store_for_panic.set(strict, n(-1.0));
    }));
    assert!(result.is_err());

    // The guard must be clear: a valid write goes through.
    store.set(strict, n(7.0));
    assert_eq!(as_n(store.get(base)), 7.0);
}

/// Large fan-in stays linear (codex P1 review: per-get dedup and commit diff
/// must be O(1)/O(N), not O(N²)): a 20k-member aggregate re-derives with
/// exactly one completed run and one visit per member walk.
#[test]
fn large_fan_in_recompute_is_linear() {
    let store = Store::new();
    let members: Vec<_> = (0..20_000)
        .map(|i| store.create_atom(n(i as f64)))
        .collect();
    let members_for_sum = members.clone();
    let sum = store.create_derived_ctx(move |args| {
        let s: f64 = members_for_sum.iter().map(|&m| as_n(args.get(m))).sum();
        n(s)
    });
    let expected: f64 = (0..20_000).map(|i| i as f64).sum();
    let before = store.debug_recompute_count();
    assert_eq!(as_n(store.get(sum)), expected);
    assert_eq!(store.debug_recompute_count() - before, 1);

    store.set(members[10_000], n(0.5));
    assert_eq!(as_n(store.get(sum)), expected - 10_000.0 + 0.5);
}

/// DV-4 settled-memo: a batched write of N primitives feeding ONE shared
/// derived must re-derive it once and validate it O(N) times total — not
/// O(N·deps) (the quadratic C-2 cousin this memo exists to kill).
#[test]
fn settled_memo_bulk_write_into_shared_dependent() {
    let store = Store::new();
    let members: Vec<_> = (0..1000).map(|i| store.create_atom(n(i as f64))).collect();
    let members_for_sum = members.clone();
    let sum = store.create_derived_ctx(move |args| {
        let s: f64 = members_for_sum.iter().map(|&m| as_n(args.get(m))).sum();
        n(s)
    });
    let _ = store.get(sum);
    store.flush();

    let evals_before = store.debug_recompute_count();
    let visits_before = store.debug_flush_visit_count();
    store.batch(|s| {
        for &m in &members {
            s.set(m, n(as_n(s.get(m)) + 1.0));
        }
    });
    let evals = store.debug_recompute_count() - evals_before;
    let visits = store.debug_flush_visit_count() - visits_before;

    assert_eq!(
        as_n(store.get(sum)),
        (0..1000).map(|i| i as f64 + 1.0).sum()
    );
    assert_eq!(evals, 1, "shared dependent re-derives once per flush");
    assert_eq!(visits, 1000, "one settled-memo visit per drained root");
}

/// Engine top-level reads may compute a deep cold graph in one `get`.
/// Settling that read must drain its pending entries without replaying the
/// already-computed chain, and the next unrelated write must not inherit them.
#[test]
fn settle_pending_reads_does_not_rewalk_cold_graph() {
    let store = Store::new();
    let (_, tail) = build_chain(&store, 20_000);

    assert_eq!(as_n(store.get(tail)), 20_000.0);
    let visits_before = store.debug_flush_visit_count();
    store.settle_pending_reads();
    assert_eq!(
        store.debug_flush_visit_count(),
        visits_before,
        "read settlement must not run dependencies_change"
    );

    let unrelated = store.create_atom(n(0.0));
    store.set(unrelated, n(1.0));
    assert_eq!(
        store.debug_flush_visit_count(),
        visits_before,
        "the next write must not flush pending work from the prior read"
    );
}
