#!/usr/bin/env bash
# One long Linux session of a workspace soak fixture (#248, #250) in a private
# Xvfb/DBus/openbox session, with real X11 typing and wheel input each round.
#
#   native-workspace-long-session.sh solid|react development|aot PACKAGE NEW_OUTPUT SECONDS
#
# PACKAGE is the build-window.ts output for the <framework>-workspace-soak
# entry. BUN_NATIVE_HOST must name the release host the package was built
# against. Optional BUN_NATIVE_SOAK_PACE_MS and BUN_NATIVE_SOAK_SAMPLE_SECONDS
# pass through. The output keeps the fixture report, every sample
# (samples.jsonl), the host phase trace, the fixture log, a system load trace
# taken every 10 s, and the checker's summary.
set -euo pipefail

if (( $# != 5 )); then
  echo 'usage: native-workspace-long-session.sh solid|react development|aot PACKAGE NEW_OUTPUT SECONDS' >&2
  exit 1
fi
framework=$1
mode=$2
package=$(cd "$3" && pwd)
output=$4
seconds=$5
case "$framework" in solid|react) ;; *) echo 'Framework must be solid or react' >&2; exit 1 ;; esac
case "$mode" in
  development) command=(bun "$package/development/application.js") ;;
  aot) command=("$package/$framework-workspace-soak") ;;
  *) echo 'Mode must be development or aot' >&2; exit 1 ;;
esac
[[ "$seconds" =~ ^[0-9]+$ ]] || { echo 'SECONDS must be a whole number' >&2; exit 1; }
[[ -x "${BUN_NATIVE_HOST:-}" ]] || { echo 'BUN_NATIVE_HOST must name the release host' >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

mkdir "$output"
output=$(cd "$output" && pwd)
mkdir "$output/fixture"
{
  echo "framework=$framework"
  echo "mode=$mode"
  echo "seconds=$seconds"
  echo "host=$BUN_NATIVE_HOST"
  echo "hostSha256=$(sha256sum "$BUN_NATIVE_HOST" | cut -d' ' -f1)"
  if [[ "$mode" == aot ]]; then
    echo "executableSha256=$(sha256sum "${command[0]}" | cut -d' ' -f1)"
  fi
  echo "bun=$(bun --revision)"
  echo "kernel=$(uname -sr)"
  echo "cpus=$(nproc)"
  echo "cpuModel=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
  echo "started=$(date -u +%FT%TZ)"
} > "$output/environment.txt"

# Whole-machine load: the container is shared with other work.
(
  printf 'epoch\tload1\tload5\tload15\tcpuBusyPercent\n'
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  busy=$((user + nice + system + irq + softirq + steal)); total=$((busy + idle + iowait))
  while sleep 10; do
    read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
    now_busy=$((user + nice + system + irq + softirq + steal)); now_total=$((now_busy + idle + iowait))
    read -r l1 l5 l15 _ < /proc/loadavg
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" "$l1" "$l5" "$l15" \
      "$(( (now_busy - busy) * 100 / (now_total - total > 0 ? now_total - total : 1) ))"
    busy=$now_busy; total=$now_total
  done
) > "$output/system-load.tsv" &
load_sampler=$!
trap 'kill "$load_sampler" 2>/dev/null || true' EXIT

status=0
BUN_NATIVE_DIAGNOSTICS_DIR="$output/fixture" \
  BUN_NATIVE_SOAK_SECONDS="$seconds" \
  BUN_NATIVE_SOAK_OS_INPUT=1 \
  BUN_NATIVE_PHASE_TRACE="$output/phases.json" \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash "$root/scripts/quality/native-linux-session.sh" \
  "$output/session" -- timeout "$((seconds + 900))s" "${command[@]}" \
  > "$output/fixture.log" 2>&1 || status=$?
echo "finished=$(date -u +%FT%TZ)" >> "$output/environment.txt"
echo "fixtureExit=$status" >> "$output/environment.txt"
if (( status != 0 )); then
  tail -40 "$output/fixture.log" >&2
  exit "$status"
fi
python3 "$root/scripts/quality/native-$framework-workspace-soak.py" \
  "$output/fixture/soak-result.json" --long-session "$seconds" \
  --phases "$output/phases.json" | tee "$output/summary.json"
