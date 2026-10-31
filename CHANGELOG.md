# Changelog

## [0.6.12](https://github.com/0xPlayerOne/bun-native/compare/v0.6.11...v0.6.12) (2026-10-31)


### Maintenance

* replace Bunly with the Bun Native workspace ([#264](https://github.com/0xPlayerOne/bun-native/issues/264)) ([bc6b5fc](https://github.com/0xPlayerOne/bun-native/commit/bc6b5fc1f83a79fe264b79c80695b4f87d42617f))

## [0.6.11](https://github.com/0xPlayerOne/bun-native/compare/v0.6.10...v0.6.11) (2026-10-31)


### Bug Fixes

* **ci:** align docs formatting and tests with Bun Native rewrite ([#262](https://github.com/0xPlayerOne/bun-native/issues/262)) ([ee116b1](https://github.com/0xPlayerOne/bun-native/commit/ee116b19b6a5e097bd0b0f530115fc3931695228))

## [0.6.10](https://github.com/0xPlayerOne/bun-native/compare/v0.6.9...v0.6.10) (2026-10-31)


### Documentation

* replace Bunly documentation with Bun Native guides ([#216](https://github.com/0xPlayerOne/bun-native/issues/216)) ([7300768](https://github.com/0xPlayerOne/bun-native/commit/73007688639eeab21d309a4b6d330f8a037f4090))

## Bun Native changelog

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
