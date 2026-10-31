# Composition fixture observations

The ordinary `composition` case retains `native-view-composition-v1`, its
renderer `observe` payload and its existing acceptance sequence.

The `composition-interactions` case now emits
`native-composition-interactions-v2` with application receipt schema 2. The
self-hosted classic `initial-observation.js` script executes before the module
client. It installs observers only for the exact local interaction fixture URL
with `pane=left|right|overlay&interaction=2`; that selection grants no authority.
The existing native document binding and `view-composition-fixture` RPC
capability authenticate every later history submission. CSP remains
`script-src 'self'` without an inline exception.

Each document records its first script's actual visibility/focus state and every
subsequent trusted window focus/blur and document visibility event. It retains at
most 32 records, including host-requested checkpoints. Overflow is sticky and
rejects acceptance; it never evicts an earlier event. The host accepts only
append-only snapshots from the same view, frame, document generation and page
instance. One long-poll per page carries checkpoint requests without a timer or
page evaluation. Cancellation and teardown settle those requests.

Before creating the hidden overlay, the fixture explicitly focuses the existing
right pane and observes native and renderer agreement. Both content panes then
acknowledge `before-create`. After the overlay loads while still hidden, all
three pages acknowledge `after-create`, with the right pane still the native and
renderer focus owner. A transient right-pane blur or left-pane focus during that
interval rejects acceptance even if focus was restored before the readback.

After the existing left/right menu cases, all pages acknowledge `before-show`.
The overlay's complete history must contain only hidden, unfocused observations
and no focus/blur events. Each collector seals when its `before-show` snapshot is
read. After all three authenticated snapshots arrive, the host admits its first
explicit overlay-show operation. The interval between sealing and the native
show operation is not observed by this history. This records browser events
through the acknowledged checkpoint, not an atomic measurement of compositor
presentation or OS input routing. Existing native and renderer assertions
continue to qualify the subsequent show/hide sequence.

The complete v2 application receipt, including all three histories and the
original interaction sections, must fit the existing 16 KiB native diagnostic
line budget. The 32-record per-pane limit does not guarantee that the aggregate
fits; history overflow or an oversized receipt fails qualification without
truncating evidence. The v1 budget, 30-second workload deadline, 45-second outer
observer budget, sandbox, native-owner cleanup and all physical-input/performance
limitations remain unchanged.

Retained `native-composition-interactions-v1` reports use their explicit
historical validator and original acceptance object. They observed renderer
state after RPC startup and do not establish this new early-history criterion.
The retained one passing Mac report and five failed reports keep their original
outcomes. New executions require v2 and cannot use a v1 receipt as acceptance.

This fixture improvement does not correct CEF's initially-hidden Linux
WebContents state. That runtime defect remains separately open.

The [retained stock v2 observations](../../evidence/m7-composition-initial-v2/README.md)
include a Linux first-script `visible` state in the native-hidden overlay and a
complete Mac interaction pass on a virtual display. Their original outcomes,
histories, exact source/runtime identities and cleanup remain available for
replay; these provide no hardware or runtime-fix qualification.
