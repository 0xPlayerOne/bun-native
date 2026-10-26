//! Pure browser-owned authority. Callback identities, never page metadata, enter here.
use crate::rpc_protocol::{next, Identity, MAX_ID};
use std::collections::BTreeMap;

pub const MAX_PACKET_BYTES: usize = 24 * 1024;
// Stop-and-wait in each direction. The host also caps retained delivery bytes
// globally, including revoked connections awaiting a discard acknowledgement.
pub const MAX_GLOBAL_PACKETS: usize = 128;
pub const MAX_GLOBAL_BYTES: usize = MAX_GLOBAL_PACKETS * MAX_PACKET_BYTES;
// Bulk traffic may not consume the complete native-delivery pool. The
// remaining 32 packets/768 KiB stay available to RPC/control deliveries.
pub const MAX_STREAM_GLOBAL_PACKETS: usize = 96;
pub const MAX_STREAM_GLOBAL_BYTES: usize = MAX_STREAM_GLOBAL_PACKETS * MAX_PACKET_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Lane {
    Rpc,
    Stream,
}

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
    pub lane: Lane,
    pub binding: Binding,
    pub bytes: usize,
    pub request: Option<u64>,
}
#[derive(Default)]
pub struct Deliveries {
    pending: BTreeMap<(Lane, u64, u64), Delivery>,
    bytes: usize,
}
impl Deliveries {
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn len_lane(&self, lane: Lane) -> usize {
        self.pending
            .values()
            .filter(|delivery| delivery.lane == lane)
            .count()
    }
    pub fn bytes_lane(&self, lane: Lane) -> usize {
        self.pending
            .values()
            .filter(|delivery| delivery.lane == lane)
            .map(|delivery| delivery.bytes)
            .sum()
    }
    pub fn reserve(
        &mut self,
        binding: Binding,
        sequence: u64,
        bytes: usize,
        request: u64,
    ) -> Result<(), &'static str> {
        self.reserve_lane(Lane::Rpc, binding, sequence, bytes, request)
    }
    pub fn reserve_lane(
        &mut self,
        lane: Lane,
        binding: Binding,
        sequence: u64,
        bytes: usize,
        request: u64,
    ) -> Result<(), &'static str> {
        let key = (lane, binding.connection, sequence);
        let stream_packets = self
            .pending
            .values()
            .filter(|delivery| delivery.lane == Lane::Stream)
            .count();
        let stream_bytes = self
            .pending
            .values()
            .filter(|delivery| delivery.lane == Lane::Stream)
            .map(|delivery| delivery.bytes)
            .sum::<usize>();
        if bytes == 0
            || bytes > MAX_PACKET_BYTES
            || self.pending.len() >= MAX_GLOBAL_PACKETS
            || self.bytes + bytes > MAX_GLOBAL_BYTES
            || (lane == Lane::Stream
                && (stream_packets >= MAX_STREAM_GLOBAL_PACKETS
                    || stream_bytes + bytes > MAX_STREAM_GLOBAL_BYTES))
            || self.pending.contains_key(&key)
        {
            return Err("Native global delivery bound exceeded");
        }
        self.bytes += bytes;
        self.pending.insert(
            key,
            Delivery {
                lane,
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
    pub fn retire_lane(&mut self, lane: Lane, identity: Identity) -> Vec<u64> {
        self.pending
            .values_mut()
            .filter(|delivery| delivery.lane == lane && delivery.binding.identity() == identity)
            .filter_map(|delivery| delivery.request.take())
            .collect()
    }
    pub fn complete(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Option<Delivery> {
        self.complete_lane(Lane::Rpc, observed, identity, sequence)
    }
    pub fn complete_lane(
        &mut self,
        lane: Lane,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Option<Delivery> {
        let key = (lane, identity.connection, sequence);
        if !self.pending.get(&key)?.binding.matches(observed, identity) {
            return None;
        }
        let delivery = self.pending.remove(&key)?;
        self.bytes -= delivery.bytes;
        Some(delivery)
    }
}

#[derive(Debug, Default)]
struct LaneState {
    subscribed: bool,
    received: u64,
    incoming: Option<(u64, usize)>,
    delivered: u64,
    outgoing: Option<(u64, usize)>,
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
    stream_eligible: bool,
    binding: Option<Binding>,
    #[cfg(feature = "rpc-qualification")]
    renderer_process: Option<(Identity, u32)>,
    rpc: LaneState,
    stream: LaneState,
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
            stream_eligible: false,
            binding: None,
            #[cfg(feature = "rpc-qualification")]
            renderer_process: None,
            rpc: LaneState::default(),
            stream: LaneState::default(),
        }
    }
    /// Policy consumers share this document clock. Exhaustion must not become
    /// a repeatable (view, frame, generation, origin) capability identity.
    pub fn generation(&self) -> Option<u64> {
        (self.document != "native-exhausted").then_some(self.generation)
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
        self.incoming_bytes_lane(Lane::Rpc)
    }
    pub fn incoming_bytes_lane(&self, lane: Lane) -> usize {
        self.lane(lane).incoming.map_or(0, |(_, bytes)| bytes)
    }
    pub fn incoming_packet_lane(&self, lane: Lane) -> bool {
        self.lane(lane).incoming.is_some()
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
        #[cfg(feature = "rpc-qualification")]
        {
            self.renderer_process = None;
        }
        self.binding = Some(binding.clone());
        self.stream_eligible = true;
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
    /// Contributor-only identity supplied by compiled renderer code, never a JS field.
    #[cfg(feature = "rpc-qualification")]
    pub fn record_renderer_process(
        &mut self,
        observed: &Observed,
        identity: Identity,
        pid: u64,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        if !self.rpc.subscribed || !(1..=i32::MAX as u64).contains(&pid) {
            return Err("Renderer proof requires a live subscribed process");
        }
        let proof = (identity, pid as u32);
        if self
            .renderer_process
            .is_some_and(|previous| previous != proof)
        {
            return Err("Renderer process proof changed within one native incarnation");
        }
        self.renderer_process = Some(proof);
        Ok(())
    }
    #[cfg(feature = "rpc-qualification")]
    pub fn renderer_process(
        &self,
        observed: &Observed,
        identity: Identity,
    ) -> Result<u32, &'static str> {
        self.authorize(observed, identity)?;
        self.renderer_process
            .filter(|(current, _)| *current == identity && self.rpc.subscribed)
            .map(|(_, pid)| pid)
            .ok_or("Native renderer process proof is unavailable")
    }
    pub fn subscribe(
        &mut self,
        observed: &Observed,
        identity: Identity,
    ) -> Result<Binding, &'static str> {
        self.subscribe_lane(Lane::Rpc, observed, identity)
    }
    pub fn subscribe_lane(
        &mut self,
        lane: Lane,
        observed: &Observed,
        identity: Identity,
    ) -> Result<Binding, &'static str> {
        self.authorize(observed, identity)?;
        if lane == Lane::Stream && !self.stream_eligible {
            return Err("Native stream lane was retired");
        }
        if self.lane(lane).subscribed {
            return Err("Native lane listener already registered");
        }
        self.lane_mut(lane).subscribed = true;
        Ok(self.binding.clone().unwrap())
    }
    pub fn authenticate(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
        bytes: usize,
    ) -> Result<(), &'static str> {
        self.authenticate_lane(Lane::Rpc, observed, identity, sequence, bytes)
    }
    pub fn authenticate_lane(
        &mut self,
        lane: Lane,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
        bytes: usize,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        let state = self.lane_mut(lane);
        if !state.subscribed
            || bytes == 0
            || bytes > MAX_PACKET_BYTES
            || state.incoming.is_some()
            || next(state.received) != Some(sequence)
        {
            return Err("Native lane receive bound or sequence denied");
        }
        state.received = sequence;
        state.incoming = Some((sequence, bytes));
        Ok(())
    }
    pub fn acknowledge_receive(
        &mut self,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        self.acknowledge_receive_lane(Lane::Rpc, observed, identity, sequence)
    }
    pub fn acknowledge_receive_lane(
        &mut self,
        lane: Lane,
        observed: &Observed,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        let state = self.lane_mut(lane);
        if state.incoming.map(|(seq, _)| seq) != Some(sequence) {
            return Err("Native lane receive acknowledgement mismatch");
        }
        state.incoming = None;
        Ok(())
    }
    pub fn begin_delivery(
        &mut self,
        observed: &Observed,
        identity: Identity,
        bytes: usize,
    ) -> Result<u64, &'static str> {
        self.begin_delivery_lane(Lane::Rpc, observed, identity, bytes)
    }
    pub fn begin_delivery_lane(
        &mut self,
        lane: Lane,
        observed: &Observed,
        identity: Identity,
        bytes: usize,
    ) -> Result<u64, &'static str> {
        self.authorize(observed, identity)?;
        let state = self.lane_mut(lane);
        if !state.subscribed || bytes == 0 || bytes > MAX_PACKET_BYTES || state.outgoing.is_some() {
            return Err("Native lane delivery bound denied");
        }
        state.delivered = next(state.delivered).ok_or("Native lane sequence exhausted")?;
        state.outgoing = Some((state.delivered, bytes));
        Ok(state.delivered)
    }
    pub fn finish_delivery(
        &mut self,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        self.finish_delivery_lane(Lane::Rpc, identity, sequence)
    }
    pub fn finish_delivery_lane(
        &mut self,
        lane: Lane,
        identity: Identity,
        sequence: u64,
    ) -> Result<(), &'static str> {
        let bound = self.binding.as_ref().map(Binding::identity) == Some(identity);
        let state = self.lane_mut(lane);
        if !bound || state.outgoing.map(|(seq, _)| seq) != Some(sequence) {
            return Err("Native lane delivery acknowledgement mismatch");
        }
        state.outgoing = None;
        Ok(())
    }
    pub fn release(&mut self, observed: &Observed, identity: Identity) -> Option<Binding> {
        let binding = self.binding.as_ref()?;
        // A context may die before GRANT arrives. Its native serial and actual
        // callback frame still identify the pending, never-subscribed grant.
        let pending = !self.rpc.subscribed
            && !self.stream.subscribed
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
        #[cfg(feature = "rpc-qualification")]
        {
            self.renderer_process = None;
        }
        self.eligible = false;
        self.stream_eligible = false;
        self.rpc = LaneState::default();
        self.stream = LaneState::default();
        self.binding.take()
    }
    pub fn revoke_stream(
        &mut self,
        observed: &Observed,
        identity: Identity,
    ) -> Result<(), &'static str> {
        self.authorize(observed, identity)?;
        self.stream_eligible = false;
        self.stream = LaneState::default();
        Ok(())
    }
    pub fn revoke_frame(&mut self, frame: &str) -> Option<Binding> {
        if self.binding.as_ref().is_some_and(|b| b.frame == frame) {
            self.revoke()
        } else {
            None
        }
    }
    fn lane(&self, lane: Lane) -> &LaneState {
        match lane {
            Lane::Rpc => &self.rpc,
            Lane::Stream => &self.stream,
        }
    }
    fn lane_mut(&mut self, lane: Lane) -> &mut LaneState {
        match lane {
            Lane::Rpc => &mut self.rpc,
            Lane::Stream => &mut self.stream,
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
    #[cfg(feature = "rpc-qualification")]
    #[test]
    fn renderer_process_proof_requires_the_exact_subscribed_native_incarnation() {
        let (mut authority, identity) = bound();
        assert!(authority.renderer_process(&observed(), identity).is_err());
        for pid in [0, i32::MAX as u64 + 1, u64::MAX] {
            assert!(authority
                .record_renderer_process(&observed(), identity, pid)
                .is_err());
        }
        for context in [
            Observed {
                main: false,
                ..observed()
            },
            Observed {
                browser: 99,
                ..observed()
            },
            Observed {
                frame: "foreign".into(),
                ..observed()
            },
            Observed {
                url: "https://example.test/".into(),
                ..observed()
            },
        ] {
            assert!(authority
                .record_renderer_process(&context, identity, 123)
                .is_err());
        }
        assert!(authority
            .record_renderer_process(
                &observed(),
                Identity {
                    generation: 99,
                    ..identity
                },
                123
            )
            .is_err());
        authority.rpc.subscribed = false;
        assert!(authority
            .record_renderer_process(&observed(), identity, 123)
            .is_err());
        authority.rpc.subscribed = true;
        authority
            .record_renderer_process(&observed(), identity, 123)
            .unwrap();
        assert_eq!(authority.renderer_process(&observed(), identity), Ok(123));
    }
    #[cfg(feature = "rpc-qualification")]
    #[test]
    fn renderer_process_proof_is_immutable_and_revoked_with_its_document() {
        let (mut authority, identity) = bound();
        authority
            .record_renderer_process(&observed(), identity, 123)
            .unwrap();
        authority
            .record_renderer_process(&observed(), identity, 123)
            .unwrap();
        assert!(authority
            .record_renderer_process(&observed(), identity, 456)
            .is_err());
        assert_eq!(authority.renderer_process(&observed(), identity), Ok(123));
        authority.revoke();
        assert!(authority.renderer_process(&observed(), identity).is_err());
        assert_eq!(authority.renderer_process, None);
        assert!(authority
            .record_renderer_process(&observed(), identity, 123)
            .is_err());
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
                browser: observed().browser + 1,
                ..observed()
            },
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
        a.rpc.received = MAX_ID;
        assert!(a.authenticate(&observed(), id, MAX_ID, 1).is_err());
    }
    #[test]
    fn stream_lane_has_independent_subscription_sequences_and_pending_bytes() {
        let (mut authority, identity) = bound();
        authority
            .subscribe_lane(Lane::Stream, &observed(), identity)
            .unwrap();
        authority
            .authenticate(&observed(), identity, 1, MAX_PACKET_BYTES)
            .unwrap();
        authority
            .authenticate_lane(Lane::Stream, &observed(), identity, 1, 17)
            .unwrap();
        assert_eq!(authority.incoming_bytes(), MAX_PACKET_BYTES);
        assert_eq!(authority.incoming_bytes_lane(Lane::Stream), 17);
        assert!(authority
            .authenticate_lane(Lane::Stream, &observed(), identity, 2, 1)
            .is_err());
        authority
            .acknowledge_receive_lane(Lane::Stream, &observed(), identity, 1)
            .unwrap();
        authority
            .authenticate_lane(Lane::Stream, &observed(), identity, 2, 1)
            .unwrap();
        let rpc = authority.begin_delivery(&observed(), identity, 1).unwrap();
        let stream = authority
            .begin_delivery_lane(Lane::Stream, &observed(), identity, 1)
            .unwrap();
        assert_eq!((rpc, stream), (1, 1));
        authority.finish_delivery(identity, rpc).unwrap();
        authority
            .finish_delivery_lane(Lane::Stream, identity, stream)
            .unwrap();
    }
    #[test]
    fn retired_stream_lane_cannot_resubscribe_while_rpc_remains_authorized() {
        let (mut authority, identity) = bound();
        authority
            .subscribe_lane(Lane::Stream, &observed(), identity)
            .unwrap();
        authority.revoke_stream(&observed(), identity).unwrap();
        assert!(authority.authorize(&observed(), identity).is_ok());
        assert!(authority
            .subscribe_lane(Lane::Stream, &observed(), identity)
            .is_err());
        assert!(authority.begin_delivery(&observed(), identity, 1).is_ok());
    }
    #[test]
    fn lane_keying_and_stream_reserve_keep_rpc_delivery_headroom() {
        let (authority, identity) = bound();
        let binding = authority.binding().unwrap();
        let mut deliveries = Deliveries::default();
        deliveries
            .reserve(binding.clone(), 1, MAX_PACKET_BYTES, 1)
            .unwrap();
        deliveries
            .reserve_lane(Lane::Stream, binding.clone(), 1, MAX_PACKET_BYTES, 2)
            .unwrap();
        for sequence in 2..=MAX_STREAM_GLOBAL_PACKETS as u64 {
            deliveries
                .reserve_lane(
                    Lane::Stream,
                    binding.clone(),
                    sequence,
                    MAX_PACKET_BYTES,
                    sequence + 1,
                )
                .unwrap();
        }
        assert!(deliveries
            .reserve_lane(Lane::Stream, binding.clone(), 200, 1, 200)
            .is_err());
        for sequence in 2..=(MAX_GLOBAL_PACKETS - MAX_STREAM_GLOBAL_PACKETS) as u64 {
            deliveries
                .reserve(binding.clone(), sequence, MAX_PACKET_BYTES, sequence + 200)
                .unwrap();
        }
        assert_eq!(deliveries.len(), MAX_GLOBAL_PACKETS);
        assert_eq!(deliveries.bytes(), MAX_GLOBAL_BYTES);
        assert_eq!(
            deliveries
                .complete_lane(Lane::Stream, &observed(), identity, 1)
                .unwrap()
                .lane,
            Lane::Stream
        );
        assert_eq!(
            deliveries.complete(&observed(), identity, 1).unwrap().lane,
            Lane::Rpc
        );
    }
    #[test]
    fn retiring_stream_lane_settles_waiters_but_keeps_cef_owned_bytes() {
        let (authority, identity) = bound();
        let binding = authority.binding().unwrap();
        let mut deliveries = Deliveries::default();
        deliveries.reserve(binding.clone(), 1, 11, 1).unwrap();
        deliveries
            .reserve_lane(Lane::Stream, binding, 1, 13, 2)
            .unwrap();
        assert_eq!(deliveries.retire_lane(Lane::Stream, identity), vec![2]);
        assert_eq!(deliveries.bytes(), 24);
        assert!(deliveries
            .complete(&observed(), identity, 1)
            .unwrap()
            .request
            .is_some());
        assert!(deliveries
            .complete_lane(Lane::Stream, &observed(), identity, 1)
            .unwrap()
            .request
            .is_none());
        assert_eq!(deliveries.bytes(), 0);
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
    fn exhausted_document_clock_never_supplies_a_reusable_policy_generation() {
        let (mut authority, _) = bound();
        authority.generation = MAX_ID;
        assert_eq!(authority.generation(), Some(MAX_ID));
        authority.explicit_navigation_start();
        assert_eq!(authority.generation(), None);
        authority.explicit_navigation_start();
        assert_eq!(authority.generation(), None);
        assert!(authority.bind(8, &observed(), 5).is_none());
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
