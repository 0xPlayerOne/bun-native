# Changelog

## [0.6.7](https://github.com/0xPlayerOne/bunly/compare/v0.6.6...v0.6.7) (2026-10-30)


### Bug Fixes

* **runtime:** observe asynchronous desktop listener failures ([#207](https://github.com/0xPlayerOne/bunly/issues/207)) ([f1de054](https://github.com/0xPlayerOne/bunly/commit/f1de0549bfa7facebe28c968e38ce0fe81881ef2))
* **workbench:** retain latest pane presentation during native requests ([#208](https://github.com/0xPlayerOne/bunly/issues/208)) ([9d3a500](https://github.com/0xPlayerOne/bunly/commit/9d3a50040052da9e3bb489e2f0632276f5673b10))

## [0.6.6](https://github.com/0xPlayerOne/bunly/compare/v0.6.5...v0.6.6) (2026-10-30)


### Documentation

* **m7:** retain download phase timing and watcher correction ([#205](https://github.com/0xPlayerOne/bunly/issues/205)) ([56bded0](https://github.com/0xPlayerOne/bunly/commit/56bded094499e03f7fa09fa9a27f230585c77440))

## [0.6.5](https://github.com/0xPlayerOne/bunly/compare/v0.6.4...v0.6.5) (2026-10-30)


### Bug Fixes

* **cli:** reconcile missed macOS dependency notifications ([#202](https://github.com/0xPlayerOne/bunly/issues/202)) ([a6e4a93](https://github.com/0xPlayerOne/bunly/commit/a6e4a93f75e6b80c67b8f528fc2f91fc5103faa5))


### Maintenance

* **m7:** retain native download timeout phase timings ([#201](https://github.com/0xPlayerOne/bunly/issues/201)) ([a5a3e4a](https://github.com/0xPlayerOne/bunly/commit/a5a3e4a3d3341c9b0ad4dd8a9b323222d6eba514))

## [0.6.4](https://github.com/0xPlayerOne/bunly/compare/v0.6.3...v0.6.4) (2026-10-30)


### Documentation

* **m7:** publish qualification status and composition evidence ([#199](https://github.com/0xPlayerOne/bunly/issues/199)) ([1e3bc4f](https://github.com/0xPlayerOne/bunly/commit/1e3bc4f1ede6fac13fc4935531e645c8d7c75701))

## [0.6.3](https://github.com/0xPlayerOne/bunly/compare/v0.6.2...v0.6.3) (2026-10-29)


### Bug Fixes

* **ci:** isolate Electrobun draft check name ([#197](https://github.com/0xPlayerOne/bunly/issues/197)) ([995d776](https://github.com/0xPlayerOne/bunly/commit/995d776b035b8588853ae1960b6e208afea89bdb))


### Documentation

* **m7:** record current Windows qualification evidence ([#192](https://github.com/0xPlayerOne/bunly/issues/192)) ([a784143](https://github.com/0xPlayerOne/bunly/commit/a784143ff0292dee996a58839d7857972664d78e))

## [0.6.2](https://github.com/0xPlayerOne/bunly/compare/v0.6.1...v0.6.2) (2026-10-29)


### Bug Fixes

* **runtime:** observe asynchronous event listener failures ([#189](https://github.com/0xPlayerOne/bunly/issues/189)) ([5c2c04e](https://github.com/0xPlayerOne/bunly/commit/5c2c04e8301bce731d2514125d19c29b50e8f3de))

## [0.6.1](https://github.com/0xPlayerOne/bunly/compare/v0.6.0...v0.6.1) (2026-10-29)


### Bug Fixes

* **runtime:** preserve application rollback failures ([#188](https://github.com/0xPlayerOne/bunly/issues/188)) ([5ba03c2](https://github.com/0xPlayerOne/bunly/commit/5ba03c2e12183ab9291c3dcb52ce68188456ee4d))

## [0.6.0](https://github.com/0xPlayerOne/bunly/compare/v0.5.8...v0.6.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **runtime:** exhaustive TerminalProcessExit and TerminalClosure failure handlers must handle SCHEDULER_FAILED.

### Bug Fixes

* **runtime:** report terminal lifecycle scheduler failures ([#186](https://github.com/0xPlayerOne/bunly/issues/186)) ([4de6619](https://github.com/0xPlayerOne/bunly/commit/4de66192e0ba17a3991f6a9e89d3b565f41a5f10))

## [0.5.8](https://github.com/0xPlayerOne/bunly/compare/v0.5.7...v0.5.8) (2026-10-29)


### Bug Fixes

* **runtime:** isolate application lifecycle listener rejections ([#185](https://github.com/0xPlayerOne/bunly/issues/185)) ([26b3869](https://github.com/0xPlayerOne/bunly/commit/26b3869f3c6b6ab7dffcb77062d3aca75c54bf60))

## [0.5.7](https://github.com/0xPlayerOne/bunly/compare/v0.5.6...v0.5.7) (2026-10-29)


### Bug Fixes

* **cli:** release prepared-host lock after cleanup failure ([#183](https://github.com/0xPlayerOne/bunly/issues/183)) ([b2eb4ce](https://github.com/0xPlayerOne/bunly/commit/b2eb4ce33559a4112273ecf5f2e0dddbbc49d15a))
* **rpc:** prevent reentrant request admission ([#181](https://github.com/0xPlayerOne/bunly/issues/181)) ([c77a9e8](https://github.com/0xPlayerOne/bunly/commit/c77a9e8663d1d503a9773a1bdf180205bd0dee4d))

## [0.5.6](https://github.com/0xPlayerOne/bunly/compare/v0.5.5...v0.5.6) (2026-10-29)


### Performance

* **artifacts:** bound archive path conflict checks ([#180](https://github.com/0xPlayerOne/bunly/issues/180)) ([65249aa](https://github.com/0xPlayerOne/bunly/commit/65249aa3e55374435808a619a798533919bb4def))


### Maintenance

* **ci:** retain native download inputs before qualification ([#184](https://github.com/0xPlayerOne/bunly/issues/184)) ([f27d34a](https://github.com/0xPlayerOne/bunly/commit/f27d34a201d64a6b7a9039ecd3fbcc10ac174c4b))

## [0.5.5](https://github.com/0xPlayerOne/bunly/compare/v0.5.4...v0.5.5) (2026-10-29)


### Bug Fixes

* **downloads:** reject Windows non-file destinations consistently ([#177](https://github.com/0xPlayerOne/bunly/issues/177)) ([a2f3368](https://github.com/0xPlayerOne/bunly/commit/a2f3368e4a52002a7de3d2f564e5a3f771d381e1))

## [0.5.4](https://github.com/0xPlayerOne/bunly/compare/v0.5.3...v0.5.4) (2026-10-29)


### Bug Fixes

* **downloads:** expose bounded native completion diagnostics ([#173](https://github.com/0xPlayerOne/bunly/issues/173)) ([2bc5bb9](https://github.com/0xPlayerOne/bunly/commit/2bc5bb94123ef99c738729b9749f479fc30a1089))

## [0.5.3](https://github.com/0xPlayerOne/bunly/compare/v0.5.2...v0.5.3) (2026-10-29)


### Tests

* **m7:** add descriptive windowed composition resource profile ([#172](https://github.com/0xPlayerOne/bunly/issues/172)) ([7092119](https://github.com/0xPlayerOne/bunly/commit/7092119db8a3bd484d0e7ccd802b988530042cfa))

## [0.5.2](https://github.com/0xPlayerOne/bunly/compare/v0.5.1...v0.5.2) (2026-10-29)


### Bug Fixes

* **m7:** avoid unused overlay observation polling ([#170](https://github.com/0xPlayerOne/bunly/issues/170)) ([7c75a6a](https://github.com/0xPlayerOne/bunly/commit/7c75a6a177bb904a5903151b23e664d4ea87afd1))

## [0.5.1](https://github.com/0xPlayerOne/bunly/compare/v0.5.0...v0.5.1) (2026-10-29)


### Documentation

* **m7:** consolidate desktop capabilities and qualification evidence ([#159](https://github.com/0xPlayerOne/bunly/issues/159)) ([c39f207](https://github.com/0xPlayerOne/bunly/commit/c39f207f6134a60d2a3d1173b36d04fa1e2203f4))

## [0.5.0](https://github.com/0xPlayerOne/bunly/compare/v0.4.1...v0.5.0) (2026-10-29)


### Features

* **runtime:** add bounded opt-in diagnostics observers ([#161](https://github.com/0xPlayerOne/bunly/issues/161)) ([1392a30](https://github.com/0xPlayerOne/bunly/commit/1392a302350723d3a9eca56aa4c614ba389d6c93))

## [0.4.1](https://github.com/0xPlayerOne/bunly/compare/v0.4.0...v0.4.1) (2026-10-29)


### Bug Fixes

* **cef:** bound best-effort console output ([#165](https://github.com/0xPlayerOne/bunly/issues/165)) ([d9beb8e](https://github.com/0xPlayerOne/bunly/commit/d9beb8e2a3dc67cca6aab361f557062fc38f06f4))

## [0.4.0](https://github.com/0xPlayerOne/bunly/compare/v0.3.0...v0.4.0) (2026-10-29)


### Features

* **workbench:** expose scoped native menu and file-dialog controls ([#162](https://github.com/0xPlayerOne/bunly/issues/162)) ([60b89c2](https://github.com/0xPlayerOne/bunly/commit/60b89c2a68b71447ecf12b56bad56c8341f6e70e))

## [0.3.0](https://github.com/0xPlayerOne/bunly/compare/v0.2.0...v0.3.0) (2026-10-29)


### Features

* **files:** add scoped native programmatic file interactions ([#143](https://github.com/0xPlayerOne/bunly/issues/143)) ([923014c](https://github.com/0xPlayerOne/bunly/commit/923014c9886bab511bc1d1c85d1eed0c4d98b5d1))


### Bug Fixes

* **test:** honor bounded session fixture cleanup retries ([#163](https://github.com/0xPlayerOne/bunly/issues/163)) ([d906112](https://github.com/0xPlayerOne/bunly/commit/d90611277ed65228c6f2a978e9b599527e921bc1))

## [0.2.0](https://github.com/0xPlayerOne/bunly/compare/v0.1.4...v0.2.0) (2026-10-29)


### Features

* **desktop:** add scoped application links and HTTPS submission ([#145](https://github.com/0xPlayerOne/bunly/issues/145)) ([3fc7ae0](https://github.com/0xPlayerOne/bunly/commit/3fc7ae0105bbdadb89ebf94049dff52857e36d8a))
* **desktop:** add scoped native macOS status items ([#142](https://github.com/0xPlayerOne/bunly/issues/142)) ([2815596](https://github.com/0xPlayerOne/bunly/commit/2815596ff63cddec224b51cf53a3ab2ddd8b9d24))

## [0.1.4](https://github.com/0xPlayerOne/bunly/compare/v0.1.3...v0.1.4) (2026-10-29)


### Bug Fixes

* **ci:** isolate draft runs and preserve benchmark failures ([#157](https://github.com/0xPlayerOne/bunly/issues/157)) ([49f3e08](https://github.com/0xPlayerOne/bunly/commit/49f3e0885942226d7ea89faeb999bb61bbecfc7e))

## [0.1.3](https://github.com/0xPlayerOne/bunly/compare/v0.1.2...v0.1.3) (2026-10-29)


### Bug Fixes

* **release:** create version pull requests as drafts ([#155](https://github.com/0xPlayerOne/bunly/issues/155)) ([6f4b2ca](https://github.com/0xPlayerOne/bunly/commit/6f4b2ca50efc09fc482fbbbc18352dc1a62431ff))

## [0.1.2](https://github.com/0xPlayerOne/bunly/compare/v0.1.1...v0.1.2) (2026-10-29)


### Bug Fixes

* **ci:** apply Code Foundry draft protection to PR checks ([#153](https://github.com/0xPlayerOne/bunly/issues/153)) ([775f162](https://github.com/0xPlayerOne/bunly/commit/775f162d2bdfea5f22a0675b9aa5acfd2480fbe7))

## [0.1.1](https://github.com/0xPlayerOne/bunly/compare/v0.1.0...v0.1.1) (2026-10-29)


### Bug Fixes

* **build:** isolate Cargo outputs by manifest directory ([#149](https://github.com/0xPlayerOne/bunly/issues/149)) ([dead07d](https://github.com/0xPlayerOne/bunly/commit/dead07dd2ae5ec63de5580f0342cb707b64371a3))

## 0.1.0 (2026-10-29)


### Features

* add bounded binary streams with consumer acknowledgements ([#67](https://github.com/0xPlayerOne/bunly/issues/67)) ([0bae09a](https://github.com/0xPlayerOne/bunly/commit/0bae09a669d24e960a63398e895446d7dcbded95))
* add browser build profiles and shared conformance scaffolding ([#91](https://github.com/0xPlayerOne/bunly/issues/91)) ([fe3171f](https://github.com/0xPlayerOne/bunly/commit/fe3171f96b363ec50f494d3a1057ca902eda3fdb))
* add kernel measurements, executable edit fixtures, and Electrobun CEF baseline ([#62](https://github.com/0xPlayerOne/bunly/issues/62)) ([eebc5fd](https://github.com/0xPlayerOne/bunly/commit/eebc5fd4f39eaba7ddf74d5bcb3a0d1614778bd0))
* add M2 workbench, validated benchmark reports, and lifecycle fault harness ([73067df](https://github.com/0xPlayerOne/bunly/commit/73067dffb33880e44cd6b639c8cc2de5d30646ae))
* add manual native cloud qualification and complete M3 ([#83](https://github.com/0xPlayerOne/bunly/issues/83)) ([3fc759f](https://github.com/0xPlayerOne/bunly/commit/3fc759f9d7e02220469ee86cfa8c3e97a4c03a28))
* **benchmarks:** add explicit native signing and post-sign accounting ([#74](https://github.com/0xPlayerOne/bunly/issues/74)) ([2204937](https://github.com/0xPlayerOne/bunly/commit/2204937da2875984976d49fb5730a3181b257206))
* **benchmarks:** add reference release runners and reliable observer cancellation ([#72](https://github.com/0xPlayerOne/bunly/issues/72)) ([ab7896e](https://github.com/0xPlayerOne/bunly/commit/ab7896ee1fb40a9d17dacbf0c1f99b0ca3cde114))
* **benchmarks:** integrate desktop edit workbench and measurement qualification ([#71](https://github.com/0xPlayerOne/bunly/issues/71)) ([e8722cd](https://github.com/0xPlayerOne/bunly/commit/e8722cd305d97904d01d22504e20287212636df9))
* **benchmarks:** verify first-run and update artifact transfer accounting ([#73](https://github.com/0xPlayerOne/bunly/issues/73)) ([3c67a84](https://github.com/0xPlayerOne/bunly/commit/3c67a84febaf85db49e9a93d4697f71ef223e890))
* **browser:** add scoped development browser actions ([#144](https://github.com/0xPlayerOne/bunly/issues/144)) ([b7c61d6](https://github.com/0xPlayerOne/bunly/commit/b7c61d6a0d30e6da31bdb0ed6fd9448e86ac2b8d))
* **cef:** qualify native window modes and reply-drained teardown ([#119](https://github.com/0xPlayerOne/bunly/issues/119)) ([0705bfc](https://github.com/0xPlayerOne/bunly/commit/0705bfcbbd589962569e90c79c79e261001709e1))
* complete M2 local benchmark closeout and WebKit accounting ([#77](https://github.com/0xPlayerOne/bunly/issues/77)) ([652b4aa](https://github.com/0xPlayerOne/bunly/commit/652b4aa91afb5cd51c364a2e1d9cbb81235481fa))
* complete M3 CEF lifecycle, verified acquisition, and packaged resources ([#78](https://github.com/0xPlayerOne/bunly/issues/78)) ([28c76a8](https://github.com/0xPlayerOne/bunly/commit/28c76a81715c84f9c2fe1b7b3ce1a829ad3d6042))
* **desktop:** add native view composition and qualification ([#133](https://github.com/0xPlayerOne/bunly/issues/133)) ([d8f83d8](https://github.com/0xPlayerOne/bunly/commit/d8f83d8eac71aba1bef6d6d1e5877a7523876cfb))
* **desktop:** add native window controls and qualification ([#132](https://github.com/0xPlayerOne/bunly/issues/132)) ([09aaeeb](https://github.com/0xPlayerOne/bunly/commit/09aaeeb32883945d49d614d5f22b6e439f7301ec))
* **desktop:** add scoped clipboard and application lifecycle ([#134](https://github.com/0xPlayerOne/bunly/issues/134)) ([feaf6a6](https://github.com/0xPlayerOne/bunly/commit/feaf6a674421d1d992360b9026ca5c4c11581c2b))
* **desktop:** add scoped native menus, shortcuts and dialogs ([#139](https://github.com/0xPlayerOne/bunly/issues/139)) ([b2203ce](https://github.com/0xPlayerOne/bunly/commit/b2203ce806837bca5a2a33445bf66b1fc2f79f6d))
* finish host qualification and implement the standalone CEF runtime ([#63](https://github.com/0xPlayerOne/bunly/issues/63)) ([3a50346](https://github.com/0xPlayerOne/bunly/commit/3a503462f446962c4041dfa62e81686457ed6737))
* implement bounded typed RPC and document-scoped authority ([#66](https://github.com/0xPlayerOne/bunly/issues/66)) ([8c353e6](https://github.com/0xPlayerOne/bunly/commit/8c353e671ee1b4ec043be918c577cf82917fba79))
* implement M1 Bunly foundation and native qualification harness ([d7f909f](https://github.com/0xPlayerOne/bunly/commit/d7f909f73737a05bf6917421455228073a50492a))
* **ipc:** bound native event output through write and shutdown completion ([#110](https://github.com/0xPlayerOne/bunly/issues/110)) ([652df1c](https://github.com/0xPlayerOne/bunly/commit/652df1c418a05130a70423a67f632b1672b06b89))
* **ipc:** reserve native command capacity for lifecycle control ([#108](https://github.com/0xPlayerOne/bunly/issues/108)) ([7f4cdb9](https://github.com/0xPlayerOne/bunly/commit/7f4cdb90804400fa8a4878f21c590cef89b9c6ba))
* m37-portable-browser-actions ([#90](https://github.com/0xPlayerOne/bunly/issues/90)) ([6a5a937](https://github.com/0xPlayerOne/bunly/commit/6a5a93780498098b2f15652f38b0695c62b861b9))
* **network:** enforce session origins and qualify remote authority ([#98](https://github.com/0xPlayerOne/bunly/issues/98)) ([11c6d19](https://github.com/0xPlayerOne/bunly/commit/11c6d19652a6c4ce599e36194c126310ad47b4fe))
* **policy:** bind native capabilities to document lifetimes ([#97](https://github.com/0xPlayerOne/bunly/issues/97)) ([2663061](https://github.com/0xPlayerOne/bunly/commit/26630612df94eadbce3c8744ec2373c05a7bd989))
* **process:** integrate native desktop terminal ownership and host lifetimes ([#117](https://github.com/0xPlayerOne/bunly/issues/117)) ([c0d336a](https://github.com/0xPlayerOne/bunly/commit/c0d336a9e24768abb01cc0ea4f816d7b42c2770a))
* **process:** use owned exit notifications for backend shutdown ([#111](https://github.com/0xPlayerOne/bunly/issues/111)) ([6280e16](https://github.com/0xPlayerOne/bunly/commit/6280e168084fa33409ae5b5cdd835f2b558cb67c))
* **qualification:** exercise real PTYs through graphical CEF terminal consumption ([#115](https://github.com/0xPlayerOne/bunly/issues/115)) ([6c01202](https://github.com/0xPlayerOne/bunly/commit/6c012026980dc45edb480dc8e25661a37ed6bb22))
* qualify reference baselines and real installed updater transactions ([#76](https://github.com/0xPlayerOne/bunly/issues/76)) ([73f67d1](https://github.com/0xPlayerOne/bunly/commit/73f67d1282f4fcab654abb2256845cd34da63e0c))
* **reload:** integrate persistent managed desktop development ([#130](https://github.com/0xPlayerOne/bunly/issues/130)) ([1366ac6](https://github.com/0xPlayerOne/bunly/commit/1366ac600c7a16341fa420378b8c2263a40b5629)), closes [#30](https://github.com/0xPlayerOne/bunly/issues/30) [#31](https://github.com/0xPlayerOne/bunly/issues/31) [#32](https://github.com/0xPlayerOne/bunly/issues/32) [#33](https://github.com/0xPlayerOne/bunly/issues/33)
* **rpc:** add bounded authenticated loopback transport candidate ([#94](https://github.com/0xPlayerOne/bunly/issues/94)) ([1e42679](https://github.com/0xPlayerOne/bunly/commit/1e426798bc1c21507850deda195f6823866b78d2))
* **rpc:** bind native renderer authority and qualify session lifecycles ([#96](https://github.com/0xPlayerOne/bunly/issues/96)) ([1048dea](https://github.com/0xPlayerOne/bunly/commit/1048dea69502158883efb287c194ae295b3525cf))
* **rpc:** qualify bounded native transport and paired CEF comparisons ([#100](https://github.com/0xPlayerOne/bunly/issues/100)) ([3edd89c](https://github.com/0xPlayerOne/bunly/commit/3edd89cc7ba09920b8b9b4f51459072e30138bfa))
* **runtime:** define bounded managed application generations ([#126](https://github.com/0xPlayerOne/bunly/issues/126)) ([aad761e](https://github.com/0xPlayerOne/bunly/commit/aad761e1f9cab8411c1c1eb8c98848e422079465))
* **services:** bound explicit readiness and application child restarts ([#120](https://github.com/0xPlayerOne/bunly/issues/120)) ([a2b252a](https://github.com/0xPlayerOne/bunly/commit/a2b252a1603beec688c64aa25bace3516fdc22de))
* **sessions:** add isolated profiles, native cookie APIs and restart qualification ([#95](https://github.com/0xPlayerOne/bunly/issues/95)) ([0f278f6](https://github.com/0xPlayerOne/bunly/commit/0f278f6b3ff196131967f9219a2ff6967295d8fa))
* **sessions:** clear complete offline profiles with interruption recovery ([#102](https://github.com/0xPlayerOne/bunly/issues/102)) ([98b4e94](https://github.com/0xPlayerOne/bunly/commit/98b4e947a0c7bc1de3404db52b9fa8f428ede43c))
* **sessions:** verify OS-protected persistent cookies before admission ([#103](https://github.com/0xPlayerOne/bunly/issues/103)) ([25d0b5d](https://github.com/0xPlayerOne/bunly/commit/25d0b5da999176dcf59bc873d44d39845b4c642a))
* **streams:** bind independent native binary lanes to document authority ([#113](https://github.com/0xPlayerOne/bunly/issues/113)) ([8237b84](https://github.com/0xPlayerOne/bunly/commit/8237b8448616df052511fed8c18e8fd4cfb35cb9))
* **streams:** bound callback producers and qualify actual Bun PTY flow ([#105](https://github.com/0xPlayerOne/bunly/issues/105)) ([46460c7](https://github.com/0xPlayerOne/bunly/commit/46460c7f5d46d41758ff67fbcfe47c0a0a040f1c))
* **streams:** schedule bounded native delivery fairly across owners ([#116](https://github.com/0xPlayerOne/bunly/issues/116)) ([1883c4e](https://github.com/0xPlayerOne/bunly/commit/1883c4e307c5bfed95133cd841bf6e22ac107d7d))
* **terminals:** own bounded Bun PTY resources and lossless output ([#114](https://github.com/0xPlayerOne/bunly/issues/114)) ([a89949f](https://github.com/0xPlayerOne/bunly/commit/a89949fc0fe0a4b6a29e92abc0291dca5f050feb))
* **terminals:** qualify sustained graphical load and retain native failures ([#118](https://github.com/0xPlayerOne/bunly/issues/118)) ([14daa11](https://github.com/0xPlayerOne/bunly/commit/14daa1114da7a88ad063ae852271d8a64c6aae01))


### Bug Fixes

* **benchmarks:** qualify macOS workbench and repair real adapter failures ([#75](https://github.com/0xPlayerOne/bunly/issues/75)) ([1a1ac03](https://github.com/0xPlayerOne/bunly/commit/1a1ac032e1e659029a580d7b4573d51b11f22665))
* **build:** resolve native outputs from the selected Cargo target ([#141](https://github.com/0xPlayerOne/bunly/issues/141)) ([478cb29](https://github.com/0xPlayerOne/bunly/commit/478cb297bca8ef4fa4c6294fffea84a6fde01719))
* **deps:** patch benchmark Electron certificate advisory ([#99](https://github.com/0xPlayerOne/bunly/issues/99)) ([5f4b064](https://github.com/0xPlayerOne/bunly/commit/5f4b064e4ad466ac592a5f1744e504af66878838))
* **dev:** retain the initial prepared-cache miss during publication ([#137](https://github.com/0xPlayerOne/bunly/issues/137)) ([6486da2](https://github.com/0xPlayerOne/bunly/commit/6486da21d7529e6f82349a3228ccf78dbd7fdf39))
* enforce packaged resource boundaries and conditional responses ([#68](https://github.com/0xPlayerOne/bunly/issues/68)) ([e8cca3b](https://github.com/0xPlayerOne/bunly/commit/e8cca3babc8a590470ba789a4e7ce8000c9ce73d))
* harden runtime ownership and optimize dispatch and cache reuse ([#86](https://github.com/0xPlayerOne/bunly/issues/86)) ([a6598a3](https://github.com/0xPlayerOne/bunly/commit/a6598a36c0aa6ea99d56a1e0e8503164f7f369f5))
* **native:** make functional qualification deadlines and CSP evidence explicit ([#81](https://github.com/0xPlayerOne/bunly/issues/81)) ([6dac2aa](https://github.com/0xPlayerOne/bunly/commit/6dac2aac822b0b135d1ab38ac7cbc83540ee2d80))
* pin Bun 1.4.4 and keep PR CI under five minutes ([#148](https://github.com/0xPlayerOne/bunly/issues/148)) ([db40f42](https://github.com/0xPlayerOne/bunly/commit/db40f4259b02c9203a95e80708d3e4eb56e80fcf))
* preserve bounded qualification reports and pin benchmark dependencies ([6e413fe](https://github.com/0xPlayerOne/bunly/commit/6e413fed9b589ca1d00859406b93a126814f8fae))
* **qualification:** require real readiness and ordered native fault recovery ([#109](https://github.com/0xPlayerOne/bunly/issues/109)) ([2c66f2b](https://github.com/0xPlayerOne/bunly/commit/2c66f2b57510f7af23607364a7cbb3c063f84830))
* qualify CEF resource teardown and compiler-free runtime consumption ([#64](https://github.com/0xPlayerOne/bunly/issues/64)) ([1bb2df5](https://github.com/0xPlayerOne/bunly/commit/1bb2df5cd2e10076d1a3dac21ca33dc592aa2edf))
* qualify compiler and Bun APIs against installed toolchains ([4e81d8c](https://github.com/0xPlayerOne/bunly/commit/4e81d8cfa4f8cc1cb0f88d8bf199c4c86522e6f0))
* **release:** configure a single framework version ([#150](https://github.com/0xPlayerOne/bunly/issues/150)) ([c5d7a4d](https://github.com/0xPlayerOne/bunly/commit/c5d7a4dc02579de92e3f7e1bdca2f22054c672d0))
* retain safe validation and listener snapshots with frozen dependencies ([a6cd81f](https://github.com/0xPlayerOne/bunly/commit/a6cd81fe287b7982d26c4dca37fbc4b30fa1db23))
* revoke closing-window ownership before callbacks and record M1 evidence ([0e3be9d](https://github.com/0xPlayerOne/bunly/commit/0e3be9d523b4556e94f6af560f0a979b3f1084c2))
* **runtime:** bound and redact diagnostic snapshots ([#131](https://github.com/0xPlayerOne/bunly/issues/131)) ([562dec6](https://github.com/0xPlayerOne/bunly/commit/562dec6e550511c3464d33c7e9e3994620df990a))
* **streams:** yield bounded callback drains to pending control work ([#107](https://github.com/0xPlayerOne/bunly/issues/107)) ([d76c0ba](https://github.com/0xPlayerOne/bunly/commit/d76c0ba3c1e3753f64216b4f6d644149f5ab28d0))
* **tooling:** make M4 diagnostics and acceptance evidence reproducible ([#104](https://github.com/0xPlayerOne/bunly/issues/104)) ([05ce81d](https://github.com/0xPlayerOne/bunly/commit/05ce81d0762680a598969e119d057c7c3efe5ec0))
* type subprocess fixture frames and document qualification boundaries ([ece5fd3](https://github.com/0xPlayerOne/bunly/commit/ece5fd3034b80112c552c5af49bf02e39ac24343))
* validate native shutdown phases and preserve failure causes ([#93](https://github.com/0xPlayerOne/bunly/issues/93)) ([e4fb575](https://github.com/0xPlayerOne/bunly/commit/e4fb57568e1e84ffb79a97561cdb45f82bb0b257))


### Performance

* bound native asset work and maintain foundation regressions ([#89](https://github.com/0xPlayerOne/bunly/issues/89)) ([3869db3](https://github.com/0xPlayerOne/bunly/commit/3869db31da2f53434104bbed76f3e18a9810e2a7))
* complete Bun-native tooling, formatting, and local CI validation ([#85](https://github.com/0xPlayerOne/bunly/issues/85)) ([654d633](https://github.com/0xPlayerOne/bunly/commit/654d633f915947a6aa82c7922e812b740c1377e8))
* optimize message decoding and repair buffer ownership ([#87](https://github.com/0xPlayerOne/bunly/issues/87)) ([bdf9c9e](https://github.com/0xPlayerOne/bunly/commit/bdf9c9e10fa4d30a43931aee794186c09e83bcf1))


### Documentation

* add Bunly roadmap entry point ([597652f](https://github.com/0xPlayerOne/bunly/commit/597652f7eb1e13484e60be455e9c26383c014088))
* **cef:** retain watchdog investigation and finite reversal evidence ([#128](https://github.com/0xPlayerOne/bunly/issues/128)) ([3a32614](https://github.com/0xPlayerOne/bunly/commit/3a32614846d1910a52eb825fa6a813f069548616))
* **desktop:** define M7 platform qualification protocol ([#135](https://github.com/0xPlayerOne/bunly/issues/135)) ([bc96957](https://github.com/0xPlayerOne/bunly/commit/bc969571baee4054e4335a17032d424196e101d1))


### Tests

* add real Electron renderer-crash coverage and preserve qualification evidence ([af89807](https://github.com/0xPlayerOne/bunly/commit/af898076a6026d6dcec42866219ca941cf3bf343))
* **benchmarks:** add strict stage accounting and performance budgets ([#70](https://github.com/0xPlayerOne/bunly/issues/70)) ([1f22cff](https://github.com/0xPlayerOne/bunly/commit/1f22cff6d9be40a08b38a3012e61df5f051da9e0))
* **cef:** qualify shutdown diagnostics and prelaunch capture ownership ([#121](https://github.com/0xPlayerOne/bunly/issues/121)) ([54c8742](https://github.com/0xPlayerOne/bunly/commit/54c874232f236c61dc92911abb792326762343cb))
* **cef:** trigger bounded diagnostics on pending teardown ([#125](https://github.com/0xPlayerOne/bunly/issues/125)) ([7617829](https://github.com/0xPlayerOne/bunly/commit/76178294175a5611577b8c2d3007e96b2fcc7def))
* complete Linux M3 native qualification and preserve acceptance evidence ([#82](https://github.com/0xPlayerOne/bunly/issues/82)) ([4e10a4f](https://github.com/0xPlayerOne/bunly/commit/4e10a4fb6452034c16e787c1d7a806e48a00cd3f))
* complete remaining M3 platform acceptance ([#79](https://github.com/0xPlayerOne/bunly/issues/79)) ([533a023](https://github.com/0xPlayerOne/bunly/commit/533a0238aca6284e28523197e367c491e30023da))
* extend native host qualification with same-host worker lifecycle and process-tree observation ([fb570b8](https://github.com/0xPlayerOne/bunly/commit/fb570b82c470feb66805621dec1de2205ab6025d))
* finish M3 Linux and Windows native platform acceptance ([#80](https://github.com/0xPlayerOne/bunly/issues/80)) ([c941203](https://github.com/0xPlayerOne/bunly/commit/c9412037c6bdcbfcd4bb52810372e6063db99c61))
* **m5:** retain measured acceptance and close out milestone evidence ([#123](https://github.com/0xPlayerOne/bunly/issues/123)) ([5d2ebe9](https://github.com/0xPlayerOne/bunly/commit/5d2ebe9d9051eeef4e4a2dab571df028cb5d8afe))
* **process:** qualify hung backends and observed shell descendants ([#112](https://github.com/0xPlayerOne/bunly/issues/112)) ([035d2f6](https://github.com/0xPlayerOne/bunly/commit/035d2f6e2cdd3dbe2a518a622e6b009945412979))
* qualify repeated subprocess generations and phase-level resource accounting ([86dc91a](https://github.com/0xPlayerOne/bunly/commit/86dc91a1218e674f60e6655dc62956ef456a1d1e))
* **reload:** qualify replacement isolation and retained mechanism evidence ([#127](https://github.com/0xPlayerOne/bunly/issues/127)) ([40ffe08](https://github.com/0xPlayerOne/bunly/commit/40ffe083448d6e7df6c7385976c3f47ca7f3c72c))
* **services:** qualify guarded native generations and restart cleanup ([#122](https://github.com/0xPlayerOne/bunly/issues/122)) ([50371d6](https://github.com/0xPlayerOne/bunly/commit/50371d6af0fefd38aef7da35ad686fd6187c1d0b))


### Maintenance

* audit and harden the post-M3 foundation ([#84](https://github.com/0xPlayerOne/bunly/issues/84)) ([11d98e2](https://github.com/0xPlayerOne/bunly/commit/11d98e2fd69a043f494df859a92aba9a2d1e0adf))
* bootstrap Bunly implementation milestones and labels ([1a42cac](https://github.com/0xPlayerOne/bunly/commit/1a42cac0a4a856920c394fffb95b6c05eace6174))
* **cef:** qualify released 156 runtime for credential support ([#101](https://github.com/0xPlayerOne/bunly/issues/101)) ([f631c28](https://github.com/0xPlayerOne/bunly/commit/f631c28b20351dd09a5c967521d63965770b40f6))
* **ci:** configure Bunly with Code Foundry ([#146](https://github.com/0xPlayerOne/bunly/issues/146)) ([61fcf97](https://github.com/0xPlayerOne/bunly/commit/61fcf971138dfca49776675a5c15cb29b265409b))
* complete M1 host qualification and architecture decision ([#69](https://github.com/0xPlayerOne/bunly/issues/69)) ([5a7be91](https://github.com/0xPlayerOne/bunly/commit/5a7be9162c039bd8ec512eadd5eafe788def4496))
* install Code Foundry with billing-aware GitHub layout ([#65](https://github.com/0xPlayerOne/bunly/issues/65)) ([522fb98](https://github.com/0xPlayerOne/bunly/commit/522fb98478740c1f092f51cdadc2a15516e401dc))
* remove completed one-time roadmap bootstrap ([d2e5d8a](https://github.com/0xPlayerOne/bunly/commit/d2e5d8add5eecd5f723c3f546d0ae9531ad2a58c))
* share Cargo artifacts across Bunly worktrees ([#136](https://github.com/0xPlayerOne/bunly/issues/136)) ([6a3f162](https://github.com/0xPlayerOne/bunly/commit/6a3f1622f3b19a90ad1f41197469431407f61eb9))
* verify completed Bunly roadmap metadata ([3a7c53e](https://github.com/0xPlayerOne/bunly/commit/3a7c53e0f8148ddd28b6a64b349f654139641779))
