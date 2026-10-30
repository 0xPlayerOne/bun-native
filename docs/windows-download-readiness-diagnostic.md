# Windows first-download startup diagnostic

This isolated contributor branch investigates [#36](https://github.com/0xPlayerOne/bunly/issues/36).
It does not complete M7, change the maintained 6000 ms first-download deadline,
or qualify a runtime fix. Its Windows `full` run deliberately reports the
instrumented download fixture as failed even if the application finishes inside
the deadline. Do not merge the branch's automatic trace opt-in into `main`.

The previous public diagnostic, [run 41088274530](https://github.com/0xPlayerOne/bunly/actions/runs/41088274530),
showed native resource completion at 2 ms and the first native download callback
at 5527 ms. Successful SQL open and statement histograms did not account for
that interval. They omit direct schema execution and cannot distinguish a
queued history task from the original profile's in-progress-cache readiness.
See [M7 status](m7-status.md) for the retained results and acceptance limitations.

## Capture and execution

Build the exact branch with the existing `packaging,rpc-qualification` features
and use the existing disposable standard-user Windows launcher:

```sh
gh workflow run cef-runtime.yml --ref test/m7-download-readiness-trace \
  -f platform=windows -f suite=full
```

Only `file-downloads` receives `--download-readiness-trace`. The existing fixture,
acceptance parser, sandbox, fresh ephemeral profile, and observer deadline stay
unchanged. Native capture requires the contributor feature, Windows, the hosted
runner environment, the synthetic benchmark marker, and an ephemeral context.
The TypeScript entry point additionally checks x64, the exact fixture, and a
numeric hosted run ID. Normal builds exclude the capture module.

The native app injects `trace-config-file` and `trace-startup-format=json` in its
existing `OnBeforeCommandLineProcessing` callback. This is earlier than profile
creation: pinned CEF invokes the application callback from `BasicStartupComplete`,
and Chromium calls it before `InitTracingPostFeatureList`. External command-line
processing remains disabled. There is no profile warmup, service initialization
shortcut, security feature switch, or page-accessible tracing API.

The configuration is fixed to `browser`, `startup`, `sql`, `leveldb`, `toplevel`,
and `toplevel.flow`, excludes other categories, and requests only the browser
process. Capture stops after 15 seconds or at clean native shutdown, with an
8192 KiB event-buffer request and `record-until-full`. Perfetto may allocate
additional metadata buffers, and exported JSON can exceed the binary event
buffer size. This is not a total-memory or final-file-size bound.

Four private native anchors use CEF's system trace clock, whose internal unit is
microseconds: before initialize, context initialized, first native download
record, and first matched callback. They align Chromium spans to the first
native download record without relying on histogram wall-clock origins. The
download anchor is just before record allocation, not a wire-start measurement.

## Private input and retained output

Raw tracing can include paths, SQL text, source locations, and browser metadata.
It is confined to a newly allocated directory beneath the launcher's protected
temporary root, outside all evidence-export directories. The native side rejects
an existing populated directory, a symbolic link, or a leaf Windows reparse
point. Sidecars use exclusive creation. The trace configuration and absolute
clock anchors are never printed. The private directory is removed before the
qualification report is written; cleanup failure is explicit and cannot pass.

The reader accepts only the two fixed files `trace.json` and `clocks.json`, with
bounds of 64 MiB and 4096 bytes. It rejects non-files, links, size changes,
malformed JSON, inconsistent clocks, over 500,000 events, over 100,000 retained
spans, excessive nesting, and excessive synchronous or asynchronous tracks.
Filesystem and JSON parser errors become fixed messages without input excerpts.

The retained `diagnosticReadinessTrace` report field contains only fixed labels,
counts, relative microseconds, anonymous thread ordinals, fixed limitations, and
a SHA-256 of the raw input. All raw arguments, metadata, process IDs, flow IDs,
SQL, paths, URLs, and arbitrary event names are discarded. The parser retains at
most eight longest spans per fixed label. Existing hosted export handles the
sanitized report; it has no path to the private trace directory.

Task flows are joined after all posts are indexed, because cross-thread packet
serialization need not follow timestamp order. Both worker and UI task names
are recognized. Source locations are used only to choose a fixed history,
LevelDB-proto, cache, or download-manager label, then discarded. Named-track SQL
statements exported as async `b`/`e` pairs are paired independently; their thread
and enclosing-task attribution remain `null` because a JSON async track's `tid`
need not identify the execution thread.

## How to interpret the next run

| Observed pattern                                                                               | Bounded next investigation                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `history-backend-init` spans most of the callback gap                                          | Inspect its direct SQL and open spans; the prior successful-statement histograms did not measure every initialization operation. |
| History initialization is short but its enclosing task has a long queue wait                   | Inspect startup task scheduling before changing profile behavior.                                                                |
| History completes early but fixed proto/cache tasks or UI delivery run near the first callback | Follow the original-profile in-progress-cache chain and its return to the UI thread.                                             |
| History, relevant tasks, or first-callback coverage are missing                                | Treat the run as inconclusive; do not infer zero work or readiness.                                                              |

Nested spans overlap, so totals from different labels must not be added. A
history initialization end is not itself the download-ID/cache-ready transition.
Absent task source fields or ambiguous flow IDs yield `null` queue waits. The
summary reports unmatched scopes/flows and explicitly sets
`dataLossVerified: false`: a full record-until-full buffer or other event loss can
omit later records. Tracing can perturb scheduling. Any correction needs a
separate clean, uninstrumented Windows run at the unchanged maintained deadline.

## Pinned source basis

No upstream implementation is copied into this probe. These primary sources
define the switch timing, clock unit, configuration, and event identities:

- CEF `47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`:
  [startup callback](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/common/chrome/chrome_main_delegate_cef.cc)
  and [system trace clock](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/trace_impl.cc).
- Chromium `156.0.8078.17`:
  [main startup order](https://github.com/chromium/chromium/blob/156.0.8078.17/content/app/content_main_runner_impl.cc),
  [startup configuration](https://github.com/chromium/chromium/blob/156.0.8078.17/services/tracing/public/cpp/trace_startup_config.cc),
  [capture shutdown](https://github.com/chromium/chromium/blob/156.0.8078.17/services/tracing/public/cpp/startup_tracing_controller.cc),
  [history initialization](https://github.com/chromium/chromium/blob/156.0.8078.17/components/history/core/browser/history_backend.cc),
  [SQL execution](https://github.com/chromium/chromium/blob/156.0.8078.17/sql/database.cc),
  [SQL named tracks](https://github.com/chromium/chromium/blob/156.0.8078.17/sql/statement.cc),
  [UI tasks](https://github.com/chromium/chromium/blob/156.0.8078.17/base/task/sequence_manager/thread_controller_with_message_pump_impl.cc),
  and [worker tasks](https://github.com/chromium/chromium/blob/156.0.8078.17/base/task/thread_pool/task_tracker.cc).
- Perfetto `403906f4adfbf287a02e5546f8430dcc9d56b649`:
  [JSON export](https://github.com/google/perfetto/blob/403906f4adfbf287a02e5546f8430dcc9d56b649/src/trace_processor/export_json.cc).
