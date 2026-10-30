# CEF Views initial-hidden source candidate

**Status: prepared source candidate; no native runtime acceptance.** This package
prepares the upstream correction and reproduction for Bunly [#35](https://github.com/0xPlayerOne/bunly/issues/35).
It does not change Bunly's CEF dependency, runtime identity, release metadata,
application behavior, or maintained acceptance rules.

The retained [failure analysis](../../../evidence/m7-composition-interactions/upstream-initial-visibility.md)
records a never-shown Linux overlay whose native widget is hidden while the first
authenticated application receipt reports visible. This package provides two
independently selectable source variants:

| Variant     | Patch set                              | Intended use                                                                                                                                              |
| ----------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline`  | `0001-test-initial-hidden-views.patch` | Run the new tests against the original implementation. A failure is expected from source review, but has not yet been observed with these upstream tests. |
| `candidate` | Both numbered patches                  | Run identical tests with the proposed creation correction. No passing result is claimed.                                                                  |

`source.json` pins CEF and Chromium commits, patch and source SHA-256 values,
complete expected Git trees, selected build-tool revision, and test names.
`candidate.py` checks those inputs before applying anything. Its output always
sets `nativeExecutionQualified` to `false`; source consistency and exported
binary identity are separate from executing the desktop contract.

## Correction and limits

The [pinned Alloy creation function](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/alloy/browser_platform_delegate_alloy.cc#L33-L59)
does not set Chromium's initial-hidden flag. BrowserView creation happens while
[attaching the view to its widget](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/browser_view_impl.cc#L310-L342),
so the actual widget is already available.
[Chromium initialization](https://github.com/chromium/chromium/blob/ab5de11f88f0792d2ad84e22abd460412e915f13/content/browser/web_contents/web_contents_impl.cc#L4493-L4504)
consumes this flag before render-manager initialization; its later
[first-visible guard](https://github.com/chromium/chromium/blob/ab5de11f88f0792d2ad84e22abd460412e915f13/content/browser/web_contents/web_contents_impl.cc#L12710-L12761)
does not use repeated hide requests to repair the initial state.

The runtime patch checks the concrete BrowserView and its actual native widget
before `WebContents::Create`. It uses both the View tree's `IsDrawn()` and the
widget's `IsVisible()`: the View API alone does not establish that the widget is
shown. The popup path with no assigned BrowserView and non-Views/OSR creation are
left alone. No public CEF API or ABI changes.

The prepared cases cover an overlay under a shown owner, an explicitly hidden
owner, an explicitly hidden View, and a visible View. They do **not** establish
minimized-window, fully occluded/animated ancestor, physical display, IME, or
accessibility behavior. `Widget::IsVisible()` must not be treated as proof of
those additional semantics. Windows and macOS regressions remain unexecuted.

The fix does not show application content to initialize visibility. Creating an
empty document and briefly showing it is not part of this package: that would
add navigation/authority states, can activate an overlay, and depends on the
owner being genuinely visible. No observer values are overridden.

## Prepared upstream regression coverage

The patch extends the actual pinned
[`ViewsBrowserViewTest` harness](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/tests/ceftests/views/browser_view_unittest.cc).
The first inline application script records `document.visibilityState` and every
subsequent `visibilitychange` in cumulative history. Native callbacks wait for
the real application load and that history, then perform two explicit visibility
transitions. An earlier visible interval cannot be hidden by a later receipt.

The added tests are:

- `ViewsBrowserViewTest.InitiallyHiddenOverlay`: owner shown before attaching
  the overlay; overlay never shown before the first hidden receipt.
- `ViewsBrowserViewTest.InitiallyHiddenOwner`: overlay shown under an explicitly
  hidden owner; owner shown only after the first hidden receipt.
- `ViewsBrowserViewTest.InitiallyHiddenView`: BrowserView visibility disabled
  before attachment to an already shown widget.
- `ViewsBrowserViewTest.InitiallyVisibleView`: ordinary visible control created
  after its owner is shown.

Each checks later visibility history, one application load, stable browser and
main-frame identity, and the harness's browser creation/destruction counts.
Hidden cases check that the browser did not receive focus. Shown-owner hidden
cases retain focus on a textfield and latch any transient textfield blur before
the initial receipt. Native visibility changes and terminal completion are
posted to the UI thread so CEF callbacks unwind before teardown.

The existing dynamic BrowserView move tests and remaining Views tests must also
run against the candidate. This patch does not alter their expected results or
timeouts.

## Source-only verification

Prerequisites: Python 3.10 or later and Git. These commands do not fetch, compile,
or execute native code. Use an isolated CEF checkout at the exact pinned commit,
not an existing user's modified checkout.

```sh
python3 upstream/cef/initial-hidden-views/candidate.py check-patch \
  --cef-source /absolute/path/to/cef --variant candidate

python3 upstream/cef/initial-hidden-views/candidate.py apply \
  --cef-source /absolute/path/to/cef --variant candidate

git -C /absolute/path/to/cef diff --cached --check
git -C /absolute/path/to/cef diff --cached
python3 upstream/cef/initial-hidden-views/candidate.py check-source \
  --cef-source /absolute/path/to/cef --variant candidate
```

`apply` stages the selected patches after checking the exact base commit, clean
checkout, source and patch digests, and Git's applicability check. It then
requires the exact reviewed index tree. Patches use zero context to avoid
whitespace-only patch context in this repository; pinned base/file digests and
the complete expected tree remove reliance on fuzzy context matching.

Review and commit the staged CEF changes as **one commit directly on the pinned
base**, under a distinct local branch such as `bunly-initial-hidden`. Retain its
full commit ID. The verifier accepts different authorship metadata only when the
reviewed tree and direct parent agree.

```sh
git -C /absolute/path/to/cef commit -m "fix: preserve initial Views visibility"
python3 upstream/cef/initial-hidden-views/candidate.py check-source \
  --cef-source /absolute/path/to/cef --variant candidate --require-commit
```

For the test-only baseline, use a separate fresh checkout and `--variant baseline`.
Do not apply one variant on top of the other. The script does not reset, clean,
repair, or remove an existing checkout.

The committed-source check verifies the tracked tree and patched working files.
Generated files are allowed after commitment because CEF generates headers and
project files while building. The check is not an attestation of compiler
inputs, generated output, or Chromium patch application; retain those separately.

Run the guard's own tests explicitly:

```sh
python3 -m unittest discover -s upstream/cef/initial-hidden-views -p '*_test.py' -v
python3 -m ruff check upstream/cef/initial-hidden-views
python3 -m ruff format --check upstream/cef/initial-hidden-views
```

Those tests use temporary Git repositories and synthetic identity metadata.
They do not stub, compile, initialize, or qualify CEF.

## Native builder and exact source inputs

Use an adequately provisioned Linux x64 builder and record its image/digest.
Official [artifact build guidance](https://chromiumembedded.github.io/cef/automated_build_setup.html)
calls for at least 16 GB RAM and 200 GB free disk;
[development guidance](https://chromiumembedded.github.io/cef/master_build_quick_start)
recommends 32 GB or more RAM. Retaining two builds needs additional disk headroom.
No builder or paid resource has been allocated by this package.

| Input                 | Value                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| CEF base              | `47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`                             |
| Chromium              | `ab5de11f88f0792d2ad84e22abd460412e915f13`, tag `156.0.8078.17`        |
| depot_tools           | `5699326929d1b9dc478d648737a9f98ad8f7f724`                             |
| CEF version reference | `e537569ecda2e3f23ffdac559ecf7f80b8e59467` for local `origin/master`   |
| GN additions          | `use_sysroot=true symbol_level=1`                                      |
| Build configuration   | `Release_GN_x64`, upstream contributor defaults                        |
| Existing public API   | version `15600`; Linux hash `6dc09eb2834fe5b61d7d8c42bbb8d8c27a2bb1b6` |

The selected depot_tools revision comes from its
[primary repository](https://chromium.googlesource.com/chromium/tools/depot_tools/+/5699326929d1b9dc478d648737a9f98ad8f7f724).
It has not yet been used to build this candidate. CEF's
[version generator](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/tools/cef_version.py)
uses branch history as well as HEAD; freeze the reference above in the isolated
builder so future remote updates do not change version computation. Do not move
an existing user's branch or tracking ref.

### Build procedure

These are commands for the provisioned builder, not a record of execution.
Use a new directory for each variant. Record OS/container packages, Python,
Clang, Ninja, sysroot, DEPS/CIPD identities, complete generated `args.gn`,
CEF/Chromium status/diffs, and each build's source commit. This is a reproducible
source recipe; bit-for-bit binary reproducibility is not established.

1. Check out pinned depot_tools and disable automatic updates. Fetch the pinned
   CEF `tools/automate/automate-git.py` and preserve its source identity. Use
   normal upstream build dependencies and an ordinary unprivileged account for
   graphical execution.
2. Synchronize exact source without building or distributing:

   ```sh
   export DEPOT_TOOLS_UPDATE=0
   python3 /absolute/path/to/pinned/automate-git.py \
     --download-dir=/absolute/new/builder-root \
     --depot-tools-dir=/absolute/path/to/pinned/depot_tools \
     --no-depot-tools-update --branch=8078 \
     --checkout=47dbc1df023e99f006fb9e850a8d83cc19b4fdd9 \
     --x64-build --no-build --no-distrib
   ```

   Require Chromium HEAD at `builder-root/chromium/src` to be
   `ab5de11f88f0792d2ad84e22abd460412e915f13`. CEF's pinned Chromium patches are
   expected build inputs; retain their identities and application output.

3. Apply this package to the actual `builder-root/chromium/src/cef` checkout
   before project generation, then review and commit it. If synchronization
   created untracked generated files, preserve that directory and use a fresh
   isolated CEF worktree at the same location. Do not force or delete unrelated
   files to pass the check. Freeze and record the CEF version reference.
   Do not run an updater that can reset the patched checkout afterward.
4. Generate projects from that CEF checkout:

   ```sh
   export GN_DEFINES='use_sysroot=true symbol_level=1'
   ./cef_create_projects.sh
   ```

   Keep generated Release configuration identical between baseline and candidate
   apart from source identity. This recipe uses upstream contributor defaults;
   it does not claim to reproduce the official binary's build profile. Do not
   add sandbox-disabling, visibility-emulation, renderer warmup, or
   feature-disable switches.

5. From `builder-root/chromium/src`, build real targets:

   ```sh
   autoninja -C out/Release_GN_x64 cef ceftests chrome_sandbox
   ```

   The pinned `ceftests` target defines `CEF_USE_SANDBOX`. A build/sandbox failure
   remains a failure; do not disable that definition or run GUI tests as root.

6. In the normal supported graphical environment, run focused tests and then
   the complete existing Views suite, retaining XML plus complete logs:

   ```sh
   out/Release_GN_x64/ceftests \
     --gtest_filter='ViewsBrowserViewTest.Initially*' \
     --gtest_output=xml:/absolute/output/initial-visibility.xml

   out/Release_GN_x64/ceftests \
     --gtest_filter='ViewsBrowserViewTest.*' \
     --gtest_output=xml:/absolute/output/views.xml
   ```

   Preserve baseline failures and candidate results separately. A timeout,
   startup failure, missing test or skipped test is not a passing correction.

7. Package the candidate with the pinned upstream tool:

   ```sh
   python3 cef/tools/make_distrib.py \
     --output-dir=/absolute/output/candidate-distribution \
     --ninja-build --x64-build --minimal --no-symbols
   ```

   Retain truthful archive name/full version, archive hash, every extracted
   file/mode, API headers/hash, native library hash, notices/credits, build
   inputs and both test records. Do not use partial packaging to turn a build
   failure into an artifact.

## Binary identity and the stock-fallback guard

A committed custom patch changes the generated CEF version. Pinned cef-rs
[`check_archive_json`](https://github.com/tauri-apps/cef-rs/blob/a46b48c6221f99414a5c6b37ff86491772f9b0a2/download-cef/src/lib.rs#L102-L124)
rejects archive metadata newer than its expected CEF version. Its
[`build.rs`](https://github.com/tauri-apps/cef-rs/blob/a46b48c6221f99414a5c6b37ff86491772f9b0a2/sys/build.rs#L63-L110)
can then download the stock runtime into a versioned subdirectory even when
`CEF_PATH` was explicitly supplied.

This package does not change those dependencies or Bunly's stock expectations.
An explicit, reviewed candidate integration is required before running Bunly
against the new version. It must preserve exact identity checks and application
assertions; renaming the patched archive as stock `156.0.7` would invalidate the
experiment.

After obtaining trusted candidate bytes, record their SHA-256 and use Bunly's
existing exported-API inspector under its bounded observer:

```sh
python3 scripts/observe-process.py \
  --output /absolute/output/candidate-identity-observation.json --timeout 60 -- \
  python3 scripts/probe_cef_identity.py \
  --library /absolute/candidate/libcef.so --sha256 CANDIDATE_SHA256

python3 upstream/cef/initial-hidden-views/candidate.py check-binary \
  --cef-source /absolute/path/to/committed/candidate/cef \
  --library /absolute/candidate/libcef.so \
  --sha256 CANDIDATE_SHA256 \
  --observation-json /absolute/output/candidate-identity-observation.json
```

The inspector loads selected native code, so select independently trusted bytes.
The verifier itself only reads files. It rejects unsuccessful/ambiguous probes,
the stock library hash, mismatched Chromium, a missing full version, or a full
version whose embedded CEF commit differs from the reviewed candidate commit.
The expected digest must come from the retained build inventory; do not use the
unknown application file to invent a new expected identity.

The hash guard streams libraries up to 8 GiB without buffering them in memory.
The maintained exported-API inspector currently has its own 2 GiB load limit.
If unstripped contributor output exceeds that limit, use the truthfully packaged
candidate library if it fits, or prepare a separately reviewed bounded inspector
extension. An oversized file is a reported limitation; do not bypass the check
or substitute the stock library. Small JSON and Cargo inputs are parsed from the
same bounded descriptor read whose identity was checked before and after reading.

For later Bunly integration, check the **final packaged application's library**
and add:

```sh
--cargo-output /absolute/target/build/cef-sys-ID/output \
--cef-dir /absolute/explicit/candidate/linux_x86_64
```

`cef-dir` is the exact flattened platform directory accepted by the reviewed
cef-rs integration. The checker requires the actual build-script
`cargo::metadata=CEF_DIR=...` entry to resolve there, with that directory's
`libcef.so` matching the same hash. A versioned stock fallback or multiple
ambiguous entries fails. Use a separate `CARGO_TARGET_DIR` and immutable prepared
application.

The public API tree is unchanged. Compare generated headers and the exported API
hash with the pinned value during integration; neither the source checker nor
version-only probe claims to verify runtime ABI or sandboxing. An exported
version string is not cryptographic build attestation.

## Acceptance still required

Before #35 can claim this software correction: observe the baseline regression,
pass candidate tests and the existing Views suite, qualify the unchanged Bunly
composition contract including earliest application visibility/focus history,
pass the maintained Linux full suite, and review wider platform effects.
Physical focus/IME/accessibility/display and measured rendering tradeoffs remain
separate M7 gates.

No package publication, signed distribution, upstream issue/PR, or release change
is performed by the source checks. See [PROVENANCE.md](PROVENANCE.md) for
ownership, licensing, source inputs and unexecuted native checks.
