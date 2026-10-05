#!/usr/bin/env bats
# Tests for scripts/set-chart-value.mjs, used by the image workflows to commit new image tags.

bats_require_minimum_version 1.5.0

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../set-chart-value.mjs"
  VALUES="$BATS_TEST_TMPDIR/values.yaml"
  cat > "$VALUES" << 'EOF'
# top comment
image:
  repository: adlibcloudops.azurecr.io/agents/cumulus
  # renovate: datasource=docker depName=adlibcloudops.azurecr.io/agents/cumulus versioning=loose
  tag: "100"

worker:
  image:
    repository: adlibcloudops.azurecr.io/agents/cumulus-worker
    # renovate: datasource=docker depName=adlibcloudops.azurecr.io/agents/cumulus-worker versioning=loose
    tag: "200" # trailing comment
  tag: "not-this-one"
EOF
}

@test "sets a top-level nested value and keeps every other line" {
  run node "$SCRIPT" "$VALUES" image.tag 12345
  [ "$status" -eq 0 ]
  grep -qx '  tag: "12345"' "$VALUES"
  grep -qx '    tag: "200" # trailing comment' "$VALUES"
  grep -qx '# top comment' "$VALUES"
  grep -q 'renovate: datasource=docker depName=adlibcloudops.azurecr.io/agents/cumulus versioning=loose' "$VALUES"
}

@test "sets a deeper path without touching a same-named key at another level" {
  run node "$SCRIPT" "$VALUES" worker.image.tag 999
  [ "$status" -eq 0 ]
  grep -qx '    tag: "999" # trailing comment' "$VALUES"
  grep -qx '  tag: "not-this-one"' "$VALUES"
  grep -qx '  tag: "100"' "$VALUES"
}

@test "fails when the path does not exist and leaves the file unchanged" {
  cp "$VALUES" "$BATS_TEST_TMPDIR/before"
  run node "$SCRIPT" "$VALUES" worker.missing.tag 1
  [ "$status" -ne 0 ]
  cmp "$VALUES" "$BATS_TEST_TMPDIR/before"
}
