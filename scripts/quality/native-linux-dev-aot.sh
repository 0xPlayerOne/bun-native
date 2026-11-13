#!/usr/bin/env bash
# The development and inspected AOT runs of one native Linux fixture, each in
# its own isolated session: Xvfb and DBus (native-x11-session.sh) or headless
# sway under DBus (native-wayland-session.sh).
#
# usage: native-linux-dev-aot.sh --entry NAME --evidence TEMPLATE [OPTIONS] [-- SESSION_COMMAND...]
#   --entry NAME         the AOT run is $NATIVE_EVIDENCE/NAME-package/NAME
#   --dev COMMAND        the development command, split on spaces (default:
#                        bun $NATIVE_EVIDENCE/NAME-package/development/application.js)
#   --modes LIST         the runs, in order (default: "development aot")
#   --session KIND       x11 (default) or wayland
#   --evidence TEMPLATE  the run's evidence directory, $NATIVE_EVIDENCE/TEMPLATE;
#                        its session directory adds the suffix -session
#   --run-log            create the evidence directory and tee the session to its run.log
#   --log FILE           the same, teeing to FILE in the evidence directory
#   --require FILE       fail unless the run left a non-empty FILE in its evidence directory
#   --check COMMAND      run after each run, split on spaces after expansion (repeatable)
#   --env NAME=TEMPLATE  set for the whole session (repeatable)
#   --screen WxHxD       an Xvfb screen (repeatable; default 1280x800x24; x11 only)
#
# TEMPLATE and COMMAND values expand {mode}, {evidence} and {nonce}, a fresh
# 128-bit hex nonce per run. In SESSION_COMMAND the word {app} becomes the run's
# application command; without a SESSION_COMMAND the application runs directly.
set -euo pipefail
# Empty arrays use ${a[@]+"${a[@]}"}: bash 3.2 (macOS) treats them as unset under -u.

usage() {
  sed -n '6,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

entry=''
dev=''
modes='development aot'
evidence_template=''
session=x11
log=''
checks=()
required=()
environment_templates=()
screens=()
while (( $# )); do
  case "$1" in
    --entry|--dev|--modes|--session|--evidence|--log|--require|--check|--env|--screen)
      (( $# >= 2 )) || usage
      case "$1" in
        --entry) entry=$2 ;;
        --dev) dev=$2 ;;
        --modes) modes=$2 ;;
        --session) session=$2 ;;
        --evidence) evidence_template=$2 ;;
        --log) log=$2 ;;
        --require) required+=("$2") ;;
        --check) checks+=("$2") ;;
        --env) environment_templates+=("$2") ;;
        --screen) screens+=(--screen "$2") ;;
      esac
      shift 2
      ;;
    --run-log) log=run.log; shift ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
[[ -n "$entry" && -n "$evidence_template" ]] || usage
case "$session" in
  x11) ;;
  wayland) (( ${#screens[@]} == 0 )) || usage ;;
  *) usage ;;
esac
: "${NATIVE_EVIDENCE:?NATIVE_EVIDENCE must name the evidence directory}"
session_template=("$@")
if (( ${#session_template[@]} == 0 )); then
  session_template=('{app}')
fi
package="$NATIVE_EVIDENCE/$entry-package"
here=$(dirname "${BASH_SOURCE[0]}")

for mode in $modes; do
  case "$mode" in
    development)
      if [[ -n "$dev" ]]; then
        read -r -a application <<< "$dev"
      else
        application=(bun "$package/development/application.js")
      fi
      ;;
    aot) application=("$package/$entry") ;;
    *)
      echo "native-linux-dev-aot.sh: unknown mode $mode" >&2
      exit 2
      ;;
  esac
  nonce=''
  if [[ "${environment_templates[*]-} ${session_template[*]} ${checks[*]-}" == *'{nonce}'* ]]; then
    nonce=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
  fi
  evidence=''
  expand() {
    local value=$1
    value=${value//\{mode\}/$mode}
    value=${value//\{evidence\}/$evidence}
    value=${value//\{nonce\}/$nonce}
    printf '%s' "$value"
  }
  evidence="$NATIVE_EVIDENCE/$(expand "$evidence_template")"
  environment=()
  for pair in ${environment_templates[@]+"${environment_templates[@]}"}; do
    environment+=("$(expand "$pair")")
  done
  command=()
  for word in "${session_template[@]}"; do
    if [[ "$word" == '{app}' ]]; then
      command+=("${application[@]}")
    else
      command+=("$(expand "$word")")
    fi
  done
  if [[ "$session" == wayland ]]; then
    run=(env ${environment[@]+"${environment[@]}"} dbus-run-session -- bash "$here/native-wayland-session.sh"
      "$evidence-session" "${command[@]}")
  else
    run=(env ${environment[@]+"${environment[@]}"} bash "$here/native-x11-session.sh" ${screens[@]+"${screens[@]}"}
      "$evidence-session" -- "${command[@]}")
  fi
  if [[ -n "$log" ]]; then
    mkdir "$evidence"
    "${run[@]}" 2>&1 | tee "$evidence/$log"
  else
    "${run[@]}"
  fi
  for file in ${required[@]+"${required[@]}"}; do
    if [[ ! -s "$evidence/$file" ]]; then
      echo "::error::The $mode run of $entry left no $evidence/$file" >&2
      exit 1
    fi
  done
  for check in ${checks[@]+"${checks[@]}"}; do
    read -r -a words <<< "$(expand "$check")"
    "${words[@]}"
  done
done
