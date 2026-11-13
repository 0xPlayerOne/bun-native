#!/usr/bin/env bash
# One isolated Xvfb server and DBus session around native-linux-session.sh, the
# wrapper every native Linux X11 step uses. Never targets a user's desktop.
#
# usage: native-x11-session.sh [--screen WxHxD]... NEW_OUTPUT_DIR MODE COMMAND [ARGS...]
#   --screen  one Xvfb screen per use, numbered from 0 (default: 1280x800x24)
# The remaining arguments are native-linux-session.sh's.
set -euo pipefail

screens=()
while [[ "${1:-}" == --screen ]]; do
  if (( $# < 2 )); then
    echo 'native-x11-session.sh: --screen needs WxHxD' >&2
    exit 2
  fi
  screens+=("$2")
  shift 2
done
if (( ${#screens[@]} == 0 )); then
  screens=(1280x800x24)
fi
server_args=''
for index in "${!screens[@]}"; do
  server_args+="-screen $index ${screens[$index]} "
done

exec xvfb-run --auto-servernum --server-args="${server_args}-nolisten tcp" \
  dbus-run-session -- bash "$(dirname "${BASH_SOURCE[0]}")/native-linux-session.sh" "$@"
