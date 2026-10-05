#!/usr/bin/env bats
# Tests for worker/entrypoint.sh (C-3, C-7). The agent is mocked with small shell commands.

bats_require_minimum_version 1.5.0

setup() {
  ENTRYPOINT="$BATS_TEST_DIRNAME/../entrypoint.sh"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
  export CUMULUS_WORKSPACE="$BATS_TEST_TMPDIR/ws/AB-1"
  export CUMULUS_INTERNAL_URL="http://orchestrator.test:8080"
  export CUMULUS_RUN_ID="run-1"
  export CUMULUS_RUN_TOKEN="secret"
  unset CUMULUS_HOOK_AFTER_CREATE CUMULUS_HOOK_BEFORE_RUN CUMULUS_HOOK_AFTER_RUN CUMULUS_HOOK_TIMEOUT_MS
  LOG="$BATS_TEST_TMPDIR/log"
}

@test "C-7 creates the workspace and runs the agent inside it" {
  run --separate-stderr "$ENTRYPOINT" bash -c 'pwd'
  [ "$status" -eq 0 ]
  [ "$output" = "$CUMULUS_WORKSPACE" ]
}

@test "C-3 rejects a relative workspace path with exit 70" {
  export CUMULUS_WORKSPACE="relative/ws"
  run --separate-stderr "$ENTRYPOINT" true
  [ "$status" -eq 70 ]
  [[ "$stderr" == *"CUMULUS_WORKSPACE"* ]]
}

@test "C-3 rejects a workspace path with .. segments" {
  export CUMULUS_WORKSPACE="$BATS_TEST_TMPDIR/ws/../escape"
  run --separate-stderr "$ENTRYPOINT" true
  [ "$status" -eq 70 ]
}

@test "C-7 runs after_create, before_run, agent, after_run in order with hook stdout on stderr" {
  export CUMULUS_HOOK_AFTER_CREATE="echo after_create >> '$LOG'; echo noisy-create"
  export CUMULUS_HOOK_BEFORE_RUN="echo before_run >> '$LOG'; echo noisy-before"
  export CUMULUS_HOOK_AFTER_RUN="echo after_run >> '$LOG'; echo noisy-after"
  run --separate-stderr "$ENTRYPOINT" bash -c "echo agent >> '$LOG'; echo agent-out"
  [ "$status" -eq 0 ]
  [ "$output" = "agent-out" ]
  [[ "$stderr" == *noisy-create* ]]
  [[ "$stderr" == *noisy-after* ]]
  [ "$(cat "$LOG")" = "$(printf 'after_create\nbefore_run\nagent\nafter_run')" ]
}

@test "§9.4 hooks run with the workspace as cwd" {
  export CUMULUS_HOOK_BEFORE_RUN="pwd > '$LOG'"
  run --separate-stderr "$ENTRYPOINT" true
  [ "$(cat "$LOG")" = "$CUMULUS_WORKSPACE" ]
}

@test "§9.4 after_create failure is fatal: exit 70 and the agent never starts" {
  export CUMULUS_HOOK_AFTER_CREATE="exit 3"
  run --separate-stderr "$ENTRYPOINT" bash -c "echo agent >> '$LOG'"
  [ "$status" -eq 70 ]
  [[ "$stderr" == *"after_create hook failed"* ]]
  [ ! -e "$LOG" ]
}

@test "§9.4 before_run timeout is fatal with exit 70" {
  export CUMULUS_HOOK_BEFORE_RUN="sleep 5"
  export CUMULUS_HOOK_TIMEOUT_MS=200
  run --separate-stderr "$ENTRYPOINT" bash -c "echo agent >> '$LOG'"
  [ "$status" -eq 70 ]
  [[ "$stderr" == *"before_run hook timed out after 200 ms"* ]]
  [ ! -e "$LOG" ]
}

@test "§9.4 after_run runs after a failing agent; its failure is ignored; agent exit code wins" {
  export CUMULUS_HOOK_AFTER_RUN="echo after_run >> '$LOG'; exit 9"
  run --separate-stderr "$ENTRYPOINT" bash -c 'exit 42'
  [ "$status" -eq 42 ]
  [ "$(cat "$LOG")" = "after_run" ]
}

@test "C-3 the agent reads the inherited stdin; hooks do not consume it" {
  export CUMULUS_HOOK_BEFORE_RUN="cat > /dev/null"
  run --separate-stderr bash -c "printf 'line1\nline2\n' | '$ENTRYPOINT' cat"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'line1\nline2')" ]
}

@test "C-4 SIGTERM is forwarded to the agent and after_run still runs" {
  export CUMULUS_HOOK_AFTER_RUN="echo after_run >> '$LOG'"
  "$ENTRYPOINT" bash -c "trap 'echo got-term >> \"$LOG\"; exit 143' TERM; echo ready >> '$LOG'; while :; do sleep 0.1; done" \
    < /dev/null > /dev/null 2>&1 &
  pid=$!
  for _ in $(seq 50); do grep -q ready "$LOG" 2> /dev/null && break; sleep 0.1; done
  kill -TERM "$pid"
  status=0
  wait "$pid" || status=$?
  [ "$status" -eq 143 ]
  grep -q got-term "$LOG"
  grep -q after_run "$LOG"
}

@test "C-10 configures git identity and the run-scoped credential helper" {
  run --separate-stderr "$ENTRYPOINT" true
  [ "$status" -eq 0 ]
  [ "$(git config --global user.name)" = "cumulus[bot]" ]
  [ "$(git config --global --get credential.https://github.com.helper)" = "/usr/local/bin/cumulus-git-credential" ]
}
