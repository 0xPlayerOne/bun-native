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
# openbox sets _NET_SUPPORTING_WM_CHECK early in its startup, before it loads
# its theme and screen state. A client message sent in that span, such as the
# input prime's _NET_REQUEST_FRAME_EXTENTS barrier, gets no answer. With a cold
# fontconfig cache the span is long enough that the first session of a CI job
# lost its barrier every time (0/10 locally). openbox publishes
# _NET_CLIENT_LIST from client_manage_all, the last step before its event
# loop, so readiness requires that property as well (10/10).
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
  local evidence_dir=$1 attempt ready=
  local probe_log="$evidence_dir/window-manager-probe.log"
  xprop -root -spy >"$probe_log" 2>&1 &
  window_manager_probe=$!
  openbox >"$evidence_dir/window-manager.log" 2>&1 &
  window_manager=$!
  for attempt in {1..50}; do
    if grep -q '^_NET_SUPPORTING_WM_CHECK(WINDOW): window id' "$probe_log" &&
      grep -q '^_NET_CLIENT_LIST(WINDOW)' "$probe_log"; then
      ready=1
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
  if [[ -z "$ready" ]]; then
    echo 'The test window manager did not finish starting' >&2
    return 1
  fi
  # openbox is a fully connected client from here on, so this probe's
  # disconnect cannot regenerate the server.
  kill "$window_manager_probe" 2>/dev/null || true
  wait "$window_manager_probe" 2>/dev/null || true
  window_manager_probe=
  xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'
}
