use std::collections::{HashMap, HashSet};

use crate::atom::{AtomId, Value};

use super::{Store, COMPUTING, TRACKING};

impl Store {
    /// Recompute a derived atom's value and update its dependency graph.
    pub(super) fn recompute(&mut self, id: AtomId) {
        let read_fn = self.read_fns.get(&id).expect("not a derived atom").clone();

        let already_computing = COMPUTING.with(|c| !c.borrow_mut().insert(id));
        if already_computing {
            panic!("circular dependency detected involving atom {:?}", id);
        }

        let values = &self.values as *const HashMap<AtomId, Value>;
        TRACKING.with(|t| *t.borrow_mut() = Some(HashSet::new()));

        let getter = |dep_id: AtomId| -> Value {
            let is_cycle = COMPUTING.with(|c| c.borrow().contains(&dep_id));
            if is_cycle {
                panic!(
                    "circular dependency detected: atom {:?} depends on atom {:?} which is being computed",
                    dep_id, dep_id
                );
            }

            TRACKING.with(|t| {
                if let Some(ref mut deps) = *t.borrow_mut() {
                    deps.insert(dep_id);
                }
            });

            unsafe {
                if let Some(val) = (*values).get(&dep_id) {
                    return val.clone();
                }
            }
            panic!("atom {:?} not found in store", dep_id);
        };

        let new_value = read_fn(&getter);

        COMPUTING.with(|c| c.borrow_mut().remove(&id));

        let new_deps = TRACKING.with(|t| t.borrow_mut().take().unwrap());

        if let Some(old_deps) = self.dependencies.get(&id) {
            for old_dep in old_deps {
                if let Some(backs) = self.back_deps.get_mut(old_dep) {
                    backs.remove(&id);
                }
            }
        }
        for dep in &new_deps {
            self.back_deps.entry(*dep).or_default().insert(id);
        }
        self.dependencies.insert(id, new_deps);
        self.values.insert(id, new_value);
    }

    /// Collect all derived atoms transitively affected by a change to `root`.
    pub(super) fn collect_affected(&self, root: AtomId) -> HashSet<AtomId> {
        let mut affected = HashSet::new();
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if affected.insert(back) {
                        stack.push(back);
                    }
                }
            }
        }
        affected
    }

    /// Topological sort of affected derived atoms (dependencies first).
    pub(super) fn topological_sort(&self, affected: &HashSet<AtomId>) -> Vec<AtomId> {
        let mut in_degree: HashMap<AtomId, usize> = HashMap::new();
        for &id in affected {
            in_degree.entry(id).or_insert(0);
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if affected.contains(&back) {
                        *in_degree.entry(back).or_insert(0) += 1;
                    }
                }
            }
        }

        let mut queue: Vec<AtomId> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();
        let mut result = Vec::new();

        while let Some(id) = queue.pop() {
            result.push(id);
            if let Some(backs) = self.back_deps.get(&id) {
                for &back in backs {
                    if let Some(deg) = in_degree.get_mut(&back) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push(back);
                        }
                    }
                }
            }
        }

        result
    }
}
