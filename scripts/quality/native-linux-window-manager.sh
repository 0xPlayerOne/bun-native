# Sourced by native-linux-session.sh: start the session's openbox and wait for
# it to own _NET_SUPPORTING_WM_CHECK on the root window.
#
# Xvfb (started by xvfb-run without -noreset) regenerates whenever its last
# fully connected client disconnects, and regeneration closes every client
# still in connection setup. A short-lived readiness probe that disconnects
# while openbox is still connecting therefore kills openbox ("Failed to open
# the display from the DISPLAY environment variable"). One root property
# watcher stays connected from before openbox starts until openbox is ready,
# and readiness is read from it, so the server never drops to zero connected
# clients in that window.
#
# Sets window_manager and window_manager_probe; the caller's exit trap must call
# stop_test_window_manager.

window_manager=
window_manager_probe=

stop_test_window_manager() {
  local pid
  for pid in "$window_manager_probe" "$window_manager"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

start_test_window_manager() {
  local evidence_dir=$1 attempt
  local probe_log="$evidence_dir/window-manager-probe.log"
  xprop -root -spy >"$probe_log" 2>&1 &
  window_manager_probe=$!
  openbox >"$evidence_dir/window-manager.log" 2>&1 &
  window_manager=$!
  for attempt in {1..50}; do
    if grep -q '^_NET_SUPPORTING_WM_CHECK(WINDOW): window id' "$probe_log"; then
      break
    fi
    if ! kill -0 "$window_manager" 2>/dev/null; then
      echo 'The test window manager exited before becoming ready' >&2
      return 1
    fi
    if ! kill -0 "$window_manager_probe" 2>/dev/null; then
      echo 'The window manager readiness probe lost the display' >&2
      return 1
    fi
    sleep 0.1
  done
  # openbox is a fully connected client from here on, so this probe's
  # disconnect cannot regenerate the server.
  kill "$window_manager_probe" 2>/dev/null || true
  wait "$window_manager_probe" 2>/dev/null || true
  window_manager_probe=
  xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'
}
