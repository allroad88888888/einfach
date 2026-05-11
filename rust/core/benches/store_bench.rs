//! Criterion benchmarks for `einfach-core::Store` hot paths.
//!
//! Run with `cargo bench` from this crate (or `cargo bench --bench store_bench`).
//! See `rust/docs/PERF.md` for what each benchmark gates and how to compare
//! baselines across LAZY refactor steps.

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};

use einfach_core::{Store, Value};

/// `bench_atom_write_throughput` — bare `Store::set` cost.
///
/// Creates N primitive atoms up-front, then sets each one in a tight loop.
/// No derived atoms, no subscribers — the result is a clean "ops/sec" number
/// for the primitive write path. This is the floor; everything else builds
/// on top of it.
fn bench_atom_write_throughput(c: &mut Criterion) {
    const N: usize = 10_000;

    let mut group = c.benchmark_group("store/atom_write_throughput");
    group.throughput(Throughput::Elements(N as u64));

    group.bench_function("set_10k_primitives", |b| {
        b.iter_batched(
            || {
                // Setup phase (not measured): fresh store + N atoms preloaded to 0.0
                let mut store = Store::new();
                let ids: Vec<_> = (0..N)
                    .map(|_| store.create_atom(Value::Number(0.0)))
                    .collect();
                (store, ids)
            },
            |(mut store, ids)| {
                // Measured: write each atom once.
                for (i, &id) in ids.iter().enumerate() {
                    store.set(id, Value::Number(i as f64));
                }
                black_box(&store);
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

/// `bench_formula_chain_propagation` — worst-case propagation depth.
///
/// Builds a linear chain `a1 = primitive, a2 = a1 + 1, a3 = a2 + 1, ..., a100 = a99 + 1`.
/// Then bumps `a1` in a loop and measures how long one full chain reaches the tail.
///
/// This is the propagation walker's worst case: every set requires N recompute()
/// calls in topological order. LAZY Step 4 (range streaming) won't help here, but
/// any regression in the propagation core will show up loudly.
fn bench_formula_chain_propagation(c: &mut Criterion) {
    const CHAIN_LEN: usize = 100;

    let mut group = c.benchmark_group("store/formula_chain_propagation");
    group.throughput(Throughput::Elements(CHAIN_LEN as u64));

    group.bench_function("chain_100_propagate", |b| {
        b.iter_batched(
            || {
                // Setup (not measured): build the chain.
                let mut store = Store::new();
                let head = store.create_atom(Value::Number(0.0));
                let mut prev = head;
                for _ in 1..CHAIN_LEN {
                    let upstream = prev;
                    prev = store.create_derived(move |get| match get(upstream) {
                        Value::Number(n) => Value::Number(n + 1.0),
                        _ => Value::Null,
                    });
                }
                (store, head, prev)
            },
            |(mut store, head, tail)| {
                // Measured: one set on head -> full chain recompute.
                store.set(head, Value::Number(1.0));
                // Read the tail to make sure the chain actually settled.
                black_box(store.get(tail));
            },
            criterion::BatchSize::SmallInput,
        );
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_atom_write_throughput,
    bench_formula_chain_propagation,
);
criterion_main!(benches);
