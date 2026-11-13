# Adapter workspace micro benchmark

`react-workspace.tsx` mounts a realistic styled mail workspace through
`@bun-native/react`: a 12-folder sidebar, a search toolbar (`input` and
`button`), `rows` message rows of `box > [box > [text, text], text, button]`
with a click handler, and a detail pane holding a ~12,000 character log text
(about 7,100 native nodes at 1,000 rows). The shared state, themes and window
live in `workspace.ts`. It reports the median of ten fresh `mount`s and of
`samples` commits of each change:

- `select`: the selection moves, so two rows change background (2 sets);
- `star`: one row's button text toggles (1 set);
- `log`: the log drops its first line and appends one (1 large text set);
- `theme`: light/dark switch, so every coloured node restyles (4,026 sets);
- `filter`: the search alternately hides and restores the 500 rows that do not
  match (on average 250 removes and 1,500 creates/inserts).

Every change rerenders the whole `App`, as an unmemoized React app does, so
each row gets fresh inline `style` objects. `sync` is React's render and commit
including every host config callback; `total` adds the commit barrier and the
renderer's snapshot, diff and publish. The window counts native operations and
acknowledges immediately, so neither includes core validation, IPC, native
work or paint.

```sh
NODE_ENV=production bun benchmarks/adapters/react-workspace.tsx [rows=1000] [samples=100]
```

## Equal inline styles

[Raw records](raw/): source `822086b` (before) and this change (after), pinned
Bun `da867c60`, Linux 6.18 (4 vCPU cloud container), three processes each,
1,000 rows. Ranges are per-process medians in µs.

| Change   | before sync | after sync  | before total  | after total   |
| -------- | ----------- | ----------- | ------------- | ------------- |
| `select` | 2,012–2,093 | 1,670–1,805 | 10,073–12,684 | 1,774–1,922   |
| `star`   | 2,073–2,122 | 1,556–2,651 | 12,501–14,791 | 1,626–2,763   |
| `log`    | 1,968–2,057 | 1,576–1,624 | 10,837–12,771 | 1,648–1,692   |
| `theme`  | 2,036–2,148 | 2,121–2,230 | 12,791–13,438 | 8,213–8,615   |
| `filter` | 3,524–4,335 | 3,157–3,389 | 14,812–20,193 | 7,336–8,202   |
| `mount`  |             |             | 17,931–24,055 | 19,097–23,414 |

Before, the host config compared props by identity, so every rerendered host
with an inline `style={{ ... }}` handed the renderer a new style object. The
renderer copies it and invalidates the node and its ancestors, so one changed
row recaptured and rediffed every styled node (~4,000) to send two sets.
`commitUpdate` now skips a style with the same own keys, in the same order, and
`Object.is`-equal values: the renderer would have committed the identical
element, so the native operations are unchanged.

What remains: `sync` is React rerendering 1,000 rows (an app would memoize
them). `theme` still spends ~6 ms in the renderer recapturing ~4,000 changed
nodes, and `mount` ~20 ms for ~7,100 nodes; both are renderer snapshot/diff
work. The renderer's own `setProperty` still invalidates on an equal style or
text, which Solid effects that recreate a style object also pay.

## Shared committed records

A changed node's committed record was its capture copied with the native
handle added, and every box re-copied its stored style into each capture. The
renderer now keeps native handles in their own map and publishes the capture
itself, a box and a leaf without scrolling members share the stored style copy
(replaced, never mutated), and listener reconciliation skips nodes without
handlers without allocating. [Raw records](raw/) `react-workspace-records-*`:
pinned Bun `b1007f117`, five alternating processes each on a loaded 4 vCPU
container, 1,000 rows; the median over the five per-process medians in µs.

| Change   | before total | after total | before total − sync | after total − sync |
| -------- | ------------ | ----------- | ------------------- | ------------------ |
| `theme`  | 7,014        | 5,181       | 5,248               | 3,433              |
| `filter` | 6,984        | 5,644       | 4,444               | 3,142              |
| `select` | 1,376        | 1,348       | 102                 | 99                 |

`mount` stayed within its process-to-process spread (13–25 ms either way).

## Detached subtrees and node brands

React builds each new subtree bottom-up while it is detached, and every
`insertNode` re-walked the inserted subtree to clear captures that a detached
subtree cannot hold, so a mount walked each node once per ancestor. An unowned
subtree that stays unowned is now left as it is (the owner that takes it
adopts it in full), a new node starts dirty, and staged nodes carry a private
class brand instead of a `WeakSet` entry, which `asNode` checks on every Solid
renderer call. [Raw records](raw/) `react-workspace-mount-*`, six alternating
processes each, same container: `mount` per-process medians 14.6–25.0 ms
(median 19.1) before, 13.6–19.1 ms (median 15.0) after.
