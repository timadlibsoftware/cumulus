#!/usr/bin/env bats
# Tests for the GitHub token helpers in worker/bin (C-10). curl and the real gh are mocked.

bats_require_minimum_version 1.5.0

setup() {
  BIN="$BATS_TEST_DIRNAME/../bin"
  MOCKS="$BATS_TEST_TMPDIR/mocks"
  mkdir -p "$MOCKS"
  export CURL_LOG="$BATS_TEST_TMPDIR/curl.log"
  export CURL_RESPONSE='{"token":"ghs_abc","expires_at":"2026-10-05T00:00:00Z"}'
  cat > "$MOCKS/curl" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CURL_LOG"
printf '%s' "$CURL_RESPONSE"
EOF
  cat > "$MOCKS/real-gh" << 'EOF'
#!/usr/bin/env bash
echo "token=$GH_TOKEN args=$*"
EOF
  chmod +x "$MOCKS/curl" "$MOCKS/real-gh"
  export PATH="$MOCKS:$BIN:$PATH"
  export CUMULUS_INTERNAL_URL="http://cumulus.agents.svc.cluster.local:8080"
  export CUMULUS_RUN_ID="run-7"
  export CUMULUS_RUN_TOKEN="run-secret"
  export CUMULUS_REAL_GH="$MOCKS/real-gh"
  unset GH_TOKEN
}

@test "C-10 token helper calls the run's git-token endpoint with the bearer run token" {
  run --separate-stderr cumulus-github-token
  [ "$status" -eq 0 ]
  [ "$output" = "ghs_abc" ]
  grep -qx "http://cumulus.agents.svc.cluster.local:8080/internal/runs/run-7/git-token" "$CURL_LOG"
  grep -qx "Authorization: Bearer run-secret" "$CURL_LOG"
}

@test "C-10 token helper accepts a plain-text token body" {
  export CURL_RESPONSE="ghs_plain"
  run --separate-stderr cumulus-github-token
  [ "$output" = "ghs_plain" ]
}

@test "C-10 token helper fails without the run environment" {
  unset CUMULUS_RUN_TOKEN
  run --separate-stderr cumulus-github-token
  [ "$status" -ne 0 ]
  [[ "$stderr" == *CUMULUS_RUN_TOKEN* ]]
}

@test "C-10 token helper fails on an empty token" {
  export CURL_RESPONSE='{"token":""}'
  run --separate-stderr cumulus-github-token
  [ "$status" -ne 0 ]
}

@test "C-10 git credential helper answers get with x-access-token" {
  run --separate-stderr bash -c "printf 'protocol=https\nhost=github.com\n\n' | cumulus-git-credential get"
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'username=x-access-token\npassword=ghs_abc')" ]
}

@test "C-10 git credential helper ignores store and erase" {
  run --separate-stderr bash -c "printf 'host=github.com\n\n' | cumulus-git-credential store"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$CURL_LOG" ]
}

@test "C-10 gh wrapper runs the real gh with a fresh GH_TOKEN" {
  run --separate-stderr "$BIN/gh" pr list --repo Adlibsoftware/x
  [ "$status" -eq 0 ]
  [ "$output" = "token=ghs_abc args=pr list --repo Adlibsoftware/x" ]
}

@test "C-10 gh wrapper keeps an explicit GH_TOKEN" {
  export GH_TOKEN="preset"
  run --separate-stderr "$BIN/gh" auth status
  [ "$output" = "token=preset args=auth status" ]
  [ ! -e "$CURL_LOG" ]
}
