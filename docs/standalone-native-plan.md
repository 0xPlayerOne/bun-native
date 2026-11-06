# Installed-consumer native qualification plan

> **Status (2026-11-05):** this hosted lane merged with
> [#388](https://github.com/0xPlayerOne/bun-native/pull/388) as
> [`tests/native/cli-standalone.py`](../tests/native/cli-standalone.py) in the
> [native Linux workflow](../.github/workflows/native-linux.yml). Per its merge
> record, all eight installed Linux development/AOT native cases passed at the
> qualified head. The plan below is kept as written; its limits still apply.

This is the fixed hosted follow-up to the local installation and build study in
[#388](https://github.com/0xPlayerOne/bun-native/pull/388). Preparation of this
harness is not an executed installation or native result. The
[corrected local cohort](https://github.com/0xPlayerOne/bun-native/pull/403) passed
once at `cba506b844eb6b91dbdd085389d43690539c1186`: all four relocated consumers
passed offline installation, strict checks, public imports and inspected AOT
builds, with all eight invalid-input controls passing. It executed no application
or native host. This hosted plan still requires its independent source reviews
and first source-bound qualification. Earlier failures in
[#394](https://github.com/0xPlayerOne/bun-native/pull/394),
[#397](https://github.com/0xPlayerOne/bun-native/pull/397) and
[#400](https://github.com/0xPlayerOne/bun-native/pull/400) remain failed and source-bound.

## Source and environment

The first normal-hook preparation checkpoint `05e504726f6888de00ba9b1a007e3117c5cba910`
is preserved on its original local integration `01d85b6deb302fb3a594bd4981cc745e043b9061`.
Its delta was normally cherry-picked onto actual published source
`cba506b844eb6b91dbdd085389d43690539c1186`, tree
`afdfcee8bc95042cddc385e55efe454e3d433b57`, which contains the exact installer-marker
correction and accepted main release `c4de68deee812cd816316b33f9276786e6eae5c8`.
The cba local result retains its original complete source identity; it is not a
measurement of this new controller or the extracted shared receipt helper.
The final published source commit and tree must be recorded before readiness;
CI checks out and records its actual tested merge separately. No prepared source
is rerun merely to replace a failed outcome.

The existing Linux native job supplies the current source's release host, its
build SHA-256 record, pinned Bun, installed X11 tools and Mesa software renderer.
The new lane does not build Rust. It runs after the existing baseline, Solid
workspace, checkout-template and watch checks, before artifact retention. A
successful native build and a run that has not been cancelled are required.
Earlier failed gates remain failed while this independent evidence is collected.

The original 60-minute job cap remains. The new preparation step has a ten-minute
guard; the new native matrix step has a six-minute guard. The harness reserves ten
seconds for finalization inside each phase and never starts a command without its
complete declared bound plus eight seconds remaining. The existing process audit,
TERM/KILL/reap and log-reader joins have at most 6.2 seconds of explicit waits.
Every command first waits on a private pipe, for at most five seconds, while the
owner records its PID and start time. It then replaces that same process with the
exact command, without a shell. This handshake consumes the command's existing
bound; it adds no assertion time. The outer guard is 45 seconds per native case,
without extending the inner paint, IPC or OS-close decisions. The final one-minute
cleanup step performs only owned filesystem/process-receipt checks, including
after interruption. It cannot grant
additional time to a native assertion. If the existing job cap prevents this
lane from finishing, the result is incomplete; increasing that cap is outside
this change.

## Fixed counts and order

| Phase                    | Maximum calls | Operation                                                              |
| ------------------------ | ------------: | ---------------------------------------------------------------------- |
| Package production       |             7 | Existing producer packs one CLI and six library archives               |
| Create                   |             4 | Solid TypeScript, Solid JavaScript, React TypeScript, React JavaScript |
| Install                  |             4 | One populated-cache offline install per external consumer              |
| Type check               |             4 | The installed consumer's own check command                             |
| Public import inspection |             4 | Exact installed exports, source identity and dependency lock           |
| AOT build                |             4 | Installed CLI with explicit current release host                       |
| Native interaction       |             8 | Development then AOT, in the same four-consumer order                  |

The first unexpected preparation or native failure stops the cohort. Later
operations retain `not-run`; there is no retry, extra warmup or replacement
generation. The local study's empty-cache, relocation and invalid-input controls
are not repeated by this native lane. Every invoked command retains its original
stdout/stderr, exit status, owned process identities and cleanup outcome. A later
cleanup error is secondary to the original failure.

Each consumer is created in a fresh owned directory outside every Git worktree.
The package cache is an owned copy of existing pinned downloads. This is an
offline populated-cache result, not a cold network installation. Package files,
archives, source/lock receipts, actual compiler and host bytes are checked before
and after use. Installed package inventories are validated before importing the
installed CLI. Source-map inputs and public module resolutions must stay inside
the consumer. No checkout dependency link or checkout-relative application
import is accepted.

Cargo, rustc and rustup are replaced by owned PATH sentinels with matching explicit
tool variables during package, consumer and native commands. Any invocation
fails the cohort. Bun commands and compiler children retain `--no-install` where
they execute application/tool modules; only the four explicit offline install
commands may install packages.

## Shared native acceptance

The unchanged generated application supplies its existing IPC hooks. The shared
counter scenario in `tests/native/cli-templates.py` and the existing Linux input
driver supply the full native tree, real input and close assertions. The installed
owner uses the same `observeTemplate` lifecycle and shared ready-time module
capture as the checkout owner. No duplicate counter component or scenario is
introduced.

Development launches the absolute installed CLI with the absolute consumer and
explicit host, from an unrelated working directory. The actual temporary module
and map are retained at the ready IPC boundary. Its source map is interpreted
against the original module directory, and that temporary directory must be gone
after the CLI exits. AOT launches the inspected consumer executable from an
unrelated directory with `BUN_NATIVE_HOST` unset, exercising its adjacent copied
host. No consumer source is copied back into the checkout.

Every case requires the complete zero-counter paint, a fresh ordered native
pointer down/up at the injected logical pixel, and the complete one-counter paint.
The native renderer must report software emulation. The original 30-second input
and paint deadline, 35-second IPC-owner deadline and five-second OS-close decision
remain. Real Alt+F4 must produce exactly one ready/stopped pair, all seven public
ownership counters at zero, joined IPC and exit zero. Forced cleanup, remaining
observed processes or an unreaped owner fail the case. Existing PID/start-time,
nonce, fresh-log-offset and full-paint requirements remain intact.

Owned consumer/cache directories are removed only after their terminal command
ownership receipts allow it. A persisted running command cannot authorize cleanup,
even if its last recorded state precedes process creation. Final absence is
required for a passing cohort. A missing
ownership marker or unverified descendant cleanup preserves the directory and
fails, rather than deleting an unproven resource. Sampling is labelled as observed
process evidence; it is not proof of absence between samples.

## Retained evidence and limits

The artifact retains the exact producer source inventory, compiler/host/build
identity, package-set manifest and seven archives, all package/consumer command
logs, unchanged generated source, installed lock/import/file receipts, AOT
manifests and emitted module/maps. Each native case retains its own raw input and
paint records, screenshots, lifecycle receipt and process/close diagnostics.
For each successful AOT build, the controller also copies the actual existing
`compile-aot.stdout.log`, `compile-aot.stderr.log` and `launcher.ts` into its
receipt directory before consumer cleanup, checking source and retained hashes.
These files were not copied by the original `d09ed906` controller. This retention
follow-up applies to the corrected source's future qualification; it does not
recover or replace missing original-run bytes.
Owned caches, node_modules, large AOT executables and duplicate staging trees are
omitted; their applicable input/output hashes remain. The existing unsigned host
archive remains separate and source-bound.

A pass establishes one Linux software-renderer interaction for each installed
framework/language/mode combination. It does not establish standalone watch,
physical GPU, IME/accessibility, macOS/Windows consumer installation, signed OS
packaging, long soak, cold-network setup or performance-regression budgets. Those
acceptance scopes remain separate. Only the actual first hosted results may be
reported as native qualification.
