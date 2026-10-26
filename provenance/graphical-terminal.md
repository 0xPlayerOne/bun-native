# Graphical terminal contributor dependency

The maintained CEF terminal fixture pins `@xterm/xterm` 5.5.0 as a root development
dependency, matching the existing headless contributor parser version. It is MIT
licensed; its installed package license remains unmodified. The dependency is
imported only by `examples/cef-terminal/terminal-client.ts`, not Bunly runtime or
client package exports. Application consumers do not acquire a second JS runtime,
compiler dependency, or automatic terminal UI from this contributor fixture.

Write completion uses xterm's parser callback. Screen inspection uses its bounded
active buffer and preserves cursor/repaint semantics. That boundary establishes
processing completion, not pixel presentation or physical keyboard latency. No
upstream source was copied or patched.
