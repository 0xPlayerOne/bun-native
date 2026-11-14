#!/usr/bin/env bash
# Run two independently calibrated preparations and then alternating Core/AOT clicks
# inside one already-isolated X11/DBus session. All paths are supplied by the workflow.
set -euo pipefail
: "${PAIR_ROOT:?}" "${PAIR_BASELINE_SOURCE:?}" "${PAIR_CANDIDATE_SOURCE:?}" \
  "${PAIR_BASELINE_HOST:?}" "${PAIR_CANDIDATE_HOST:?}" "${PAIR_BASELINE_SHA:?}" \
  "${PAIR_CANDIDATE_SHA:?}" "${PAIR_OUTPUT:?}"

(
  cd "$PAIR_BASELINE_SOURCE"
  bun benchmarks/comparison/run.ts --host "$PAIR_BASELINE_HOST" --host-profile release \
    --output "$PAIR_OUTPUT/baseline" --adapters core --trials 3 --input-trials 0
)
(
  cd "$PAIR_CANDIDATE_SOURCE"
  bun benchmarks/comparison/run.ts --host "$PAIR_CANDIDATE_HOST" --host-profile release \
    --output "$PAIR_OUTPUT/candidate" --adapters core --trials 3 --input-trials 0
)
cd "$PAIR_ROOT"
bun benchmarks/comparison/paired-input.ts \
  --baseline "$PAIR_OUTPUT/baseline" --candidate "$PAIR_OUTPUT/candidate" \
  --baseline-source "$PAIR_BASELINE_SOURCE" --candidate-source "$PAIR_CANDIDATE_SOURCE" \
  --baseline-host "$PAIR_BASELINE_HOST" --candidate-host "$PAIR_CANDIDATE_HOST" \
  --baseline-commit "$PAIR_BASELINE_SHA" --candidate-commit "$PAIR_CANDIDATE_SHA" \
  --output "$PAIR_OUTPUT/pairs" --pairs 20
