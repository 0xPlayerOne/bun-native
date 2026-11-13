# Bun Native's patched `gpui_linux`

This directory records the provenance of the adjacent copy of zed's `gpui_linux` crate. The upstream files come from zed `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` (`crates/gpui_linux`), the same revision every other GPUI crate in Bun Native's lockfile uses. Upstream's `LICENSE-APACHE` is a symlink to zed's root license; the copy here is that file's content as a regular file. This is the one crate alone, not a GPUI upgrade. The root `Cargo.toml` patches it in by path for the zed Git source, next to [`gpui_macos`](../../gpui_macos/bun-native/README.md).

## The patch

`credentials-feature.patch` changes one file, `src/linux/platform.rs`:

- `KEYRING_LABEL` and the `oo7` bodies of `write_credentials`, `read_credentials` and `delete_credentials` compile only with the new `credentials` Cargo feature.
- Without it, the three methods return `Task::ready(Err(..))` at once, saying the credentials store is unavailable.

The standalone `Cargo.toml` declares `credentials = ["dep:oo7"]` and makes `oo7` optional. Nothing enables the feature: zed's `gpui_platform` depends on `gpui_linux` with `default-features = false` and only forwards `wayland`, `x11` and `screen-capture`.

## Why

Upstream lists `oo7` under "Always used". Bun Native never calls GPUI's credentials API (no use in `native/gpui-host/src`), but linking `oo7` costs about 10% of the Linux host's code:

- `oo7` enables `zvariant`'s `gvariant` feature (and `zbus_macros`'s), and nothing else in the graph does. `zvariant` dispatches on the encoding format, so every type the host, `zbus`, `atspi`, `accesskit_unix`, `ashpd` and `notify-rust` serialize over D-Bus also got a GVariant instantiation (about 1.4 MB of `.text` in the 0.33.0 host).
- `oo7` itself and its crypto stack (`aes`, `cbc`, `hkdf`, `hmac`, `md-5`, `num-bigint-dig`, `pbkdf2`, `sha2`, ...) add about 0.6 MB, and 24 crates leave the lockfile.

D-Bus messages always use the D-Bus wire format; GVariant is only used for oo7's own file-backed keyring, so no runtime behavior the host relies on changes. The measured effect is in [docs/reproducible-builds.md](../../../../docs/reproducible-builds.md#release-profile-and-binary-size).

Upstream: the same switch is worth offering to zed (an optional `credentials` feature, on by default for Zed itself), after which this vendor can be retired.

## Files

`Cargo.toml.upstream` and `workspace.toml.upstream` preserve both original manifests (the workspace manifest is byte-identical to the one `gpui_macos` keeps). The standalone `Cargo.toml` expands their inherited metadata and dependencies, keeps target conditions, optional flags and default-feature settings, and changes only `oo7` (optional) and the new feature. The sibling zed crates (`gpui`, `gpui_util`, `gpui_wgpu`, `collections`, `http_client`) keep the original Git URL and exact revision. The crate has its own workspace boundary.

`upstream.json` records the byte size and SHA-256 of every upstream file and of zed's workspace manifest. Every file outside `src/linux/platform.rs` and `Cargo.toml` is byte-identical to upstream. Reversing the patch on the vendored `src` reproduces upstream exactly:

```sh
work=$(mktemp -d) && cp -r native/vendor/gpui_linux/src "$work/" &&
  patch -R -p1 -d "$work" < native/vendor/gpui_linux/bun-native/credentials-feature.patch &&
  diff -r "$work/src" "$ZED_BA63A022/crates/gpui_linux/src"
```

The lockfile drops `gpui_linux`'s Git source line, its `oo7` dependency and the crates only `oo7` used, and `zvariant` no longer depends on `serde_bytes` (its `gvariant` feature).
