# Candidate provenance

## Upstream source and license

- Project: [Chromium Embedded Framework](https://github.com/chromiumembedded/cef).
- Base: `47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`, CEF 156.0.7.
- Chromium: `ab5de11f88f0792d2ad84e22abd460412e915f13`,
  tag `156.0.8078.17`, from the pinned CEF compatibility file.
- Source paths: `tests/ceftests/views/browser_view_unittest.cc` and
  `libcef/browser/alloy/browser_platform_delegate_alloy.cc`.
- Destination: the same paths in a separately built CEF source checkout.
- License: upstream BSD 3-Clause terms, preserved verbatim in
  [LICENSE.CEF.txt](LICENSE.CEF.txt) from pinned `LICENSE.txt`.
  Upstream file notices remain. The patch's new CEF changes are provided under
  those same terms; no endorsement by CEF/Chromium is implied.
- `candidate.py`, `candidate_test.py`, and package documentation are
  Bunly-authored under the repository's MIT license.

The patches contain the minimal upstream diff rather than a browser binary or a
copied framework implementation. `source.json` records patch and pre/post source
hashes and complete expected trees. The test patch is separate so the original
implementation can be exercised with identical tests.

## Local modifications and rationale

The runtime patch derives initial WebContents hidden state from the existing
BrowserView and its actual widget before creation. It changes no public API,
generated binding, application authority, URL, or application configuration.

The test patch adds four cases to the real upstream Views harness. It observes
the first application's visibility history, native focus/blur history, later
explicit transitions, stable identity and normal destruction. It does not
alter existing assertions, CEF test deadlines or security flags.

Bunly maintainers own this candidate and its update review. CEF's supported
release branch and Chromium updates remain the upstream security channel. Any
upgrade requires a reviewed base, patch application, API/identity comparison and
real platform qualification. There is no automatic rebase, binary fallback,
upstream submission or publication workflow here.

## Source review and local validation

Source was fetched from the public exact CEF commit into an isolated checkout.
The full patched upstream test translation unit passed a C++20 syntax-only check
using real retained CEF 156.0.7 public/generated headers, GCC 13.3, Chromium's
exact GoogleTest dependency `4fe3307fb2d9f86d19777c7eb0e4809e9694dde7` and its
unmodified Chromium forwarding header at
`ab5de11f88f0792d2ad84e22abd460412e915f13`. No CEF or GoogleTest API was stubbed.
This checks public-header syntax only; the Chromium-internal Alloy implementation
and complete `ceftests` target have not been compiled or linked.

Python tests exercise source/apply/identity rejection using temporary Git
repositories and synthetic metadata. They do not load a native browser. Actual
clean patch application against pinned source and resulting tree verification
must accompany the package validation record. Normal Bunly formatting, Python
lint/tests and repository hooks apply to these files.

## Not executed or established

- Full baseline or candidate CEF/Chromium build.
- Four new upstream GUI cases or existing Views suite.
- Candidate binary, exported candidate identity, runtime API-hash comparison,
  sandbox inspection, or Bunly full qualification.
- Minimized/occluded-parent behavior, physical focus/IME/accessibility/display
  qualification, cross-platform regressions, or performance improvement.
- Reproducible binary output, publisher authentication, production signing,
  redistribution acceptance, or upstream maintainer approval.

Selected depot_tools and contributor GN settings are explicit recipe inputs,
not tested build results. Builder/container packages and generated dependency
inputs still need capture when the native build runs. The changed CEF version
requires a separate reviewed integration with Bunly's and cef-rs's identity pins;
this package contains no runtime/dependency change.

This package remains source-only and unqualified. #35 and outstanding M7 gates
remain open.
