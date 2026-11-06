# Headless React keyed-list adapter micro benchmark

`keyed.tsx` mounts keyed rows (`box` > `text` with a text child and a click handler) through `@bun-native/react` against an in-process window whose batches acknowledge immediately. It reports median microseconds for stable-size append, swap, middle removal, prepend and a restyle that rerenders every row with a new style object, plus replacing every keyed row and clearing the list. `sync` covers React's synchronous render and commit, including every host config callback; `total` adds the commit barrier and the renderer's snapshot, diff and publish. It measures no IPC, core validation, native work or paint.

```sh
NODE_ENV=production bun benchmarks/react/keyed.tsx [rows=1000] [samples=200]
```

Use `NODE_ENV=production` for adapter comparisons: the development reconciler's own checks otherwise dominate. Swap and replace grow quadratically with the row count inside react-reconciler itself (`getHostSibling` walks the placed siblings of every placement), not in the host config.
