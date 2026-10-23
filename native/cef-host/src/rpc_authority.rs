//! Pure browser-owned authority. Callback identities, never page metadata, enter here.
use crate::rpc_protocol::{next, Identity, MAX_ID};
use std::collections::BTreeMap;

pub const MAX_PACKET_BYTES: usize = 24 * 1024;
// Stop-and-wait in each direction. The host also caps retained delivery bytes
// globally, including revoked connections awaiting a discard acknowledgement.
pub const MAX_GLOBAL_PACKETS: usize = 128;
pub const MAX_GLOBAL_BYTES: usize = MAX_GLOBAL_PACKETS * MAX_PACKET_BYTES;

#[derive(Debug, Clone)]
pub struct Observed {
    pub browser: i32,
    pub frame: String,
    pub url: String,
    pub main: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub connection: u64,
    pub browser: i32,
    pub frame: String,
    pub document: String,
    pub generation: u64,
    pub context: u64,
}
impl Binding {
    pub fn identity(&self) -> Identity {
        Identity {
            context: self.context,
            connection: self.connection,
            generation: self.generation,
        }
    }
    pub fn matches(&self, observed: &Observed, identity: Identity) -> bool {
        self.identity() == identity
            && self.browser == observed.browser
            && self.frame == observed.frame
            && observed.main
    }
}

pub struct Delivery {
    pub binding: Binding,
    pub bytes: usize,
    pub request: Option<u64>,
}
#[derive(Default)]
pub struct Deliveries {
    pending: BTreeMap<(u64, u64), Delivery>,
    bytes: usize,
}
impl Deliveries {
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn reserve(
        &mut self,
        binding: Binding,
        sequence: u64,
        bytes: usize,
        request: u64,
    ) -> Result<(), &'static str> {
        let key = (binding.connection, sequence);
        if bytes == 0
            || bytes > MAX_PACKET_BYTES
            || self.pending.len() >= MAX_GLOBAL_PACKETS
            || self.bytes + bytes > MAX_GLOBAL_BYTES
            || self.pending.contains_key(&key)
        {
            return Err("RPC global delivery bound exceeded");
        }
        self.bytes += bytes;
        self.pending.insert(
            key,
            Delivery {
                binding,
                bytes,
                request: Some(request),
            },
        );
        Ok(())
    }
    pub fn retire(&mut self, identity: Identity) -> Vec<u64> {
        self.pending
            .values_mut()
            .filter(|delivery| delivery.binding.identity() == identity)
            .filter_map(|delivery| delivery.request.take())
            .collect()
    }
    pub fn complete(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Option<Delivery> {
        let key = (identity.connection, sequence);
        if !self.pending.get(&key)?.binding.matches(observed, identity) {
            return None;
        }
        let delivery = self.pending.remove(&key)?;
        self.bytes -= delivery.bytes;
        Some(delivery)
    }
}

#[derive(Debug)]
pub struct Authority {
    view: u64,
    approved_origin: Option<String>,
    initial_url: String,
    generation: u64,
    document: String,
    initial_request_seen: bool,
    awaiting_explicit_callback: bool,
    eligible: bool,
    binding: Option<Binding>,
    subscribed: bool,
    received: u64,
    incoming: Option<(u64, usize)>,
    delivered: u64,
    outgoing: Option<(u64, usize)>,
}
impl Authority {
    pub fn new(view: u64, initial_url: String, approved_origin: Option<String>) -> Self {
        let eligible = approved_origin.as_deref().is_some_and(|origin| {
            origin.starts_with("app://") && exact_origin(&initial_url).as_deref() == Some(origin)
        });
        Self {
            view,
            approved_origin,
            initial_url,
            generation: 1,
            document: format!("native-{view}-1"),
            initial_request_seen: false,
            awaiting_explicit_callback: false,
            eligible,
            binding: None,
            subscribed: false,
            received: 0,
            incoming: None,
            delivered: 0,
            outgoing: None,
        }
    }
    pub fn document(&self) -> &str {
        &self.document
    }
    pub fn binding(&self) -> Option<Binding> {
        self.binding.clone()
    }
    pub fn application_trust(&self) -> bool {
        self.eligible
    }
    pub fn incoming_bytes(&self) -> usize {
        self.incoming.map_or(0, |(_, bytes)| bytes)
    }

    pub fn navigation_start(&mut self, url: &str, redirect: bool) -> Option<Binding> {
        if self.awaiting_explicit_callback && !redirect {
            self.awaiting_explicit_callback = false;
            return None;
        }
        self.awaiting_explicit_callback = false;
        let initial = !self.initial_request_seen && !redirect && url == self.initial_url;
        self.initial_request_seen = true;
        if initial {
            return None;
        }
        self.new_document()
    }
    pub fn explicit_navigation_start(&mut self) -> Option<Binding> {
        self.initial_request_seen = true;
        self.awaiting_explicit_callback = true;
        self.new_document()
    }
    fn new_document(&mut self) -> Option<Binding> {
        let old = self.revoke();
        // Exhaustion is terminal for authority; never saturate into a reusable ID.
        if let Some(generation) = next(self.generation) {
            self.generation = generation;
            self.document = format!("native-{}-{generation}", self.view);
        } else {
            self.document = String::from("native-exhausted");
        }
        old
    }
    pub fn bind(&mut self, connection: u64, observed: &Observed, context: u64) -> Option<Binding> {
        if !self.eligible
            || self.binding.is_some()
            || !observed.main
            || observed.frame.is_empty()
            || observed.frame.len() > 256
            || !(1..=MAX_ID).contains(&context)
            || !(1..=MAX_ID).contains(&connection)
            || self.approved_origin.as_deref() != exact_origin(&observed.url).as_deref()
        {
            return None;
        }
        let binding = Binding {
            connection,
            browser: observed.browser,
            frame: observed.frame.clone(),
            document: self.document.clone(),
            generation: self.generation,
            context,
        };
        self.binding = Some(binding.clone());
        Some(binding)
    }
    pub fn authorize(&self, observed: &Observed, identity: Identity) -> Result<(), &'static str> {
        if !self
            .binding
            .as_ref()
            .is_some_and(|b| b.matches(observed, identity))
            || self.approved_origin.as_deref() != exact_origin(&observed.url).as_deref()
        {
            return Err("RPC native incarnation mismatch");
        }
        Ok(())
    }
    pub fn subscribe(
        &mut self,
        observed: &Observed,
        identity: Identity,
    ) -> Result<Binding, &'static str> {
        self.authorize(observed, identity)?;
        if self.subscribed {
            return Err("RPC listener already registered");
        }
        self.subscribed = true;
        Ok(self.binding.clone().unwrap())
    }
    pub fn authenticate(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
        bytes: usize,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        if !self.subscribed
            || bytes == 0
            || bytes > MAX_PACKET_BYTES
            || self.incoming.is_some()
            || next(self.received) != Some(sequence)
        {
            return Err("RPC receive bound or sequence denied");
        }
        self.received = sequence;
        self.incoming = Some((sequence, bytes));
        Ok(())
    }
    pub fn acknowledge_receive(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        if self.incoming.map(|(seq, _)| seq) != Some(sequence) {
            return Err("RPC receive acknowledgement mismatch");
        }
        self.incoming = None;
        Ok(())
    }
    pub fn begin_delivery(
        &mut self,
        observed: &Observed,
        identity: Identity,
        bytes: usize,
    ) -> Result<u64, &'static str> {
        self.authorize(observed, identity)?;
        if !self.subscribed || bytes == 0 || bytes > MAX_PACKET_BYTES || self.outgoing.is_some() {
            return Err("RPC delivery bound denied");
        }
        self.delivered = next(self.delivered).ok_or("RPC sequence exhausted")?;
        self.outgoing = Some((self.delivered, bytes));
        Ok(self.delivered)
    }
    pub fn finish_delivery(
        &mut self,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        if self.binding.as_ref().map(Binding::identity) != Some(identity)
            || self.outgoing.map(|(seq, _)| seq) != Some(sequence)
        {
            return Err("RPC delivery acknowledgement mismatch");
        }
        self.outgoing = None;
        Ok(())
    }
    pub fn release(&mut self, observed: &Observed, identity: Identity) -> Option<Binding> {
        let binding = self.binding.as_ref()?;
        // A context may die before GRANT arrives. Its native serial and actual
        // callback frame still identify the pending, never-subscribed grant.
        let pending = !self.subscribed
            && identity.connection == 0
            && identity.generation == 0
            && identity.context == binding.context
            && observed.browser == binding.browser
            && observed.frame == binding.frame
            && observed.main;
        if !pending && !binding.matches(observed, identity) {
            return None;
        }
        self.revoke()
    }
    pub fn revoke(&mut self) -> Option<Binding> {
        self.eligible = false;
        self.subscribed = false;
        self.incoming = None;
        self.outgoing = None;
        self.binding.take()
    }
    pub fn revoke_frame(&mut self, frame: &str) -> Option<Binding> {
        if self.binding.as_ref().is_some_and(|b| b.frame == frame) {
            self.revoke()
        } else {
            None
        }
    }
}
pub fn exact_origin(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() == "app" {
        let host = url.host_str()?;
        if url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        Some(format!("app://{host}"))
    } else {
        Some(url.origin().ascii_serialization())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observed() -> Observed {
        Observed {
            browser: 3,
            frame: "main".into(),
            url: "app://ui/index.html".into(),
            main: true,
        }
    }
    fn bound() -> (Authority, Identity) {
        let mut authority = Authority::new(1, observed().url, Some("app://ui".into()));
        authority.navigation_start("app://ui/index.html", false);
        let binding = authority.bind(7, &observed(), 4).unwrap();
        authority
            .subscribe(&observed(), binding.identity())
            .unwrap();
        (authority, binding.identity())
    }
    #[test]
    fn global_delivery_reservations_survive_revoke_until_exact_discard() {
        let (authority, identity) = bound();
        let binding = authority.binding().unwrap();
        let mut deliveries = Deliveries::default();
        for sequence in 1..=MAX_GLOBAL_PACKETS as u64 {
            deliveries
                .reserve(binding.clone(), sequence, MAX_PACKET_BYTES, sequence)
                .unwrap();
        }
        assert_eq!(deliveries.bytes(), MAX_GLOBAL_BYTES);
        assert!(deliveries.reserve(binding.clone(), 200, 1, 200).is_err());
        assert_eq!(deliveries.retire(identity).len(), MAX_GLOBAL_PACKETS);
        assert_eq!(
            deliveries.bytes(),
            MAX_GLOBAL_BYTES,
            "Revocation cannot release CEF-owned bytes"
        );
        assert!(deliveries
            .complete(
                &observed(),
                Identity {
                    context: 99,
                    ..identity
                },
                1
            )
            .is_none());
        assert!(deliveries
            .complete(
                &Observed {
                    main: false,
                    ..observed()
                },
                identity,
                1
            )
            .is_none());
        assert!(deliveries
            .complete(&observed(), identity, 1)
            .unwrap()
            .request
            .is_none());
        assert!(deliveries.complete(&observed(), identity, 1).is_none());
        assert_eq!(deliveries.bytes(), MAX_GLOBAL_BYTES - MAX_PACKET_BYTES);
        deliveries
            .reserve(binding, 200, MAX_PACKET_BYTES, 200)
            .unwrap();
    }
    #[test]
    fn wrong_context_frame_origin_and_connection_do_not_mutate_live_work() {
        let (mut authority, identity) = bound();
        authority
            .authenticate(&observed(), identity, 1, 13)
            .unwrap();
        for forged in [
            Identity {
                context: 5,
                ..identity
            },
            Identity {
                connection: 8,
                ..identity
            },
            Identity {
                generation: 2,
                ..identity
            },
        ] {
            assert!(authority
                .acknowledge_receive(&observed(), forged, 1)
                .is_err());
            assert!(authority.release(&observed(), forged).is_none());
        }
        for other in [
            Observed {
                main: false,
                ..observed()
            },
            Observed {
                frame: "child".into(),
                ..observed()
            },
            Observed {
                url: "app://other/".into(),
                ..observed()
            },
        ] {
            assert!(authority.acknowledge_receive(&other, identity, 1).is_err());
        }
        assert_eq!(authority.incoming_bytes(), 13);
        authority
            .acknowledge_receive(&observed(), identity, 1)
            .unwrap();
    }
    #[test]
    fn outstanding_bytes_sequences_and_duplicate_subscriptions_are_bounded() {
        let (mut a, id) = bound();
        assert!(a.subscribe(&observed(), id).is_err());
        a.authenticate(&observed(), id, 1, MAX_PACKET_BYTES)
            .unwrap();
        assert!(a.authenticate(&observed(), id, 2, 1).is_err());
        a.acknowledge_receive(&observed(), id, 1).unwrap();
        assert!(a.authenticate(&observed(), id, 1, 1).is_err());
        assert!(a
            .authenticate(&observed(), id, 2, MAX_PACKET_BYTES + 1)
            .is_err());
        let seq = a.begin_delivery(&observed(), id, 3).unwrap();
        assert!(a.begin_delivery(&observed(), id, 1).is_err());
        a.finish_delivery(id, seq).unwrap();
        assert!(a.finish_delivery(id, seq).is_err());
        a.received = MAX_ID;
        assert!(a.authenticate(&observed(), id, MAX_ID, 1).is_err());
    }
    #[test]
    fn navigation_release_and_close_never_regrant_old_origin() {
        for action in 0..4 {
            let (mut a, id) = bound();
            match action {
                0 => {
                    a.explicit_navigation_start();
                }
                1 => {
                    a.navigation_start("app://ui/redirect", true);
                }
                2 => {
                    a.release(&observed(), id);
                }
                _ => {
                    a.revoke();
                }
            }
            assert!(a.authenticate(&observed(), id, 1, 1).is_err());
            a.navigation_start("app://ui/index.html", false);
            assert!(a.bind(8, &observed(), 5).is_none());
        }
    }
    #[test]
    fn remote_child_opaque_and_development_contexts_never_bind() {
        for (origin, context) in [
            (None, observed()),
            (
                Some("app://ui"),
                Observed {
                    main: false,
                    ..observed()
                },
            ),
            (
                Some("app://ui"),
                Observed {
                    url: "about:blank".into(),
                    ..observed()
                },
            ),
            (
                Some("http://127.0.0.1:8000"),
                Observed {
                    url: "http://127.0.0.1:8000/".into(),
                    ..observed()
                },
            ),
        ] {
            let mut a = Authority::new(1, context.url.clone(), origin.map(str::to_owned));
            assert!(a.bind(1, &context, 1).is_none());
        }
    }
}
