#!/usr/bin/env bash
# Smoke test for a built worker image: pinned tool versions, non-root user, tini as PID 1,
# CloudOps-Skills installed for both agents. Expected versions are read from the Dockerfile ARGs.
#
# Usage: worker/test/smoke.sh <image>
# shellcheck disable=SC2016 # commands are expanded inside the image, not here
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
dockerfile="$(dirname "$0")/../Dockerfile"
failures=0

arg() { sed -n "s/^ARG $1=//p" "$dockerfile"; }

# in_image <cmd>: run a shell command in the image as its default user, bypassing the entrypoint.
in_image() { docker run --rm --entrypoint bash -e GH_TOKEN=smoke "$image" -lc "$1" 2>&1; }

check() {
  local name="$1" expected="$2" actual
  actual="$(in_image "$3" || true)"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "ok   $name: $expected"
  else
    echo "FAIL $name: expected '$expected', got: $actual"
    failures=$((failures + 1))
  fi
}

check opencode "$(arg OPENCODE_VERSION)" 'opencode --version'
check claude-code "$(arg CLAUDE_CODE_VERSION)" 'claude --version'
check terraform "Terraform v$(arg TERRAFORM_VERSION)" 'terraform version'
check azure-cli "\"azure-cli\": \"$(arg AZURE_CLI_VERSION)\"" 'az version -o json'
check azure-devops-ext "\"azure-devops\": \"$(arg AZURE_DEVOPS_EXTENSION_VERSION)\"" 'az version -o json'
check aws-cli "aws-cli/$(arg AWS_CLI_VERSION)" 'aws --version'
check gcloud "Google Cloud SDK $(arg GCLOUD_VERSION)" 'gcloud version'
check python "Python $(arg PYTHON_VERSION)" 'python3 --version'
check python-alias "Python $(arg PYTHON_VERSION)" 'python --version'
check node "v$(arg NODE_VERSION)" 'node --version'
check dotnet "$(arg DOTNET_SDK_VERSION)" 'dotnet --version'
check gh "gh version $(arg GH_VERSION)" 'gh --version'
check gh-wrapper "/usr/local/bin/gh" 'command -v gh'
check yq "version $(arg YQ_VERSION)" 'yq --version'
check pnpm "$(arg PNPM_VERSION)" 'pnpm --version'
check uv "uv " 'uv --version'
check git-lfs "git-lfs/" 'git lfs version'
check tools "ok" 'for t in git ssh rg fd jq curl wget unzip zip xz make gcc pkg-config less nano ps tar mcp-grafana azmcp mcp-server-azuredevops cumulus-git-credential cumulus-github-token; do command -v "$t" > /dev/null || { echo "missing $t"; exit 1; }; done; echo ok'
check ado-mcp-loads "ok" 'timeout 15 mcp-server-azuredevops adlibsoftware -a azcli < /dev/null > /tmp/out 2>&1; if grep -q "cannot open shared object" /tmp/out; then cat /tmp/out; else echo ok; fi'
check locale "UTF-8" 'locale charmap'
check user "uid=10001(agent)" 'id'
check opencode-mcp "mcp-server-azuredevops" 'jq -c ".mcp[\"azure-devops\"].command" ~/.config/opencode/opencode.json'
check opencode-skills "SKILL.md" 'ls ~/.config/opencode/skills/kubernetes-troubleshooting'
check claude-plugin "devops-skills@cloudops-skills" 'claude plugin list'
check unmapped "# Unmapped CloudOps-Skills features" 'cat /opt/cumulus/UNMAPPED.md'

# Through the real entrypoint: tini is PID 1 and the agent's stdout is all that reaches stdout.
pid1="$(docker run --rm -e CUMULUS_WORKSPACE=/tmp/ws/SMOKE-1 "$image" bash -c 'cat /proc/1/comm; pwd' 2> /dev/null)"
if [[ "$pid1" == "$(printf 'tini\n/tmp/ws/SMOKE-1')" ]]; then
  echo "ok   entrypoint: tini is PID 1, agent runs in the workspace"
else
  echo "FAIL entrypoint: got: $pid1"
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "$failures smoke check(s) failed" >&2
  exit 1
fi
echo "all smoke checks passed"
