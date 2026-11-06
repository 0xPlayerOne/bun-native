#!/usr/bin/env bash
# Run COMMAND inside a dedicated headless sway (wlroots) Wayland compositor.
# Run it under dbus-run-session. Never target a user's desktop: the
# compositor's sockets and IPC live in a private runtime directory, and X11
# is removed from the environment so GPUI must select its Wayland backend.
#
# Exports to COMMAND:
#   WAYLAND_DISPLAY, SWAYSOCK  the owned compositor and its IPC socket
#   BUN_NATIVE_WAYLAND_OUTPUT  the one headless output's name (HEADLESS-1)
# Input comes from the compositor itself: `swaymsg seat ... cursor` for the
# pointer and the virtual-keyboard protocol (wtype) for keys. grim reads
# pixels back through the compositor's screencopy protocol.
set -euo pipefail

if (( $# < 2 )); then
  echo 'usage: native-wayland-session.sh NEW_OUTPUT_DIR COMMAND [ARGS...]' >&2
  exit 1
fi
evidence_dir=$1
shift
mkdir "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd)
# Socket paths must fit sockaddr_un (108 bytes), which an evidence directory
# under a CI temp root can exceed, so the runtime directory is a short private
# one that is removed with the session.
XDG_RUNTIME_DIR=$(mktemp -d /tmp/bun-native-wayland.XXXXXX)
export XDG_RUNTIME_DIR
compositor=
stop_compositor() {
  if [[ -n "$compositor" ]]; then
    kill "$compositor" 2>/dev/null || true
    wait "$compositor" 2>/dev/null || true
  fi
  rm -rf "$XDG_RUNTIME_DIR"
}
trap stop_compositor EXIT
# The application must reach no X server: GPUI prefers Wayland when
# WAYLAND_DISPLAY is set, and an absent DISPLAY also rules out XWayland.
unset DISPLAY XAUTHORITY WAYLAND_DISPLAY WAYLAND_SOCKET SWAYSOCK ZED_HEADLESS
unset GPUI_X11_SCALE_FACTOR
export LIBGL_ALWAYS_SOFTWARE=1

shopt -s nullglob
software_icds=(/usr/share/vulkan/icd.d/lvp_icd*.json)
if (( ${#software_icds[@]} != 1 )); then
  echo 'Expected exactly one installed Mesa lavapipe ICD' >&2
  exit 1
fi
export VK_DRIVER_FILES="${software_icds[0]}"

# A HiDPI qualification may request one fixed integer output scale; all other
# evidence keeps scale 1.
case "${BUN_NATIVE_TEST_SCALE_FACTOR:-1}" in
  1|2) scale="${BUN_NATIVE_TEST_SCALE_FACTOR:-1}" ;;
  *)
    echo 'BUN_NATIVE_TEST_SCALE_FACTOR must be 1 or 2' >&2
    exit 1
    ;;
esac

# One output of 1280x800 logical pixels at that scale. Windows float at their
# requested size so the
# geometry the application asks for is the geometry the compositor maps; no
# borders, titlebars or gaps add offsets to pointer coordinates. The cursor
# never warps on focus changes, so only the test moves the pointer.
cat > "$evidence_dir/sway.conf" <<CONF
output HEADLESS-1 resolution $((1280 * scale))x$((800 * scale)) position 0 0 scale $scale
xwayland disable
default_border none
default_floating_border none
gaps inner 0
focus_follows_mouse no
mouse_warping none
for_window [title=".*"] floating enable
CONF

# wlroots' headless backend with no libinput devices and the CPU (pixman)
# renderer: no GPU, DRM or seat daemon is needed. Clients still render with
# Vulkan/GL (lavapipe) and hand the compositor shared-memory or dmabuf frames.
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
  sway --config "$evidence_dir/sway.conf" >"$evidence_dir/compositor.log" 2>&1 &
compositor=$!

ready=
for _ in {1..100}; do
  sockets=("$XDG_RUNTIME_DIR"/wayland-*[0-9] )
  ipc=("$XDG_RUNTIME_DIR"/sway-ipc.*.sock)
  if (( ${#sockets[@]} == 1 && ${#ipc[@]} == 1 )); then
    export WAYLAND_DISPLAY=${sockets[0]##*/} SWAYSOCK=${ipc[0]}
    if swaymsg -t get_outputs >"$evidence_dir/outputs.json" 2>/dev/null; then
      ready=1
      break
    fi
  fi
  if ! kill -0 "$compositor" 2>/dev/null; then
    echo 'The headless compositor exited before becoming ready' >&2
    cat "$evidence_dir/compositor.log" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ -z "$ready" ]]; then
  echo 'The headless compositor did not become ready' >&2
  exit 1
fi
swaymsg -t get_version >"$evidence_dir/compositor-version.json"
export BUN_NATIVE_WAYLAND_OUTPUT=HEADLESS-1

"$@"
