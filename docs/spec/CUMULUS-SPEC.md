# Cumulus Specification: Extensions and Modifications

This is a living document. It records every way Cumulus extends or modifies the upstream Symphony spec
in [`symphony-SPEC.md`](symphony-SPEC.md), pinned at `8001b52`, 2026-08-12. Upstream behavior applies
unless an entry here overrides it. Section references (`§`) point to the upstream document.

Rules (also in `AGENTS.md`):

- Check every decision against both documents.
- If they disagree, or neither covers a decision, stop and ask the user.
- Record the user's decision here in the same change.

## Entry format

```md
## C-<n>: <title>

- **Upstream:** §<section> (extends | modifies | variant of)
- **Decision:** what Cumulus does
- **Reason:** why upstream does not cover it
- **Decided:** <date>, <who>
- **Conformance impact:** which §17 rows change or are added
```

---

## C-1: Azure DevOps tracker adapter

- **Upstream:** §11 (extends)
- **Decision:** Add `tracker.kind: azure_devops`. Dispatch scope is the AdlibCTP project's DevOps
  backlog (area `AdlibCTP\DevOps` including children, iteration `AdlibCTP\Backlogs\DevOps`).
  - The adapter reports the **board column** (`System.BoardColumn`) as `Issue.state`, not
    `System.State`. The DevOps Stories board maps Backlog, Dev and Review all to `Active`, so
    `System.State` cannot tell them apart.
  - Active states: `Backlog`, `Dev`, `Test`.
  - Terminal states: `Done`, `Closed`. Reaching either stops the run and deletes unmerged
    `cumulus/*` branches (C-9).
  - Dispatch is opt-in: `required_labels: [cumulus]`, matched against work item tags.
  - The full profile is in [`docs/adapters/azure-devops.md`](../adapters/azure-devops.md).
- **Reason:** Upstream ships no Azure DevOps adapter. It defines only the generic interface.
- **Decided:** 2026-10-04, Tim. Scope, board-column source, active columns and opt-in tag. Done made
  terminal 2026-10-05, Tim.
- **Conformance impact:** §17.3 contract suite runs against this adapter with recorded HTTP fixtures.

## C-2: Protocol-neutral agent runner (OpenCode, Claude Code, later OMP)

- **Upstream:** §10, §5.3.6, §6.3 (modifies)
- **Decision:**
  - Replace the Codex app-server client with an `AgentRunner` contract. Each agent protocol is one
    adapter over a stdio byte stream:
    - OpenCode: ACP (JSON-RPC 2.0, NDJSON) via `opencode acp`. Implemented first.
    - Claude Code: NDJSON via `claude -p --input-format stream-json --output-format stream-json`.
      Implemented second.
    - OMP: NDJSON RPC via `omp --mode rpc`. Possible later.
  - Configuration moves from the `codex` front-matter key to a new extension key `runner`. Upstream
    keeps its `agent` key for scheduling limits.

    | Key                       | Type                        | Default                                                                                       | Reload          |
    | ------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- | --------------- |
    | `runner.kind`             | `opencode` \| `claude-code` | `opencode`                                                                                    | future sessions |
    | `runner.command`          | shell command string        | `opencode acp` / `claude -p --input-format stream-json --output-format stream-json --verbose` | future sessions |
    | `runner.model`            | string or null              | null (agent default)                                                                          | future sessions |
    | `runner.turn_timeout_ms`  | integer                     | `3600000`                                                                                     | future sessions |
    | `runner.read_timeout_ms`  | integer                     | `5000`                                                                                        | future sessions |
    | `runner.stall_timeout_ms` | integer, `<= 0` disables    | `300000`                                                                                      | next tick       |

    The `codex` key is ignored. Dispatch preflight (§6.3) checks for a supported `runner.kind` and a
    non-empty `runner.command` instead of `codex.command`.

  - OpenCode: the model is set with `session/set_model` when `runner.model` is set. A failure there is
    reported as `other_message` and the session continues on the agent's default model. ACP has no
    user-input request, so `turn_input_required` never occurs. Stop reasons `end_turn`, `max_tokens`
    and `max_turn_requests` complete the turn; `cancelled` → `turn_cancelled`; anything else →
    `turn_failed`.
  - Both agents run through the in-cluster LiteLLM proxy, which enforces the overall spend cap
    (decided 2026-10-05, Tim). OpenCode uses `worker.env.OPENCODE_CONFIG_CONTENT`. Claude Code uses
    `ANTHROPIC_BASE_URL`, with the LiteLLM key as `ANTHROPIC_AUTH_TOKEN` and the
    `ANTHROPIC_DEFAULT_*_MODEL` variables mapped to LiteLLM model names.
  - Claude Code: `--permission-mode bypassPermissions`, `--mcp-config` and `--model` are appended to
    `runner.command` at launch. `runner.read_timeout_ms` does not apply, because the process sends
    nothing before the first prompt.
  - Runtime events keep the §10.4 names. Token usage is reported as absolute session totals.
  - **Approval and user-input policy (§10.5):** high-trust inside the sandboxed worker pod.
    - Permission requests are auto-approved and emitted as `approval_auto_approved`.
    - User-input requests fail the turn immediately (`turn_input_required`).
    - Unsupported tool calls return a failure and the session continues.
- **Reason:** Upstream only specifies the Codex app-server protocol. We need several agents behind
  one contract.
- **Decided:** 2026-10-04, Tim (agents and their order). The `runner` key name follows the §5.3
  extension rule.
- **Conformance impact:** §17.5 rows run per adapter against scripted protocol transcripts.

## C-3: One Kubernetes Job per session with stdio attach

- **Upstream:** Appendix A (variant of)
- **Decision:**
  - Each worker run is one Kubernetes Job in the orchestrator's namespace. The orchestrator attaches
    to the container's stdin, stdout and stderr through the Kubernetes API and speaks the runner
    protocol over that stream.
  - Job settings: `backoffLimit: 0`, `restartPolicy: Never`, container `stdin: true`,
    `stdinOnce: true`.
  - Pods run as the `cumulus-agent` service account. It has workload identity and no Kubernetes RBAC.
  - `workspace.root` is interpreted inside the worker container.
  - New extension key `worker`:

    | Key                                 | Type                     | Default                                  |
    | ----------------------------------- | ------------------------ | ---------------------------------------- |
    | `worker.executor`                   | `kubernetes` \| `local`  | `kubernetes`                             |
    | `worker.namespace`                  | string                   | `$POD_NAMESPACE`, else `agents`          |
    | `worker.image`                      | string                   | `$CUMULUS_WORKER_IMAGE`                  |
    | `worker.service_account`            | string                   | `cumulus-agent`                          |
    | `worker.env_secret`                 | string or null           | `cumulus-agent-env`                      |
    | `worker.active_deadline_seconds`    | integer                  | `14400`                                  |
    | `worker.ttl_seconds_after_finished` | integer                  | `3600`                                   |
    | `worker.resources`                  | k8s ResourceRequirements | requests 1 CPU / 2Gi, limits 4 CPU / 8Gi |

    `local` runs the agent as a child process on the orchestrator host, for development and tests.
    Changes apply to future runs.

  - Worker contract (orchestrator → `worker/entrypoint.sh`):
    - Environment: `CUMULUS_WORKSPACE`, `CUMULUS_WORKSPACE_ROOT`, `CUMULUS_HOOK_AFTER_CREATE`,
      `CUMULUS_HOOK_BEFORE_RUN`, `CUMULUS_HOOK_AFTER_RUN`, `CUMULUS_HOOK_TIMEOUT_MS`,
      `CUMULUS_RUN_ID`, `CUMULUS_RUN_TOKEN`, `CUMULUS_INTERNAL_URL`, `CUMULUS_BRANCH`,
      `CUMULUS_ISSUE_IDENTIFIER`.
    - argv: `bash -lc <runner.command>`.
    - Only the agent writes to stdout. A setup or hook failure exits with code 70, and the
      orchestrator reports it with the pod's log tail.
  - A pod that terminates before attach, or reports `ImagePullBackOff`/`ErrImagePull`, fails the
    attempt. So does a pod not running within 10 minutes. In each case the Job is deleted.
  - Timing, modifying §8.5, §10.6 and §16.5:
    - Stall detection (`runner.stall_timeout_ms`) starts at attach. Scheduling and image pull are
      bounded only by the 10-minute pod-start timeout.
    - The first handshake request may take `read_timeout_ms + 2 × hooks.timeout_ms`, because
      `after_create` and `before_run` run in the pod before the agent starts.
    - After a normal end the worker gets `hooks.timeout_ms + 30 s` to exit (`after_run`) before it is
      killed. Job pods get the same termination grace.
    - A killed worker that still has not exited after 2 × 60 s is abandoned and logged as an error,
      which releases its slot and claim.
  - A failing worker's exit code and pod log tail are appended to the attempt's error.
  - Secrets (§15.3):
    - The run token goes in a per-run Secret `cumulus-run-<run_id>`. It is created before the Job,
      then owned by it, so it is garbage-collected with the Job. The container reads it through
      `valueFrom.secretKeyRef`.
    - MCP headers carry a `${CUMULUS_RUN_TOKEN}` placeholder. The ACP runner expands it over the
      protocol, and Claude Code expands it from its environment. The token never appears in a pod
      spec or in argv.
    - The orchestrator's Role allows `create/patch/delete/deletecollection` on secrets but not
      `get`/`list`, so it cannot read other secrets in the namespace.
  - Kubernetes API calls are bounded (30 s each), and the agent container is selected by name.
- **Reason:** Agents need an isolated, disposable environment with their own identity. A long-lived
  in-pod worker that dials back is deferred (follow-up issue).
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** Executor contract suite. §17.5 "launch uses workspace cwd" is proven by the
  pod spec's `workingDir` and the entrypoint's workspace check.

## C-4: Graceful drain and orphan cleanup

- **Upstream:** §14, §16.1 (extends)
- **Decision:**
  - On SIGTERM or SIGQUIT the orchestrator stops dispatching and waits up to
    `shutdown.drain_timeout_ms` for running workers to finish. Default `300000`. It then stops the
    remaining workers, marks their runs `interrupted`, and exits 0.
  - On startup, before the first tick:
    1. Mark stale `running` runs `interrupted`.
    2. Delete worker Jobs and pods left by a previous instance, found by label
       `app.kubernetes.io/managed-by=cumulus`.
    3. Run terminal cleanup.
  - The Deployment runs with `replicas: 1` and `strategy: Recreate`.
    `terminationGracePeriodSeconds` covers the drain window.
- **Reason:** With stdio attach, streams are lost when the orchestrator exits. Two instances must
  never overlap.
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** Added tests: drain stops dispatch, drain timeout kills workers, startup
  deletes orphans before the first dispatch.

## C-5: Postgres audit trail and persisted retry queue

- **Upstream:** §14.3, §18.2 TODO (extends)
- **Decision:**
  - Postgres stores `runs`, `run_transitions`, `retry_queue` and `settings`. Each run records its
    worker image digest.
  - The `claimed` transition is written before the Job is created.
  - `retry_queue` is loaded at startup. Each entry is re-validated against the tracker before it is
    re-armed.
  - Postgres is an audit record, not the scheduler's source of truth. Writes fail open, so
    scheduling continues while Postgres is down.
  - Hosting: Azure Database for PostgreSQL Flexible Server `adlib-cloudops-prod-psql`, database
    `cumulus`, Entra auth through workload identity. ORM: Drizzle.
- **Reason:** Run history and backoff that survive restarts.
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** Added tests: write order, fail-open behavior, retry queue restore.

## C-6: UI-editable settings override WORKFLOW.md

- **Upstream:** §6, §5.3.5 (modifies)
- **Decision:**
  - Precedence is UI override (Postgres), then `WORKFLOW.md`, then the built-in default.
  - Each override records who set it and when. If Postgres is unavailable, the last known values
    are kept.
  - The first editable setting is `agent.max_concurrent_agents` (shown as "max simultaneous runs").
    Its built-in default changes from upstream `10` to **`5`**.
- **Reason:** Operators tune cluster resource use without a commit.
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** §17.1 "config defaults apply" expects 5 for this key. Added precedence
  tests.

## C-7: Fresh workspace per run, inside the worker pod

- **Upstream:** §9.1–§9.4 (modifies)
- **Decision:**
  - No persistent volumes. Each run starts with an empty `<workspace.root>/<workspace_key>` inside
    the worker container. Work persists only through branches (see C-10).
  - `created_now` is always true, so `after_create` runs on every attempt. The worker entrypoint
    runs `after_create`, then `before_run`, then the agent, then `after_run`. Hook scripts are
    passed in by the orchestrator, and hook failure semantics follow §9.4.
  - `before_remove` is not run, because no workspace outlives its pod.
- **Reason:** Agents run in disposable pods.
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** §17.2 reuse rows do not apply. Key derivation and sanitization rows still
  apply.

## C-8: HTTP server: SSE events, Entra sign-in, Cumulus endpoints

- **Upstream:** §13.7 (extends)
- **Decision:**
  - The upstream endpoints are kept.
  - Added endpoints:
    - `GET /api/v1/events` (Server-Sent Events)
    - `GET /api/v1/runs`, `GET /api/v1/queue`, `GET /api/v1/workers`
    - `GET|PUT|DELETE /api/v1/settings[/:key]`
    - `GET /healthz`, `GET /readyz`
  - Every route except the health probes requires an Entra ID session (OIDC auth code + PKCE).
    Access is limited to one group, enforced by "assignment required" on the enterprise app.
  - `/` serves the Vue SPA. `/api/v1/<issue_identifier>` is resolved after the fixed routes.
  - `server.host` defaults to `127.0.0.1`. The chart sets `0.0.0.0`.
  - Agent-facing endpoints are served on a separate internal listener: `--internal-port`, default
    `8081`. That port is never routed by the ingress, and the NetworkPolicy admits only worker pods.
    It serves `POST /mcp/runs/<run_id>` (C-11) and `GET /internal/runs/<run_id>/git-token` (C-10).
- **Reason:** Live UI, authenticated operator access, run history.
- **Decided:** 2026-10-04, Tim (SSE chosen over WebSocket because traffic is one-way)
- **Conformance impact:** §17.6 plus route tests with auth on and off.

## C-9: Branch cleanup replaces workspace cleanup

- **Upstream:** §8.4, §8.5, §8.6 (modifies "clean workspace")
- **Decision:**
  - Where upstream cleans a terminal issue's workspace, Cumulus deletes branch `cumulus/<key>` in
    every repository of the GitHub org that has it.
  - A daily sweeper deletes any `cumulus/*` branch whose issue is terminal or no longer visible.
  - Merged branches are already removed by the repo's auto-delete setting.
- **Reason:** Branches are the only persistent workspace state (C-7).
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** §17.4 "terminal state ... cleans workspace" becomes "deletes branches".

## C-10: Agent chooses the repositories

- **Upstream:** §9.3 (implementation-defined population)
- **Decision:**
  - The orchestrator clones nothing. The agent decides which repositories in the `Adlibsoftware`
    GitHub org the work needs, by querying the org, and may span several. In each repository it
    works on the fixed branch `cumulus/<issue-key>` and opens one PR per repository.
  - The agent checks for existing `cumulus/<issue-key>` branches first and continues from them.
  - PRs reference `AB#<id>` so Azure DevOps links them. A human reviews and merges.
  - Git and `gh` auth comes from the `cumulus` GitHub App.
  - `WORKFLOW.md` gives hints, e.g. "Kubernetes config is stored in the aks-gitops repo and
    terraform is stored in the tf-org repo."
  - Prompt templates get one extra variable, `cumulus`, which extends §5.4. It holds `branch`
    (`cumulus/<workspace_key>`), `workspace_key` and `run_id`. Strict rendering still rejects
    unknown variables and filters.
  - Agents fetch GitHub credentials per use. The worker's git credential helper and `gh` wrapper call
    `GET /internal/runs/<run_id>/git-token` with the run token. The orchestrator returns the App
    installation token, cached until 5 minutes before expiry.
- **Reason:** Work items do not name a repository. Some work spans repositories.
- **Decided:** 2026-10-04, Tim
- **Conformance impact:** None on core rows.

## C-11: Provider-native tools over a host-side MCP endpoint

- **Upstream:** §10.5, §11.5 (implements the optional extension)
- **Decision:**
  - The orchestrator serves an MCP endpoint per run at `/mcp/runs/<run_id>`, authenticated with a
    per-run bearer secret. It is advertised to the agent session as an MCP server:
    `session/new.mcpServers` for ACP, `--mcp-config` for Claude Code.
  - The Azure DevOps adapter exposes two tools:
    - `azure_devops_move_card(column)`: allowed columns come from `tracker.provider.agent_columns`,
      default `[Dev, Test, Review]`.
    - `azure_devops_add_comment(markdown)`
  - The endpoint is a minimal MCP Streamable HTTP server: JSON responses only, with
    `initialize`, `ping`, `tools/list` and `tools/call`. `GET` returns 405.
  - The tools execute host-side with the orchestrator's credential. The agent never sees ADO
    credentials.
  - Moving the card to Review is the agent's hand-off. Review is not an active state, so dispatch
    stops there.
- **Reason:** Without a hand-off write, an issue stays in an active column and is re-dispatched
  indefinitely.
- **Decided:** 2026-10-04, Tim (Review must not cause repeated dispatch). The MCP transport follows
  §10.5 ("advertise using the targeted protocol").
- **Conformance impact:** §17.5 provider-native tool rows.

## Pending decisions

None.

## Deferred past the MVP

- **Agents reacting to PR review comments while an item is in Review.** Review is not an active
  state (C-11), so reviewer feedback is not picked up automatically. A human moves the card back to
  Dev to get another agent pass. Revisit after the MVP (Tim, 2026-10-05).
