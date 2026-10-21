//! Explicit bounded functional-test deadlines. Shipping defaults never auto-scale.
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Copy, Default, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DeadlineProfile {
    #[default]
    Standard,
    EmulatedFunctional,
}
impl DeadlineProfile {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::EmulatedFunctional => "emulated-functional",
        }
    }
    pub(crate) fn startup(self) -> Duration {
        Duration::from_secs(match self {
            Self::Standard => 10,
            Self::EmulatedFunctional => 60,
        })
    }
    pub(crate) fn requests_ms(self) -> u64 {
        match self {
            Self::Standard => 10_000,
            Self::EmulatedFunctional => 30_000,
        }
    }
    pub(crate) fn shutdown(self) -> Duration {
        Duration::from_secs(match self {
            Self::Standard => 8,
            Self::EmulatedFunctional => 30,
        })
    }
    pub(crate) fn backend_exit(self) -> Duration {
        Duration::from_secs(match self {
            Self::Standard => 2,
            Self::EmulatedFunctional => 5,
        })
    }
}
pub(crate) fn current() -> DeadlineProfile {
    crate::PATHS
        .get()
        .map(|paths| paths.deadlines)
        .unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipping_defaults_remain_unchanged() {
        let p = DeadlineProfile::default();
        assert_eq!(p.name(), "standard");
        assert_eq!(p.startup().as_secs(), 10);
        assert_eq!(p.requests_ms(), 10_000);
        assert_eq!(p.shutdown().as_secs(), 8);
        assert_eq!(p.backend_exit().as_secs(), 2);
    }
    #[test]
    fn explicit_profile_is_finite_and_cannot_disable_deadlines() {
        let p: DeadlineProfile = serde_json::from_str(r#""emulated-functional""#).unwrap();
        assert_eq!(p.startup().as_secs(), 60);
        assert_eq!(p.requests_ms(), 30_000);
        assert_eq!(p.shutdown().as_secs(), 30);
        assert_eq!(p.backend_exit().as_secs(), 5);
        for value in ["null", "true", "0", "999999", r#""unbounded""#, "{}"] {
            assert!(serde_json::from_str::<DeadlineProfile>(value).is_err());
        }
    }
}
