# Bun Native changelog

## Unreleased — October 31, 2026

### Project direction

- Renamed the experimental Bunly project to **Bun Native**.
- Committed to a new TypeScript/JavaScript + Bun machine-code AOT + browserless native renderer architecture, with Rust GPUI as the initial implementation.
- Defined first-party SolidJS and React adapters, native host/component contracts, developer tooling, per-platform packages and performance validation in [BN0–BN7](https://github.com/0xPlayerOne/bun-native/issues/1).
- Declared the old CEF/WebView implementation superseded and scheduled for removal from active source.
- Replaced active product documentation with the Bun Native architecture, compatibility, contributor, testing, release and quality guidance.

### Implementation status

**No Bun Native native-window runtime or AOT release artifact has been qualified yet.** The first implementation tasks are [#251](https://github.com/0xPlayerOne/bun-native/issues/251), [#225](https://github.com/0xPlayerOne/bun-native/issues/225), [#230](https://github.com/0xPlayerOne/bun-native/issues/230) and [#227](https://github.com/0xPlayerOne/bun-native/issues/227).

## Historical Bunly releases

Bunly 0.6.x and earlier changelog entries, release artifacts and qualification reports belong to the previous experimental product. Their original history is preserved in the [Git repository](https://github.com/0xPlayerOne/bun-native/commits/main/) and historical tags. They are not Bun Native release qualifications.
