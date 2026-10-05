#!/usr/bin/env bash
# Cumulus worker entrypoint (CUMULUS-SPEC C-3, C-7). Runs under tini as PID 1.
#
# Contract with the orchestrator (env):
#   CUMULUS_WORKSPACE           absolute workspace path inside the container (required)
#   CUMULUS_HOOK_AFTER_CREATE   hook scripts (optional), run with `bash -lc` in the workspace
#   CUMULUS_HOOK_BEFORE_RUN
#   CUMULUS_HOOK_AFTER_RUN
#   CUMULUS_HOOK_TIMEOUT_MS     per-hook timeout, default 60000 (§5.3.4)
#   CUMULUS_INTERNAL_URL, CUMULUS_RUN_ID, CUMULUS_RUN_TOKEN   used by the git/gh token helpers
# argv: the agent command, e.g. `bash -lc "opencode acp"`.
#
# stdout is the agent protocol stream: only the agent may write to it. Everything this script
# and the hooks print goes to stderr, and hooks never read the agent's stdin.
set -euo pipefail

readonly SETUP_FAILED=70

die() {
  echo "cumulus-entrypoint: $*" >&2
  exit "$SETUP_FAILED"
}

timeout_ms="${CUMULUS_HOOK_TIMEOUT_MS:-60000}"
if [[ ! "$timeout_ms" =~ ^[0-9]+$ ]] || ((10#$timeout_ms == 0)); then
  die "CUMULUS_HOOK_TIMEOUT_MS must be a positive integer"
fi
timeout_ms=$((10#$timeout_ms))
timeout_s="$(printf '%d.%03d' $((timeout_ms / 1000)) $((timeout_ms % 1000)))"

# run_hook <name> <script>: returns 0 on success, 124 on timeout, the hook's status otherwise.
run_hook() {
  local name="$1" script="$2" rc=0
  [[ -n "$script" ]] || return 0
  echo "cumulus-entrypoint: running $name hook" >&2
  timeout --kill-after=5 "$timeout_s" bash -lc "$script" < /dev/null >&2 || rc=$?
  if ((rc == 124 || rc == 137)); then
    echo "cumulus-entrypoint: $name hook timed out after $timeout_ms ms" >&2
    return 124
  elif ((rc != 0)); then
    echo "cumulus-entrypoint: $name hook failed (exit $rc)" >&2
  fi
  return "$rc"
}

(($# > 0)) || die "no agent command given"
workspace="${CUMULUS_WORKSPACE:-}"
[[ "$workspace" == /* ]] || die "CUMULUS_WORKSPACE must be an absolute path"
[[ "/$workspace/" != *"/../"* && "/$workspace/" != *"/./"* ]] || die "CUMULUS_WORKSPACE must be normalized"

mkdir -p "$workspace" || die "cannot create workspace $workspace"
cd "$workspace"
[[ "$PWD" == "$workspace" ]] || die "workspace cwd mismatch: $PWD != $workspace"

git config --global user.name "cumulus[bot]"
git config --global user.email "${CUMULUS_GIT_EMAIL:-cumulus[bot]@users.noreply.github.com}"
git config --global credential.https://github.com.helper /usr/local/bin/cumulus-git-credential
git config --global credential.https://github.com.useHttpPath false

# C-7: the workspace is always new, so after_create runs on every attempt.
run_hook after_create "${CUMULUS_HOOK_AFTER_CREATE:-}" || die "after_create hook failed; aborting run"
run_hook before_run "${CUMULUS_HOOK_BEFORE_RUN:-}" || die "before_run hook failed; aborting run"

# Run the agent in the background so this script can forward signals and run after_run.
# The explicit `<&0` keeps the inherited stdin (bash would otherwise give it /dev/null).
"$@" <&0 &
agent_pid=$!
# shellcheck disable=SC2329 # invoked from the traps below
forward() { kill -s "$1" "$agent_pid" 2> /dev/null || true; }
trap 'forward TERM' TERM
trap 'forward INT' INT

status=0
while :; do
  status=0
  wait "$agent_pid" || status=$?
  # A trapped signal interrupts `wait` while the agent is still running: wait again.
  kill -0 "$agent_pid" 2> /dev/null || break
done
trap - TERM INT

run_hook after_run "${CUMULUS_HOOK_AFTER_RUN:-}" || echo "cumulus-entrypoint: ignoring after_run failure" >&2
exit "$status"
