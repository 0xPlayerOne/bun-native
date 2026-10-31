#!/usr/bin/env bash
# Run inside a dedicated Xvfb and DBus session. Never target a user's desktop.
set -euo pipefail

if (( $# < 3 )); then
  echo 'usage: native-linux-session.sh NEW_OUTPUT_DIR {development|aot|--} COMMAND [ARGS...]' >&2
  exit 1
fi
evidence_dir=$1
mode=$2
shift 2
if [[ "$mode" != development && "$mode" != aot && "$mode" != -- ]]; then
  echo 'Choose development, aot, or -- followed by an explicit session command' >&2
  exit 1
fi
mkdir "$evidence_dir"
evidence_dir=$(cd "$evidence_dir" && pwd)
export XDG_RUNTIME_DIR="$evidence_dir/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
export GPUI_X11_SCALE_FACTOR=1
export LIBGL_ALWAYS_SOFTWARE=1
unset WAYLAND_DISPLAY WAYLAND_SOCKET ZED_HEADLESS

# Mesa's JSON filename differs between distribution versions. Require one
# software Vulkan ICD and keep its exact path in every evidence report.
shopt -s nullglob
software_icds=(/usr/share/vulkan/icd.d/lvp_icd*.json)
if (( ${#software_icds[@]} != 1 )); then
  echo 'Expected exactly one installed Mesa lavapipe ICD' >&2
  exit 1
fi
export VK_DRIVER_FILES="${software_icds[0]}"

openbox >"$evidence_dir/window-manager.log" 2>&1 &
window_manager=$!
cleanup_session() {
  kill "$window_manager" 2>/dev/null || true
  wait "$window_manager" 2>/dev/null || true
}
trap cleanup_session EXIT

for attempt in {1..50}; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
    break
  fi
  if ! kill -0 "$window_manager" 2>/dev/null; then
    echo 'The test window manager exited before becoming ready' >&2
    exit 1
  fi
  sleep 0.1
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'

if [[ "$mode" == -- ]]; then
  "$@"
  exit
fi

if [[ "$mode" == development ]]; then
  # This test reopens five real windows in one host and checks invalid states.
  timeout 45s bun tests/native/lifecycle.ts 2>&1 | tee "$evidence_dir/lifecycle.log"
fi

python3 scripts/quality/native-input-linux.py \
  --output "$evidence_dir/click" --mode "$mode" --timeout 30 --expect-software-renderer \
  --click 100 145 \
  --expect-event '{"type":"click","stage":"bun-application"}' \
  --expect-render '{"type":"rendered","stage":"native-paint","text":"Clicks: 1","input":""}' \
  -- "$@"

# A fresh launch after a verified OS close must regain input focus and work.
python3 scripts/quality/native-input-linux.py \
  --output "$evidence_dir/input" --mode "$mode" --timeout 30 --expect-software-renderer \
  --key ctrl+a --text 'Bun Native {nonce}' \
  --expect-event '{"type":"input","stage":"bun-application","value":"Bun Native {nonce}"}' \
  --expect-render '{"type":"rendered","stage":"native-paint","text":"Clicks: 0","input":"Bun Native {nonce}"}' \
  -- "$@"
