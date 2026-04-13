use crate::atom::AtomId;

use super::{Store, SubscriptionId};

impl Store {
    /// Subscribe to value changes on an atom. Returns a subscription id for unsubscribing.
    pub fn sub(&mut self, id: AtomId, listener: impl Fn() + 'static) -> SubscriptionId {
        let sub_id = SubscriptionId(self.next_sub_id);
        self.next_sub_id += 1;
        self.subscriptions
            .entry(id)
            .or_default()
            .push((sub_id, std::rc::Rc::new(listener)));
        sub_id
    }

    /// Remove a subscription.
    pub fn unsub(&mut self, sub_id: SubscriptionId) {
        for subs in self.subscriptions.values_mut() {
            subs.retain(|(id, _)| *id != sub_id);
        }
    }

    /// Notify all subscribers of the given atoms.
    pub(super) fn notify(&self, changed: &[AtomId]) {
        for id in changed {
            if let Some(subs) = self.subscriptions.get(id) {
                for (_, listener) in subs {
                    listener();
                }
            }
        }
    }
}
