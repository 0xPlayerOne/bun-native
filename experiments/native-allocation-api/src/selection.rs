//! Fixed unchanged historical bridge workload. Never search for matching samples.
use crate::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Individual,
    Batch,
}

impl Phase {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "individual" => Ok(Self::Individual),
            "batch" => Ok(Self::Batch),
            _ => Err(Error("invalid selected allocation phase")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Individual => "individual",
            Self::Batch => "batch",
        }
    }

    pub fn request_range(self) -> (u64, u64) {
        match self {
            Self::Individual => (48, 1047),
            Self::Batch => (1048, 1057),
        }
    }

    pub fn operation_count(self) -> usize {
        match self {
            Self::Individual => 1,
            Self::Batch => 100,
        }
    }

    fn first_revision(self) -> u64 {
        match self {
            Self::Individual => 33,
            Self::Batch => 1033,
        }
    }

    /// Validate borrowed text without formatting/copying payloads into records.
    pub fn valid_set(self, request: u64, offset: usize, node: u64, text: &str) -> bool {
        let (first, last) = self.request_range();
        if !(first..=last).contains(&request) || offset >= self.operation_count() {
            return false;
        }
        let index = (request - first) * self.operation_count() as u64 + offset as u64;
        let prefix = match self {
            Self::Individual => "single ",
            Self::Batch => "batch ",
        };
        let Some(suffix) = text.strip_prefix(prefix) else {
            return false;
        };
        node == 9 + index
            && !suffix.is_empty()
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
            && (suffix.len() == 1 || !suffix.starts_with('0'))
            && suffix.parse::<u64>() == Ok(index)
    }
}

/// Only numeric/Boolean facts cross this adapter boundary.
#[derive(Clone, Copy, Debug)]
pub struct Observation {
    pub id: u64,
    pub window: u64,
    pub base_revision: u64,
    pub operation_count: usize,
    pub valid_sets: bool,
    pub root: u64,
    pub retained_nodes: usize,
}

pub(crate) struct Selection {
    pub(crate) phase: Phase,
    next: u64,
    pending: Option<u64>,
    pub(crate) applied: u64,
    complete: bool,
}

impl Selection {
    pub(crate) fn new(phase: Phase) -> Self {
        Self {
            phase,
            next: phase.request_range().0,
            pending: None,
            applied: 0,
            complete: false,
        }
    }

    pub(crate) fn before(&mut self, value: Observation) -> Result<bool> {
        let (first, last) = self.phase.request_range();
        if value.id < first || (value.id > last && self.complete) {
            return Ok(false);
        }
        if self.complete || self.pending.is_some() || value.id != self.next {
            return Err(Error("missing, repeated or reordered selected request"));
        }
        if value.window != 1
            || value.base_revision != self.phase.first_revision() + value.id - first
            || value.operation_count != self.phase.operation_count()
            || !value.valid_sets
            || value.root != 1
            || (value.id == first && value.retained_nodes != 1001)
        {
            return Err(Error("selected request does not match the fixed workload"));
        }
        self.pending = Some(value.id);
        Ok(value.id == first)
    }

    pub(crate) fn after(&mut self, id: u64, applied: bool) -> Result<bool> {
        let (first, last) = self.phase.request_range();
        if id < first || (id > last && self.complete) {
            return Ok(false);
        }
        if self.pending != Some(id) || !applied {
            return Err(Error(
                "selected native apply failed or has no matching prepare",
            ));
        }
        self.pending = None;
        self.applied += 1;
        self.next += 1;
        self.complete = id == last;
        Ok(self.complete)
    }

    pub(crate) fn finish(&self) -> Result<()> {
        if !self.complete || self.pending.is_some() {
            return Err(Error("selected allocation interval did not complete"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation(phase: Phase, id: u64) -> Observation {
        Observation {
            id,
            window: 1,
            base_revision: phase.first_revision() + id - phase.request_range().0,
            operation_count: phase.operation_count(),
            valid_sets: true,
            root: 1,
            retained_nodes: 1001,
        }
    }
    #[test]
    fn exact_intervals_open_and_close_once() {
        for phase in [Phase::Individual, Phase::Batch] {
            let mut state = Selection::new(phase);
            let (first, last) = phase.request_range();
            for id in first..=last {
                assert_eq!(state.before(observation(phase, id)), Ok(id == first));
                assert_eq!(state.after(id, true), Ok(id == last));
            }
            assert_eq!(state.applied, last - first + 1);
            state.finish().unwrap();
            assert!(state.before(observation(phase, first)).is_err());
        }
    }
    #[test]
    fn lost_reordered_duplicate_or_unapplied_requests_fail() {
        for phase in [Phase::Individual, Phase::Batch] {
            let first = phase.request_range().0;
            assert!(
                Selection::new(phase)
                    .before(observation(phase, first + 1))
                    .is_err()
            );
            let mut state = Selection::new(phase);
            state.before(observation(phase, first)).unwrap();
            assert!(state.before(observation(phase, first + 1)).is_err());
            assert!(state.after(first + 1, true).is_err());
            assert!(state.after(first, false).is_err());
            assert!(state.finish().is_err());
        }
    }
    #[test]
    fn malformed_fixed_shape_is_not_selected_by_payload_search() {
        let original = observation(Phase::Individual, 48);
        for changed in [
            Observation {
                window: 2,
                ..original
            },
            Observation {
                base_revision: 32,
                ..original
            },
            Observation {
                operation_count: 2,
                ..original
            },
            Observation {
                valid_sets: false,
                ..original
            },
            Observation {
                root: 2,
                ..original
            },
            Observation {
                retained_nodes: 1000,
                ..original
            },
        ] {
            assert!(Selection::new(Phase::Individual).before(changed).is_err());
        }
    }
    #[test]
    fn sets_require_exact_node_and_canonical_numeric_value() {
        for phase in [Phase::Individual, Phase::Batch] {
            let (first, last) = phase.request_range();
            let prefix = if phase == Phase::Individual {
                "single"
            } else {
                "batch"
            };
            assert!(phase.valid_set(first, 0, 9, &format!("{prefix} 0")));
            assert!(phase.valid_set(
                last,
                phase.operation_count() - 1,
                1008,
                &format!("{prefix} 999")
            ));
            for text in [
                format!("{prefix} 00"),
                format!("{prefix} +0"),
                format!("{prefix} 1"),
                "other 0".into(),
            ] {
                assert!(!phase.valid_set(first, 0, 9, &text));
            }
            assert!(!phase.valid_set(first, 0, 10, &format!("{prefix} 0")));
            assert!(!phase.valid_set(last + 1, 0, 9, &format!("{prefix} 0")));
            assert!(!phase.valid_set(first, phase.operation_count(), 9, &format!("{prefix} 0")));
        }
    }
}
