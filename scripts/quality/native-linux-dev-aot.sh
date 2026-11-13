#!/usr/bin/env bash
# The development and inspected AOT runs of one native Linux fixture, each in
# its own isolated Xvfb and DBus session (native-x11-session.sh).
#
# usage: native-linux-dev-aot.sh --entry NAME --evidence TEMPLATE [OPTIONS] [-- SESSION_COMMAND...]
#   --entry NAME         the AOT run is $NATIVE_EVIDENCE/NAME-package/NAME
#   --dev COMMAND        the development command, split on spaces (default:
#                        bun $NATIVE_EVIDENCE/NAME-package/development/application.js)
#   --modes LIST         the runs, in order (default: "development aot")
#   --evidence TEMPLATE  the run's evidence directory, $NATIVE_EVIDENCE/TEMPLATE;
#                        its session directory adds the suffix -session
#   --run-log            create the evidence directory and tee the session to its run.log
#   --require FILE       fail unless the run left a non-empty FILE in its evidence directory
#   --env NAME=TEMPLATE  set for the whole session (repeatable)
#   --screen WxHxD       an Xvfb screen (repeatable; default 1280x800x24)
#
# TEMPLATE values expand {mode}, {evidence} and {nonce}, a fresh 128-bit hex
# nonce per run. In SESSION_COMMAND the word {app} becomes the run's
# application command; without a SESSION_COMMAND the application runs directly.
set -euo pipefail
# Empty arrays use ${a[@]+"${a[@]}"}: bash 3.2 (macOS) treats them as unset under -u.

usage() {
  sed -n '5,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

entry=''
dev=''
modes='development aot'
evidence_template=''
run_log=0
required=()
environment_templates=()
screens=()
while (( $# )); do
  case "$1" in
    --entry|--dev|--modes|--evidence|--require|--env|--screen)
      (( $# >= 2 )) || usage
      case "$1" in
        --entry) entry=$2 ;;
        --dev) dev=$2 ;;
        --modes) modes=$2 ;;
        --evidence) evidence_template=$2 ;;
        --require) required+=("$2") ;;
        --env) environment_templates+=("$2") ;;
        --screen) screens+=(--screen "$2") ;;
      esac
      shift 2
      ;;
    --run-log) run_log=1; shift ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
[[ -n "$entry" && -n "$evidence_template" ]] || usage
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
  if [[ "${environment_templates[*]-} ${session_template[*]}" == *'{nonce}'* ]]; then
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
  run=(env ${environment[@]+"${environment[@]}"} bash "$here/native-x11-session.sh" ${screens[@]+"${screens[@]}"}
    "$evidence-session" -- "${command[@]}")
  if (( run_log )); then
    mkdir "$evidence"
    "${run[@]}" 2>&1 | tee "$evidence/run.log"
  else
    "${run[@]}"
  fi
  for file in ${required[@]+"${required[@]}"}; do
    if [[ ! -s "$evidence/$file" ]]; then
      echo "::error::The $mode run of $entry left no $evidence/$file" >&2
      exit 1
    fi
  done
done
