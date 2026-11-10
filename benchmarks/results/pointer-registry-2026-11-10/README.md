# Pointer hitbox registry: measured and rejected (#297)

The [November 5 measurement](../../BRIDGE.md#phase-and-render-attribution-297)
bounded what the two per-node capture listeners (`PointerFrame.target`) cost: up
to about 0.8 ms of element construction and 2.2–2.3 ms of render-to-paint per
1,001-node frame. This record tests the same-semantics replacement it described.

## Candidate

[`registry-variant.patch`](registry-variant.patch), against `main` at the source
in [`phases.json`](phases.json). Each model element is wrapped in a transparent
element that shares its layout node, inserts one `Normal` GPUI hitbox ahead of
its children (after them for an occluding overlay layer, whose own hitbox would
otherwise block it), clips it exactly as GPUI clips an element's own hitbox, and
records `(hitbox, node)` in paint order. The window capture observer resolves the
last painted hovered entry. No per-node listener is boxed.

It kept the semantics the native tests check: locally the release host passed
development `native-window` pointer/keyboard/input-race, `overlays.ts` (16
outcomes, including occlusion and scrolling) and `popups.ts` (8 outcomes), with
host clippy and all 158 host unit tests green.

## Result

Same machine, same session type, alternating AB/BA order, every trial kept, none
rerun: shared 4-vCPU cloud container (Intel Xeon), Linux 6.18, Xvfb with
lavapipe requested, pinned Bun canary `b1007f117`, release hosts, ordinary Bun
development mode, `BUN_NATIVE_PHASE_TRACE` on. Medians across trials of each
trial's p50 (frames are the 1,001-node renders during the 1,000 individual
updates, 5–9 per trial):

| Variant (5 pairs)  | Render construction | Render to paint | Ack after a render | Sum of 1,000 acks |
| ------------------ | ------------------: | --------------: | -----------------: | ----------------: |
| `main`             |             1.36 ms |        10.47 ms |           15.10 ms |          322.9 ms |
| registry candidate |             1.10 ms |        11.89 ms |           16.54 ms |          334.3 ms |

Construction got about 0.26 ms cheaper, but render-to-paint got slower in **all
five pairs** (by 0.9 to 3.0 ms), so the whole frame is about 1.2 ms (10%) slower
and acknowledgements that wait behind a render get slower too.

A measurement-only control (4 pairs) wrapped every node the same way but
inserted a zero-size hitbox and no listeners, so pointer input does not work in
it. It was faster than `main` in every pair (render to paint 9.79 vs 11.69 ms
median). The wrapper element itself is therefore cheap. The extra cost follows
real, full-size hitboxes inserted at the wrapper rather than inside the element.
This record does not attribute it further: for example, it does not separate
hover hit testing from content-mask handling. The run-to-run spread on this
shared machine is about ±1 ms, which is why only the paired direction is relied on.

## Decision

The candidate is **not adopted**. It removes the per-node allocations but makes
frames slower on the measured workload, and #297 requires a measured benefit
before the hit-testing path changes. The per-node capture listeners stay as they
are. The acknowledgement tail remains governed by frame cost (layout, text and
software paint) on the shared UI thread, as the November 5 record found.
