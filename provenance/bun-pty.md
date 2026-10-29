# Bun PTY and terminal qualification references

No Bun implementation source was copied or forked. The contributor fixture uses
Bun (version redacted) (commit `c6da4a4d3010e5553438c60f6bd76d981976867c`) as installed.

Pinned behavior references:

- `oven-sh/bun/src/runtime/api/bun/Terminal.rs`, `drain_and_close_slave_fd`,
  `on_reader_error`, `on_reader_finished`, and `finish_io_after_eof`: process exit
  is separate from terminal closure; Linux last-slave hangup follows an EIO path.
  The JavaScript callback exposes status 1 without the errno, so the report keeps
  it as read-error status, not a proven clean EOF or a universal EIO diagnosis.
- `oven-sh/bun/test/js/bun/terminal/terminal-platform-gaps.test.ts`: ConPTY emits
  terminal repaint sequences and does not refresh cached dimensions via SIGWINCH.
  The fixture explicitly invokes the pinned console refresh surface on a requested
  size check; it does not add a polling loop or promise POSIX termios parity.

Repository: https://github.com/oven-sh/bun/tree/c6da4a4d3010e5553438c60f6bd76d981976867c

`@xterm/headless` **5.5.0** is an exact root dev dependency (MIT, no transitive
runtime dependencies), matching `benchmarks/fixtures`' existing browser xterm
5.5.0 pin. Its terminal parser is used only by contributor fixtures/tests;
`packages/runtime` and browser-safe contracts do not import it. It is not a new
application runtime or an automatic native compiler dependency. Its upstream
package license stays in the installed package; no source was vendored.

The write callback establishes parser consumption, not browser drawing, input
latency, or end-user responsiveness. Graphical/native CEF integration remains M5.
API reference: https://xtermjs.org/docs/api/terminal/classes/terminal/#write
