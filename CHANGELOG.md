# Changelog

## [0.32.1](https://github.com/0xPlayerOne/bun-native/compare/v0.32.0...v0.32.1) (2026-11-11)


### Maintenance

* **scripts:** stop exporting symbols nothing imports ([#623](https://github.com/0xPlayerOne/bun-native/issues/623)) ([1b15191](https://github.com/0xPlayerOne/bun-native/commit/1b15191056401f3fa3fb157b2ac438746ae76992)), closes [#260](https://github.com/0xPlayerOne/bun-native/issues/260)

## [0.32.0](https://github.com/0xPlayerOne/bun-native/compare/v0.31.1...v0.32.0) (2026-11-10)


### Features

* **menus, dialogs:** macOS NSAlert sheets and OS context menus on macOS and Windows ([#239](https://github.com/0xPlayerOne/bun-native/issues/239)) ([#592](https://github.com/0xPlayerOne/bun-native/issues/592)) ([7da818c](https://github.com/0xPlayerOne/bun-native/commit/7da818c55f72e309f852a95cc73d670e332605b7))
* **processes:** per-executable limits; Windows fault containment and a self-confirming installed update ([#618](https://github.com/0xPlayerOne/bun-native/issues/618)) ([2de2d2a](https://github.com/0xPlayerOne/bun-native/commit/2de2d2af8b322f2ab674ad4653aaeb5efa0c8a5e))


### Bug Fixes

* **ci:** CodeQL inside Validation, release after main's own Validation, oxlint 1.92 pins ([#616](https://github.com/0xPlayerOne/bun-native/issues/616)) ([da18b29](https://github.com/0xPlayerOne/bun-native/commit/da18b29f5cf443278d2eac828d924c3b6e22ebb9))


### Maintenance

* **deps:** bump taiki-e/install-action ([#612](https://github.com/0xPlayerOne/bun-native/issues/612)) ([2f76e68](https://github.com/0xPlayerOne/bun-native/commit/2f76e68e623846b25394c8dd7645c489512f3051))

## [0.31.1](https://github.com/0xPlayerOne/bun-native/compare/v0.31.0...v0.31.1) (2026-11-10)


### Bug Fixes

* **quality:** fold the eight open [#260](https://github.com/0xPlayerOne/bun-native/issues/260) audit drafts into one batch ([#609](https://github.com/0xPlayerOne/bun-native/issues/609)) ([797ad46](https://github.com/0xPlayerOne/bun-native/commit/797ad4651dd096fbb43132e746ca5f8a3bfeda7b))

## [0.31.0](https://github.com/0xPlayerOne/bun-native/compare/v0.30.0...v0.31.0) (2026-11-10)


### Features

* app-reported update health; React workspace runs the shared shell ([#604](https://github.com/0xPlayerOne/bun-native/issues/604)) ([ee7f64f](https://github.com/0xPlayerOne/bun-native/commit/ee7f64f5ab7ca9552901c23e4954d4fbb945c0a9))


### Performance

* **ci:** shard macOS/Windows native jobs; classifier and Gate on standard runners ([#606](https://github.com/0xPlayerOne/bun-native/issues/606)) ([a024a35](https://github.com/0xPlayerOne/bun-native/commit/a024a3574e9f623fea6bb6d4a584755a6dc1f35e))

## [0.30.0](https://github.com/0xPlayerOne/bun-native/compare/v0.29.0...v0.30.0) (2026-11-10)


### Features

* **accessibility:** assistive-technology requests, character bounds and modal hiding ([#241](https://github.com/0xPlayerOne/bun-native/issues/241)) ([#595](https://github.com/0xPlayerOne/bun-native/issues/595)) ([2d7f647](https://github.com/0xPlayerOne/bun-native/commit/2d7f647cece444ca5ed832414737f45012bc7c00))
* verified update launcher and keyed-signing CLI; drag close test ([#600](https://github.com/0xPlayerOne/bun-native/issues/600)) ([cfc413a](https://github.com/0xPlayerOne/bun-native/commit/cfc413ad3034684f60eee1f632049b2fe9b113db)), closes [#249](https://github.com/0xPlayerOne/bun-native/issues/249)


### Performance

* **ci:** compile only each Linux shard's AOT entries and rebalance shards ([#605](https://github.com/0xPlayerOne/bun-native/issues/605)) ([5bb3b46](https://github.com/0xPlayerOne/bun-native/commit/5bb3b461e1147941fc2ab873f195fcac301161b9))
* **ci:** shard Native Linux, fold duplicate jobs, skip GPUI suites on docs-only PRs ([#601](https://github.com/0xPlayerOne/bun-native/issues/601)) ([a46d55a](https://github.com/0xPlayerOne/bun-native/commit/a46d55a2678db2ccec33bdea5a6d6bd542b75fc5))


### Tests

* **wayland:** IME composition and editing through the compositor ([#241](https://github.com/0xPlayerOne/bun-native/issues/241)) ([#603](https://github.com/0xPlayerOne/bun-native/issues/603)) ([40fd380](https://github.com/0xPlayerOne/bun-native/commit/40fd380d4b48658351509ebf11ab34070d0fb5c1))

## [0.29.0](https://github.com/0xPlayerOne/bun-native/compare/v0.28.0...v0.29.0) (2026-11-10)


### Features

* **react-workspace:** in-app clear confirmation, keyboard focus and Windows run ([#591](https://github.com/0xPlayerOne/bun-native/issues/591)) ([be0562e](https://github.com/0xPlayerOne/bun-native/commit/be0562ea202ddff7f8088372ae23fc7c252fec1c))
* **solid-workspace:** run a real shell in the workspace terminal pane ([#589](https://github.com/0xPlayerOne/bun-native/issues/589)) ([5543675](https://github.com/0xPlayerOne/bun-native/commit/5543675e2a40bcb11f4e79104c82cc230c9b9707))


### Documentation

* public API reference and version/support policy ([#598](https://github.com/0xPlayerOne/bun-native/issues/598)) ([40ada93](https://github.com/0xPlayerOne/bun-native/commit/40ada93c8174dfe62b7b77edad73a411fdb2c0ee))
* Solid and React walkthroughs and a 0.27.2 compatibility matrix ([#590](https://github.com/0xPlayerOne/bun-native/issues/590)) ([d82f103](https://github.com/0xPlayerOne/bun-native/commit/d82f103273dbc33c0e8870c1bc9f1f62c0d893d7))


### Tests

* **processes:** wait for the acknowledgement failure before shutdown ([#594](https://github.com/0xPlayerOne/bun-native/issues/594)) ([de6425e](https://github.com/0xPlayerOne/bun-native/commit/de6425ef727e720f1f1aa1ddb3cc3b85e39d17be))
* **workspaces:** React long-session soak and the Solid workspace on Windows ([#593](https://github.com/0xPlayerOne/bun-native/issues/593)) ([b974d67](https://github.com/0xPlayerOne/bun-native/commit/b974d673acb021f0dff6d9eccfe3e8ea215db770)), closes [#248](https://github.com/0xPlayerOne/bun-native/issues/248)

## [0.28.0](https://github.com/0xPlayerOne/bun-native/compare/v0.27.2...v0.28.0) (2026-11-10)


### Features

* **macos:** qualify native Solid and React workspaces ([#582](https://github.com/0xPlayerOne/bun-native/issues/582)) ([e456a6d](https://github.com/0xPlayerOne/bun-native/commit/e456a6d2f65f8771b663a7fb8f3a6026ce0a9a54))

## [0.27.2](https://github.com/0xPlayerOne/bun-native/compare/v0.27.1...v0.27.2) (2026-11-09)


### Maintenance

* **deps:** bump ruff from 0.17.3 to 0.17.4 in /scripts/quality ([#575](https://github.com/0xPlayerOne/bun-native/issues/575)) ([bbd375b](https://github.com/0xPlayerOne/bun-native/commit/bbd375bceaaa2348e963f88a52da86d85bed36d0))
* **deps:** bump taiki-e/install-action ([#576](https://github.com/0xPlayerOne/bun-native/issues/576)) ([bcc2661](https://github.com/0xPlayerOne/bun-native/commit/bcc2661bd050f252ea56bc0e3b26408a6e63a27c))

## [0.27.1](https://github.com/0xPlayerOne/bun-native/compare/v0.27.0...v0.27.1) (2026-11-08)


### Maintenance

* **ci:** move to Code Foundry 1.54.0 ([#569](https://github.com/0xPlayerOne/bun-native/issues/569)) ([9e8b032](https://github.com/0xPlayerOne/bun-native/commit/9e8b0328bc94974e91871948daf22cb4706e4f95))

## [0.27.0](https://github.com/0xPlayerOne/bun-native/compare/v0.26.0...v0.27.0) (2026-11-08)


### Features

* **examples:** port Adea Button, Input, DropdownMenu, Dialog and conversation view ([#566](https://github.com/0xPlayerOne/bun-native/issues/566)) ([e848d5a](https://github.com/0xPlayerOne/bun-native/commit/e848d5a149a6f123d5e57865a6ea11e33abafc00))

## [0.26.0](https://github.com/0xPlayerOne/bun-native/compare/v0.25.2...v0.26.0) (2026-11-08)


### Features

* **quality:** gate benchmark runs against hosted baselines; duplicate-dependency and code-health checks ([#563](https://github.com/0xPlayerOne/bun-native/issues/563)) ([b0e5c42](https://github.com/0xPlayerOne/bun-native/commit/b0e5c421597ee5bf99e7eb1fe6e42f5981276640))

## [0.25.2](https://github.com/0xPlayerOne/bun-native/compare/v0.25.1...v0.25.2) (2026-11-08)


### Bug Fixes

* **quality:** escape metric metadata in Markdown regression summaries ([#562](https://github.com/0xPlayerOne/bun-native/issues/562)) ([922c190](https://github.com/0xPlayerOne/bun-native/commit/922c1905a5c2105d800f187bc4c5b51290c7e057))
* **quality:** validate direct comparison metrics and headers ([#259](https://github.com/0xPlayerOne/bun-native/issues/259)) ([#561](https://github.com/0xPlayerOne/bun-native/issues/561)) ([45072ae](https://github.com/0xPlayerOne/bun-native/commit/45072aef6f3ab9d9dbaec71f32a8ab4cfef670af))

## [0.25.1](https://github.com/0xPlayerOne/bun-native/compare/v0.25.0...v0.25.1) (2026-11-07)


### Bug Fixes

* **build:** reproducible Windows host builds (/Brepro) and gate Windows ([#559](https://github.com/0xPlayerOne/bun-native/issues/559)) ([8e44362](https://github.com/0xPlayerOne/bun-native/commit/8e443620bbfaab91170993effa434090d34048d7))

## [0.25.0](https://github.com/0xPlayerOne/bun-native/compare/v0.24.0...v0.25.0) (2026-11-07)


### Features

* **benchmarks:** direct Rust GPUI baseline for the matched workload ([#557](https://github.com/0xPlayerOne/bun-native/issues/557)) ([36fa134](https://github.com/0xPlayerOne/bun-native/commit/36fa134bdeb9bb0ec5afc39b08cf0e33c442715c))

## [0.24.0](https://github.com/0xPlayerOne/bun-native/compare/v0.23.1...v0.24.0) (2026-11-07)


### Features

* **quality:** cross-runner host reproducibility, CPU and cold-cache benchmark metrics, quality-gate fixes ([#555](https://github.com/0xPlayerOne/bun-native/issues/555)) ([e292249](https://github.com/0xPlayerOne/bun-native/commit/e292249cab5fd8bfb6e102ea041e2b5e488c82cf))


### Documentation

* **validation:** real-machine runbook; resolve Windows drops beneath drive roots in the drag fixture ([#554](https://github.com/0xPlayerOne/bun-native/issues/554)) ([24936fb](https://github.com/0xPlayerOne/bun-native/commit/24936fbfbb1d90622d7a6db45d2ca0ec837681fd))

## [0.23.1](https://github.com/0xPlayerOne/bun-native/compare/v0.23.0...v0.23.1) (2026-11-06)


### Tests

* **quality:** documented-command smoke test and fail-closed metric regression gate ([#546](https://github.com/0xPlayerOne/bun-native/issues/546)) ([6644ab8](https://github.com/0xPlayerOne/bun-native/commit/6644ab8309bb68e39efca1c0f8a929e9325c8f97))

## [0.23.0](https://github.com/0xPlayerOne/bun-native/compare/v0.22.0...v0.23.0) (2026-11-06)


### Features

* **processes:** macOS working directory and Windows pipe interrupt ([#305](https://github.com/0xPlayerOne/bun-native/issues/305)) ([#549](https://github.com/0xPlayerOne/bun-native/issues/549)) ([d780275](https://github.com/0xPlayerOne/bun-native/commit/d780275db3fd3514cefa286ce19785e17c700878))

## [0.22.0](https://github.com/0xPlayerOne/bun-native/compare/v0.21.0...v0.22.0) (2026-11-06)


### Features

* **windows:** OS message dialogs through TaskDialogIndirect ([#239](https://github.com/0xPlayerOne/bun-native/issues/239)) ([#547](https://github.com/0xPlayerOne/bun-native/issues/547)) ([f27fbc0](https://github.com/0xPlayerOne/bun-native/commit/f27fbc00eabe18b74faa86c6255c77e9edf8ddf0))

## [0.21.0](https://github.com/0xPlayerOne/bun-native/compare/v0.20.3...v0.21.0) (2026-11-06)


### Features

* **native:** React delete confirmation, IBus Hangul IME qualification, launcher-stream diagnostics ([#545](https://github.com/0xPlayerOne/bun-native/issues/545)) ([12eb250](https://github.com/0xPlayerOne/bun-native/commit/12eb2502e32741ef716799af94693316a8370fb6))


### Tests

* **macOS:** capture live target on missing AOT drag entry ([#538](https://github.com/0xPlayerOne/bun-native/issues/538)) ([0e46527](https://github.com/0xPlayerOne/bun-native/commit/0e465273fd89f0459db7d2e87f2ea2bb8f3b2589))

## [0.20.3](https://github.com/0xPlayerOne/bun-native/compare/v0.20.2...v0.20.3) (2026-11-06)


### Bug Fixes

* close API, Rust and doc oddities found in the docs review ([#527](https://github.com/0xPlayerOne/bun-native/issues/527)) ([49ca23c](https://github.com/0xPlayerOne/bun-native/commit/49ca23cc9d4378b0d4a19e99318001aec8ac2000))


### Documentation

* **release:** preserve open investigations in v0.20.0 notes ([#524](https://github.com/0xPlayerOne/bun-native/issues/524)) ([3d54198](https://github.com/0xPlayerOne/bun-native/commit/3d54198d23803c4643d0fabba35913e2416c6ab2))


### Tests

* compare a second display read however long the first takes ([#539](https://github.com/0xPlayerOne/bun-native/issues/539)) ([609da07](https://github.com/0xPlayerOne/bun-native/commit/609da07eb8e80a06c6a1b1b990024281d8bab516))
* fix the offline AOT report capture and the macOS display and drag oracles ([#533](https://github.com/0xPlayerOne/bun-native/issues/533)) ([462c547](https://github.com/0xPlayerOne/bun-native/commit/462c54701fda010e5f3960554ef13eba29eb831c))
* press the Wayland button only after the window sees the pointer on it ([#542](https://github.com/0xPlayerOne/bun-native/issues/542)) ([8a2252c](https://github.com/0xPlayerOne/bun-native/commit/8a2252cc064a87ae8eda091fd8a9b97e2242680a))
* read only complete native evidence lines and report Wayland click failures ([#536](https://github.com/0xPlayerOne/bun-native/issues/536)) ([8390d0d](https://github.com/0xPlayerOne/bun-native/commit/8390d0d9b1bacf243edafc5c74d5f4ac35bc913a))
* record the Wayland pointer path when the compositor click is missed ([#537](https://github.com/0xPlayerOne/bun-native/issues/537)) ([207385b](https://github.com/0xPlayerOne/bun-native/commit/207385bb2a82a1a3d3ab1594d132e8e2d6973b95))
* treat a process that exits during the watch image read as gone ([#540](https://github.com/0xPlayerOne/bun-native/issues/540)) ([3be4a32](https://github.com/0xPlayerOne/bun-native/commit/3be4a3235243b3a33b1568689ebc233cea6ec324))

## [0.20.2](https://github.com/0xPlayerOne/bun-native/compare/v0.20.1...v0.20.2) (2026-11-06)


### Tests

* macOS qualification on a physical Mac ([#247](https://github.com/0xPlayerOne/bun-native/issues/247) [#223](https://github.com/0xPlayerOne/bun-native/issues/223) [#244](https://github.com/0xPlayerOne/bun-native/issues/244) [#249](https://github.com/0xPlayerOne/bun-native/issues/249) [#297](https://github.com/0xPlayerOne/bun-native/issues/297)) ([#521](https://github.com/0xPlayerOne/bun-native/issues/521)) ([453dba4](https://github.com/0xPlayerOne/bun-native/commit/453dba48ccf7f0ff904a4f8fcbec990f340ef910))

## [0.20.1](https://github.com/0xPlayerOne/bun-native/compare/v0.20.0...v0.20.1) (2026-11-06)


### Performance

* audit batch 5 (typed batch decode, trie-diff node index, incremental evidence parsing) ([#518](https://github.com/0xPlayerOne/bun-native/issues/518)) ([40ea121](https://github.com/0xPlayerOne/bun-native/commit/40ea121d6cdc8746d53feb6b41df11cd0e792874))

## [0.20.0](https://github.com/0xPlayerOne/bun-native/compare/v0.19.0...v0.20.0) (2026-11-06)


### Features

* **bench:** equivalent-workload Solid/React/core dev vs AOT comparison harness ([#453](https://github.com/0xPlayerOne/bun-native/issues/453)) ([520aed7](https://github.com/0xPlayerOne/bun-native/commit/520aed710db1f12784ce2d759ef96f6e31fbfde8))
* BN5-BN7 batch (updates/rollback, installers, crash diagnostics, reload memory, React plan streaming, Solid workspace soak, CLI check/format/doctor, release readiness, reproducible builds incl. host, bench CI, bridge phase trace) ([#483](https://github.com/0xPlayerOne/bun-native/issues/483)) ([7cecc86](https://github.com/0xPlayerOne/bun-native/commit/7cecc86972d1d21b0c94b7b9b484b95f3f5d05b6))
* **quality:** record WM close requests and modified key downs ([#358](https://github.com/0xPlayerOne/bun-native/issues/358)) ([#425](https://github.com/0xPlayerOne/bun-native/issues/425)) ([a4b0628](https://github.com/0xPlayerOne/bun-native/commit/a4b062867bb3814d31d1bd17d1e7b12716d14827))
* **services:** scoped filesystem grants on launch roots ([#304](https://github.com/0xPlayerOne/bun-native/issues/304)) ([#427](https://github.com/0xPlayerOne/bun-native/issues/427)) ([cbcced7](https://github.com/0xPlayerOne/bun-native/commit/cbcced75b4458c2bb336f4f7806a5ce2258e7336))


### Bug Fixes

* **ci:** run React development calibration without DFG ([#423](https://github.com/0xPlayerOne/bun-native/issues/423)) ([15344d5](https://github.com/0xPlayerOne/bun-native/commit/15344d56d8cc0cd9662061f6b9a95a13a68fb79e)), refs [#287](https://github.com/0xPlayerOne/bun-native/issues/287)
* **core:** commit transactions above the native batch limit in staged batches ([#512](https://github.com/0xPlayerOne/bun-native/issues/512)) ([0b389b4](https://github.com/0xPlayerOne/bun-native/commit/0b389b4b1e6cd3af9c518c1473088209453514a4))
* **quality:** settle Linux test sessions and capture screenshots in-process ([#487](https://github.com/0xPlayerOne/bun-native/issues/487)) ([66d7ff0](https://github.com/0xPlayerOne/bun-native/commit/66d7ff004b4408d22a38c9062b29ee694db64d6c))


### Performance

* audit batch 2 (batch-sized core transactions, renderer moves and removals, React adapter, native event path) ([#503](https://github.com/0xPlayerOne/bun-native/issues/503)) ([35a1fce](https://github.com/0xPlayerOne/bun-native/commit/35a1fce6f0dd374b26a61697df566c8b2776b2c4))
* audit batch 3 (renderer moved subtrees, shared test peers, React CLI build, host dependency cleanup) ([#513](https://github.com/0xPlayerOne/bun-native/issues/513)) ([822086b](https://github.com/0xPlayerOne/bun-native/commit/822086be5c5740a65edd83b1a03190cba2a52794))
* audit batch 4 (React inline-style skip, install/digest/package hashing, protocol/events/workspace benchmarks) ([#516](https://github.com/0xPlayerOne/bun-native/issues/516)) ([edcca8d](https://github.com/0xPlayerOne/bun-native/commit/edcca8d0678059afa15b5f5c9c03aeb1b51ccbd0))
* **ci:** reuse hash-verified apt archives for the Native Linux prerequisites ([#474](https://github.com/0xPlayerOne/bun-native/issues/474)) ([8052aa4](https://github.com/0xPlayerOne/bun-native/commit/8052aa4aad79ad71a19857e81f8de2f46f44f875))
* combined audit batch (core, renderer, Solid, native protocol and host, CI cache) ([#480](https://github.com/0xPlayerOne/bun-native/issues/480)) ([dd6807f](https://github.com/0xPlayerOne/bun-native/commit/dd6807fcfb60162a0617f71edf63598d1e4daa4b))
* **native:** share tree child lists and render labels without copies ([#435](https://github.com/0xPlayerOne/bun-native/issues/435)) ([d1e5f0a](https://github.com/0xPlayerOne/bun-native/commit/d1e5f0a0f5df1933434c29e987865d593c7f3253))
* **protocol:** avoid copies and encodes on the frame and text hot paths ([#429](https://github.com/0xPlayerOne/bun-native/issues/429)) ([53c414c](https://github.com/0xPlayerOne/bun-native/commit/53c414cbb0df62a2d0a6caec7ebfe9286843baf5))


### Documentation

* align native contract docs with current code ([#439](https://github.com/0xPlayerOne/bun-native/issues/439)) ([741d513](https://github.com/0xPlayerOne/bun-native/commit/741d513d54b3aff28a7cab746134b9e90e7e5a34))


### Tests

* **solid:** enforce the JSX plugin Babel peer and bot major exclusion ([#430](https://github.com/0xPlayerOne/bun-native/issues/430)) ([3863459](https://github.com/0xPlayerOne/bun-native/commit/3863459588378532a4af4fb27188f051fa0955df)), refs [#316](https://github.com/0xPlayerOne/bun-native/issues/316)


### CI

* cache Windows protocol dependency builds and skip the AOT jobs' Rust install ([#514](https://github.com/0xPlayerOne/bun-native/issues/514)) ([fe4e799](https://github.com/0xPlayerOne/bun-native/commit/fe4e7995ffe904e6c1b327a4a505833447164415))
* fail the required gate on draft runs instead of skipping it ([#456](https://github.com/0xPlayerOne/bun-native/issues/456)) ([d37c9cf](https://github.com/0xPlayerOne/bun-native/commit/d37c9cfefd4e65f748fd1c1d5fb2d05d4214a31d))
* **linux:** keep compiled service fixtures out of the evidence artifact ([#511](https://github.com/0xPlayerOne/bun-native/issues/511)) ([1741eaa](https://github.com/0xPlayerOne/bun-native/commit/1741eaa1ec9187d53ce426a24741cee5172d4b89))
* **linux:** read the software GPU driver into the page cache before the first open ([#442](https://github.com/0xPlayerOne/bun-native/issues/442)) ([4dbc1d7](https://github.com/0xPlayerOne/bun-native/commit/4dbc1d7e64cbf34bc7085868b7d22393446a7fac)), refs [#296](https://github.com/0xPlayerOne/bun-native/issues/296)

## [0.19.0](https://github.com/0xPlayerOne/bun-native/compare/v0.18.0...v0.19.0) (2026-11-05)


### Features

* **host:** split first-window GPU instance setup in the startup trace ([#296](https://github.com/0xPlayerOne/bun-native/issues/296)) ([#421](https://github.com/0xPlayerOne/bun-native/issues/421)) ([2008f52](https://github.com/0xPlayerOne/bun-native/commit/2008f52088065e03007dd8c2d1dea04d872b1755))
* **services:** owned freedesktop desktop notifications ([#302](https://github.com/0xPlayerOne/bun-native/issues/302)) ([#424](https://github.com/0xPlayerOne/bun-native/issues/424)) ([741a360](https://github.com/0xPlayerOne/bun-native/commit/741a36027952719dfe9fdac56569a303fdc8efd5))

## [0.18.0](https://github.com/0xPlayerOne/bun-native/compare/v0.17.3...v0.18.0) (2026-11-05)


### Features

* **quality:** sample owned threads and WM state after a failed OS close ([#419](https://github.com/0xPlayerOne/bun-native/issues/419)) ([e02edb0](https://github.com/0xPlayerOne/bun-native/commit/e02edb00538a2be0fd5f93a1b12ce42716358c02))
* **services:** owned X11 global shortcuts ([#301](https://github.com/0xPlayerOne/bun-native/issues/301)) ([#422](https://github.com/0xPlayerOne/bun-native/issues/422)) ([1c42a4b](https://github.com/0xPlayerOne/bun-native/commit/1c42a4b04ca0fd250b61f1dac9f4f3fcac25b0df))


### Tests

* run collectability checks without the JSC DFG tier ([#287](https://github.com/0xPlayerOne/bun-native/issues/287)) ([#418](https://github.com/0xPlayerOne/bun-native/issues/418)) ([c9dc027](https://github.com/0xPlayerOne/bun-native/commit/c9dc027b8350b740722a6c75d9d80440675a4b30))

## [0.17.3](https://github.com/0xPlayerOne/bun-native/compare/v0.17.2...v0.17.3) (2026-11-05)


### Bug Fixes

* **input:** keep the native caret inside a horizontal viewport ([#377](https://github.com/0xPlayerOne/bun-native/issues/377)) ([90304c9](https://github.com/0xPlayerOne/bun-native/commit/90304c9b0f6f59165b34cca811ab31079f5a6adb))

## [0.17.2](https://github.com/0xPlayerOne/bun-native/compare/v0.17.1...v0.17.2) (2026-11-05)


### Bug Fixes

* **renderer:** preserve the first reported initialization failure ([#415](https://github.com/0xPlayerOne/bun-native/issues/415)) ([85f6d1c](https://github.com/0xPlayerOne/bun-native/commit/85f6d1cbc571ac21dff4bad983beebaae7e521c9))


### Tests

* **toolchain:** make exact command output independent of forced color ([#416](https://github.com/0xPlayerOne/bun-native/issues/416)) ([764b50d](https://github.com/0xPlayerOne/bun-native/commit/764b50d09cc8bb06be1b0f1c2336d5d21f83ae7d))


### CI

* schedule protected-main native audits ([#396](https://github.com/0xPlayerOne/bun-native/issues/396)) ([1f012e9](https://github.com/0xPlayerOne/bun-native/commit/1f012e979f8ac0c515ec82a926a0382957c27e13))

## [0.17.1](https://github.com/0xPlayerOne/bun-native/compare/v0.17.0...v0.17.1) (2026-11-05)


### Bug Fixes

* **native:** release EGL construction resources and per-owner pbuffers ([#374](https://github.com/0xPlayerOne/bun-native/issues/374)) ([b1ab723](https://github.com/0xPlayerOne/bun-native/commit/b1ab72388f7c0ee89cd5365b1b0481d42ca33892))
* **renderer:** revoke terminal React callbacks and shared cleanup registration ([#331](https://github.com/0xPlayerOne/bun-native/issues/331)) ([3d60575](https://github.com/0xPlayerOne/bun-native/commit/3d60575be79282f9a517781b80de3e27a882562a))


### Documentation

* **services:** qualify native display foundation and Linux clipboard ([#353](https://github.com/0xPlayerOne/bun-native/issues/353)) ([64b8be1](https://github.com/0xPlayerOne/bun-native/commit/64b8be18969f76f311d1a86a90c3c8b25b1229ef))

## [0.17.0](https://github.com/0xPlayerOne/bun-native/compare/v0.16.1...v0.17.0) (2026-11-05)


### Features

* **cli:** create standalone projects from pinned local packages ([#388](https://github.com/0xPlayerOne/bun-native/issues/388)) ([6c67e74](https://github.com/0xPlayerOne/bun-native/commit/6c67e748e79945e85ad5776b8796685be335b5e0))


### Bug Fixes

* **cli:** fingerprint imported sources and safely publish qualification evidence ([#384](https://github.com/0xPlayerOne/bun-native/issues/384)) ([d19ce0c](https://github.com/0xPlayerOne/bun-native/commit/d19ce0cafed7e9af0ed81d723d12e7125289e990))


### Documentation

* refresh accepted compatibility scope ([#404](https://github.com/0xPlayerOne/bun-native/issues/404)) ([e7605a6](https://github.com/0xPlayerOne/bun-native/commit/e7605a62c641b360ee59394d693f1d2d5d5979fa))


### Tests

* **native:** qualify Solid and React on hosted platforms ([#399](https://github.com/0xPlayerOne/bun-native/issues/399)) ([8192d69](https://github.com/0xPlayerOne/bun-native/commit/8192d693b846f0e232add212ba78b32cd7b2240d))

## [0.16.1](https://github.com/0xPlayerOne/bun-native/compare/v0.16.0...v0.16.1) (2026-11-04)


### Documentation

* record verified hosted native platform coverage ([6b4a775](https://github.com/0xPlayerOne/bun-native/commit/6b4a775b139e4a40c802b54614f0ae80dfcb6142))

## [0.16.0](https://github.com/0xPlayerOne/bun-native/compare/v0.15.0...v0.16.0) (2026-11-04)


### Features

* **cli:** deliver native templates and joined watch remounts ([#360](https://github.com/0xPlayerOne/bun-native/issues/360)) ([77c842f](https://github.com/0xPlayerOne/bun-native/commit/77c842faa3137e8155b24c1d123d16c1ed5b76ed))


### Bug Fixes

* **benchmarks:** bind shared workload oracle in source manifests ([#379](https://github.com/0xPlayerOne/bun-native/issues/379)) ([c9ba430](https://github.com/0xPlayerOne/bun-native/commit/c9ba430d2100841ff7c336bd4cad33a4bc4bcdf4))

## [0.15.0](https://github.com/0xPlayerOne/bun-native/compare/v0.14.4...v0.15.0) (2026-11-04)


### Features

* **macos:** report the native window's assigned Metal device ([#356](https://github.com/0xPlayerOne/bun-native/issues/356)) ([3f3d849](https://github.com/0xPlayerOne/bun-native/commit/3f3d84904a106e9147ccbd5e7bfa4e52065d83ed))
* **quality:** audit production source reachability and internal exports ([#351](https://github.com/0xPlayerOne/bun-native/issues/351)) ([07d3c9e](https://github.com/0xPlayerOne/bun-native/commit/07d3c9ed5d5cbb2260158eaf4918917fe010fe77))
* **react:** add a native workspace reference and root sizing ([#354](https://github.com/0xPlayerOne/bun-native/issues/354)) ([8b9e379](https://github.com/0xPlayerOne/bun-native/commit/8b9e3793fac93edc422d72be8d44914444630d99))
* **solid:** add native conversation workspace and coherent paint evidence ([b1a7e53](https://github.com/0xPlayerOne/bun-native/commit/b1a7e5336e3c5a7bb992349ea064b6d87b0cee85))


### Tests

* **native:** preserve OS-close failure and trace shutdown boundaries ([#361](https://github.com/0xPlayerOne/bun-native/issues/361)) ([d083ecb](https://github.com/0xPlayerOne/bun-native/commit/d083ecbce4b2d045cf70a39130f49379d42469a4))


### CI

* **codeql:** include Python native tooling in language detection ([#362](https://github.com/0xPlayerOne/bun-native/issues/362)) ([5b49755](https://github.com/0xPlayerOne/bun-native/commit/5b49755556136af89ec7941d5452b23fabb8037a))
* **linux:** record package-owned Mesa Lavapipe driver provenance ([#338](https://github.com/0xPlayerOne/bun-native/issues/338)) ([c9ada92](https://github.com/0xPlayerOne/bun-native/commit/c9ada928eb86ee44abeb85ba13721a68af0057d6))

## [0.14.4](https://github.com/0xPlayerOne/bun-native/compare/v0.14.3...v0.14.4) (2026-11-04)


### Bug Fixes

* **react:** release rejected commit reservations and revoke settled barriers ([#337](https://github.com/0xPlayerOne/bun-native/issues/337)) ([8aeacfe](https://github.com/0xPlayerOne/bun-native/commit/8aeacfeaac632e66c8a248e020cc26c2a46d88ef))

## [0.14.3](https://github.com/0xPlayerOne/bun-native/compare/v0.14.2...v0.14.3) (2026-11-04)


### Bug Fixes

* **core:** release listeners retained by revoked unsubscribe handles ([#341](https://github.com/0xPlayerOne/bun-native/issues/341)) ([aab3a4f](https://github.com/0xPlayerOne/bun-native/commit/aab3a4fa45b235ff213758bce8578ec17129f61c))

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
