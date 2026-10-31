# Changelog

## [0.10.0](https://github.com/0xPlayerOne/bun-native/compare/v0.9.0...v0.10.0) (2026-10-31)


### Features

* **aot:** verify native compiler controls across Linux macOS and Windows ([#286](https://github.com/0xPlayerOne/bun-native/issues/286)) ([9355549](https://github.com/0xPlayerOne/bun-native/commit/9355549666bc9ac057fcc6cfd9b97a25c1dd9157))


### Documentation

* record verified BN1 release audit and retained evidence ([#282](https://github.com/0xPlayerOne/bun-native/issues/282)) ([df9eb12](https://github.com/0xPlayerOne/bun-native/commit/df9eb12d7ec28722580db447eeb7ca89a24996bb))

## [0.9.0](https://github.com/0xPlayerOne/bun-native/compare/v0.8.0...v0.9.0) (2026-10-31)


### Features

* **layout:** add native sizing scrolling and keyboard focus ([#281](https://github.com/0xPlayerOne/bun-native/issues/281)) ([6feec95](https://github.com/0xPlayerOne/bun-native/commit/6feec9553cd3547e7c7e214ebde247675d2212ca))


### Bug Fixes

* **ci:** authenticate pinned Bun downloads and retain bootstrap failures ([#284](https://github.com/0xPlayerOne/bun-native/issues/284)) ([e65357e](https://github.com/0xPlayerOne/bun-native/commit/e65357e4075b165715a6522076026c434791a56f))


### Tests

* **toolchain:** verify built-ins and genuine AOT despite package scripts ([#278](https://github.com/0xPlayerOne/bun-native/issues/278)) ([7f157fa](https://github.com/0xPlayerOne/bun-native/commit/7f157fa1c5c693adc149031d783169fcbeae6cbf))

## [0.8.0](https://github.com/0xPlayerOne/bun-native/compare/v0.7.0...v0.8.0) (2026-10-31)


### Features

* implement the shared native host and owned TS/JS application API ([#271](https://github.com/0xPlayerOne/bun-native/issues/271)) ([515c0bd](https://github.com/0xPlayerOne/bun-native/commit/515c0bda14ce4f40c0ddd1469a161315d03356a8))

## [0.7.0](https://github.com/0xPlayerOne/bun-native/compare/v0.6.12...v0.7.0) (2026-10-31)


### Features

* render an interactive GPUI window controlled by Bun ([#266](https://github.com/0xPlayerOne/bun-native/issues/266)) ([2c04f0e](https://github.com/0xPlayerOne/bun-native/commit/2c04f0ed991e8b5c5eecf56c9e07cbe3196e452c))


### Performance

* record release native baselines and complete the BN0 evidence audit ([#273](https://github.com/0xPlayerOne/bun-native/issues/273)) ([c7bcf4e](https://github.com/0xPlayerOne/bun-native/commit/c7bcf4e63906b97c9639c7a48ca4645d06aa98d2))

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
