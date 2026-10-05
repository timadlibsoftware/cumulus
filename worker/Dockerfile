# syntax=docker/dockerfile:1
# Cumulus agent worker image (CUMULUS-SPEC C-3). One container per run, started by the orchestrator
# as a Kubernetes Job; tini is PID 1 and the entrypoint speaks nothing on stdout but the agent.
#
# Build context: worker/. CloudOps-Skills is a private repo, so it comes in as a named build context
# checked out at CLOUDOPS_SKILLS_REF:
#   docker build --build-context cloudops-skills=<checkout> -t cumulus-worker worker
FROM ubuntu:24.04

# --- Pinned tool versions -------------------------------------------------------------------------
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_VERSION=1.18.34
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.289
# renovate: datasource=github-releases depName=hashicorp/terraform extractVersion=^v(?<version>.*)$
ARG TERRAFORM_VERSION=1.16.5
# renovate: datasource=pypi depName=azure-cli
ARG AZURE_CLI_VERSION=2.90.0
ARG AZURE_DEVOPS_EXTENSION_VERSION=1.0.8
# renovate: datasource=github-tags depName=aws/aws-cli
ARG AWS_CLI_VERSION=2.37.9
# Google Cloud CLI from the official apt repo (packages.cloud.google.com), pinned at first build.
ARG GCLOUD_VERSION=587.0.0
# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.14.8
# renovate: datasource=node-version depName=node
ARG NODE_VERSION=26.10.0
# renovate: datasource=dotnet-version depName=dotnet-sdk
ARG DOTNET_SDK_VERSION=10.0.401
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.*)$
ARG GH_VERSION=2.102.0
# renovate: datasource=github-releases depName=mikefarah/yq
ARG YQ_VERSION=v4.54.1
# renovate: datasource=npm depName=corepack
ARG COREPACK_VERSION=0.36.0
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=10.34.6
# renovate: datasource=github-releases depName=grafana/mcp-grafana
ARG MCP_GRAFANA_VERSION=v2.0.0
# CloudOps-Skills commit (https://github.com/Adlibsoftware/cloudops-skills); the workflow checks it out.
ARG CLOUDOPS_SKILLS_REF=bc67950adbeb81890cc751cad38918aa60b84a9e

LABEL org.opencontainers.image.source="https://github.com/Adlibsoftware/cumulus" \
      org.opencontainers.image.title="cumulus-worker" \
      com.adlibsoftware.cloudops-skills.ref="${CLOUDOPS_SKILLS_REF}"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TZ=Etc/UTC \
    DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    AZURE_EXTENSION_DIR=/opt/az/extensions \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# --- Base OS packages -----------------------------------------------------------------------------
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl fd-find git git-lfs gnupg jq less libicu74 libssl-dev \
      libsecret-1-0 locales nano openssh-client pkg-config procps ripgrep tar tini tzdata unzip wget xz-utils zip \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# --- Vendor apt repos: GitHub CLI, Azure CLI, Google Cloud CLI ------------------------------------
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ noble main" \
      > /etc/apt/sources.list.d/azure-cli.list \
 && echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "gh=${GH_VERSION}" \
      "azure-cli=${AZURE_CLI_VERSION}-1~noble" \
      "google-cloud-cli=${GCLOUD_VERSION}-0" \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p "${AZURE_EXTENSION_DIR}" \
 && az extension add --name azure-devops --version "${AZURE_DEVOPS_EXTENSION_VERSION}" --yes \
 && chmod -R a+rX "${AZURE_EXTENSION_DIR}"

# --- Single-binary and tarball tools --------------------------------------------------------------
WORKDIR /tmp/install
RUN curl -fsSLO "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
 && curl -fsSLO "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \
 && grep " terraform_${TERRAFORM_VERSION}_linux_amd64.zip\$" "terraform_${TERRAFORM_VERSION}_SHA256SUMS" | sha256sum -c - \
 && unzip -q "terraform_${TERRAFORM_VERSION}_linux_amd64.zip" terraform -d /usr/local/bin \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" -o awscliv2.zip \
 && unzip -q awscliv2.zip && ./aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
 && grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
 && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" -o /usr/local/bin/yq \
 && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/checksums-bsd" \
      | sed -n 's/^SHA256 (yq_linux_amd64) = \([0-9a-f]*\)$/\1  \/usr\/local\/bin\/yq/p' | sha256sum -c - \
 && chmod 0755 /usr/local/bin/yq \
 && curl -fsSLO "https://github.com/grafana/mcp-grafana/releases/download/${MCP_GRAFANA_VERSION}/mcp-grafana_Linux_x86_64.tar.gz" \
 && curl -fsSL "https://github.com/grafana/mcp-grafana/releases/download/${MCP_GRAFANA_VERSION}/mcp-grafana_${MCP_GRAFANA_VERSION#v}_checksums.txt" \
      | grep ' mcp-grafana_Linux_x86_64.tar.gz$' | sha256sum -c - \
 && tar -xzf mcp-grafana_Linux_x86_64.tar.gz -C /usr/local/bin mcp-grafana \
 && curl -fsSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh \
 && bash dotnet-install.sh --version "${DOTNET_SDK_VERSION}" --install-dir "${DOTNET_ROOT}" --no-path \
 && ln -s "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet \
 && rm -rf /tmp/install

# --- uv + Python ----------------------------------------------------------------------------------
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /uvx /usr/local/bin/
RUN uv python install "${PYTHON_VERSION}" --default \
 && chmod -R a+rX "${UV_PYTHON_INSTALL_DIR}"

# --- Node-based tools: agents, Corepack/pnpm, pinned MCP servers ----------------------------------
COPY mcp-pins.json /opt/cumulus/mcp-pins.json
# MCP server packages are word-split from mcp-pins.json on purpose.
# hadolint ignore=SC2046
RUN npm install -g --no-fund --no-audit \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "corepack@${COREPACK_VERSION}" \
      $(jq -r 'to_entries[] | "\(.key)@\(.value.version)"' /opt/cumulus/mcp-pins.json) \
 && corepack enable pnpm \
 && npm cache clean --force

# --- Cumulus scripts ------------------------------------------------------------------------------
COPY --chmod=0755 entrypoint.sh /usr/local/bin/cumulus-entrypoint
COPY --chmod=0755 bin/cumulus-github-token bin/cumulus-git-credential bin/gh /usr/local/bin/
COPY convert/package.json /opt/cumulus/convert/package.json
COPY convert/src /opt/cumulus/convert/src

RUN useradd --create-home --uid 10001 --user-group --shell /bin/bash agent

# --- CloudOps-Skills: Claude Code plugin + OpenCode conversion ------------------------------------
# hadolint ignore=DL3022
COPY --from=cloudops-skills --chown=root:root . /opt/cloudops-skills
RUN rm -rf /opt/cloudops-skills/.git \
 && node /opt/cumulus/convert/src/cli.ts \
      --marketplace /opt/cloudops-skills \
      --pins /opt/cumulus/mcp-pins.json \
      --out /opt/cumulus/opencode \
 && cp /opt/cumulus/opencode/claude-marketplace.json /opt/cloudops-skills/.claude-plugin/marketplace.json \
 && cp /opt/cumulus/opencode/UNMAPPED.md /opt/cumulus/UNMAPPED.md \
 && chmod -R a+rX /opt/cloudops-skills /opt/cumulus

# Numeric so Kubernetes runAsNonRoot can verify it.
USER 10001:10001
WORKDIR /home/agent
RUN corepack install --global "pnpm@${PNPM_VERSION}" \
 && mkdir -p .config/opencode \
 && cp /opt/cumulus/opencode/opencode.json .config/opencode/opencode.json \
 && cp -r /opt/cumulus/opencode/skills .config/opencode/skills \
 && claude plugin marketplace add /opt/cloudops-skills \
 && claude plugin install devops-skills@cloudops-skills

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/cumulus-entrypoint"]
