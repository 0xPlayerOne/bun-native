# Changelog

## [0.14.2](https://github.com/0xPlayerOne/bun-native/compare/v0.14.1...v0.14.2) (2026-11-04)


### Bug Fixes

* **renderer:** revoke callbacks retained by window unsubscribe handles ([#334](https://github.com/0xPlayerOne/bun-native/issues/334)) ([bf38101](https://github.com/0xPlayerOne/bun-native/commit/bf38101ddbf3fc195b1c5d89de4ec52e6653848f))


### Tests

* **perf:** qualify fixed native allocation capture regions ([#315](https://github.com/0xPlayerOne/bun-native/issues/315)) ([3631bf7](https://github.com/0xPlayerOne/bun-native/commit/3631bf7467f373d8e4531f4f611fd9b7310551cd))

## [0.14.1](https://github.com/0xPlayerOne/bun-native/compare/v0.14.0...v0.14.1) (2026-11-04)


### Tests

* **native:** observe full GPUI paints while OS input commands run ([#289](https://github.com/0xPlayerOne/bun-native/issues/289)) ([634e7c0](https://github.com/0xPlayerOne/bun-native/commit/634e7c0a34dd55a38a85751cc2898c37bcfe3e65))

## [0.14.0](https://github.com/0xPlayerOne/bun-native/compare/v0.13.1...v0.14.0) (2026-11-04)


### Features

* **services:** qualify isolated bounded X11 clipboard ([#328](https://github.com/0xPlayerOne/bun-native/issues/328)) ([cfff93d](https://github.com/0xPlayerOne/bun-native/commit/cfff93db9e76ba904ecd6dbe731c036ee7ce23cd))

## [0.13.1](https://github.com/0xPlayerOne/bun-native/compare/v0.13.0...v0.13.1) (2026-11-04)


### Performance

* compare native bridge releases with predeclared paired runs ([#308](https://github.com/0xPlayerOne/bun-native/issues/308)) ([28cd933](https://github.com/0xPlayerOne/bun-native/commit/28cd9336aaa704010c715ade04d974b39b281c54))

## [0.13.0](https://github.com/0xPlayerOne/bun-native/compare/v0.12.2...v0.13.0) (2026-11-03)


### Features

* **react:** reconcile native trees with shared event phases and owned lifetimes ([#280](https://github.com/0xPlayerOne/bun-native/issues/280)) ([f2850ee](https://github.com/0xPlayerOne/bun-native/commit/f2850eebea6832e693894bcc772b2e48f1127bba))
* **services:** add owned display snapshots with explicit permissions ([#306](https://github.com/0xPlayerOne/bun-native/issues/306)) ([a8a194d](https://github.com/0xPlayerOne/bun-native/commit/a8a194dab1a5706fd5f9101e41b37213c36b6ea6))


### Bug Fixes

* **native:** qualify macOS redraw, runtime setup and exact AOT provenance ([#327](https://github.com/0xPlayerOne/bun-native/issues/327)) ([671dfaa](https://github.com/0xPlayerOne/bun-native/commit/671dfaaf814169dce7eb861c11f31a4f356bc64e))


### Tests

* **native:** drive owned windows with platform input and exact paint checks ([#291](https://github.com/0xPlayerOne/bun-native/issues/291)) ([71f516f](https://github.com/0xPlayerOne/bun-native/commit/71f516f4b45f7be45d3990d587805939a5999812))

## [0.12.2](https://github.com/0xPlayerOne/bun-native/compare/v0.12.1...v0.12.2) (2026-11-03)


### Bug Fixes

* **native:** accept completed smoke observation across process-exit race ([#319](https://github.com/0xPlayerOne/bun-native/issues/319)) ([c75d477](https://github.com/0xPlayerOne/bun-native/commit/c75d4777bd84176cbbce29e9520f657912c975b5))

## [0.12.1](https://github.com/0xPlayerOne/bun-native/compare/v0.12.0...v0.12.1) (2026-11-03)


### Bug Fixes

* **toolchain:** restore the pinned Bun compiler through official npm packages ([#314](https://github.com/0xPlayerOne/bun-native/issues/314)) ([0743e5b](https://github.com/0xPlayerOne/bun-native/commit/0743e5b3cd6d9de36a6abe4b5cacdd0c784fb3cd))


### Tests

* **native:** expose bounded GPUI startup logs ([#309](https://github.com/0xPlayerOne/bun-native/issues/309)) ([9abccca](https://github.com/0xPlayerOne/bun-native/commit/9abccca4342a32a44b0249d10020576444a66f61))

## [0.12.0](https://github.com/0xPlayerOne/bun-native/compare/v0.11.2...v0.12.0) (2026-10-31)


### Features

* **solid:** implement native renderer and shared protocol-4 event mapping ([#277](https://github.com/0xPlayerOne/bun-native/issues/277)) ([010db65](https://github.com/0xPlayerOne/bun-native/commit/010db65754ca9e54eca28e7701324e22b3c1f6c2))

## [0.11.2](https://github.com/0xPlayerOne/bun-native/compare/v0.11.1...v0.11.2) (2026-10-31)


### CI

* **native:** build and execute GPUI paint and lifecycle on macOS and Windows ([#288](https://github.com/0xPlayerOne/bun-native/issues/288)) ([afb47e1](https://github.com/0xPlayerOne/bun-native/commit/afb47e1ae322f9e7e7b97261752e0e33e78f7eb7))

## [0.11.1](https://github.com/0xPlayerOne/bun-native/compare/v0.11.0...v0.11.1) (2026-10-31)


### Bug Fixes

* **ci:** isolate draft events from ready native validation ([#293](https://github.com/0xPlayerOne/bun-native/issues/293)) ([0720276](https://github.com/0xPlayerOne/bun-native/commit/07202765b359221faae05098b2b9a2f6d014cd2f))

## [0.11.0](https://github.com/0xPlayerOne/bun-native/compare/v0.10.0...v0.11.0) (2026-10-31)


### Features

* **events:** add shared native keyboard, pointer and focus routing ([#285](https://github.com/0xPlayerOne/bun-native/issues/285)) ([2112325](https://github.com/0xPlayerOne/bun-native/commit/211232585378a13aef5b5786831062ac235da845))

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
