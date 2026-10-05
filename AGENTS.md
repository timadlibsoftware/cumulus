# Cumulus: Agent Instructions

Cumulus is Adlib's implementation of the OpenAI Symphony spec. It polls Azure DevOps for opted-in work
items and runs coding agents (OpenCode, Claude Code) against them in Kubernetes Jobs. It pairs with
Nimbus, the CloudOps agent.

## Keep this file current

This file is part of the codebase. Any change that alters layout, commands, conventions, interfaces
or workflow must update AGENTS.md in the same commit. If you find it wrong or stale, fix it before
you continue. A change that alters structure without updating AGENTS.md is incomplete.

## Spec governance (mandatory)

- Check every design or implementation decision against **both** spec documents:
  - `docs/spec/symphony-SPEC.md`: the upstream spec, pinned to a specific commit.
  - `docs/spec/CUMULUS-SPEC.md`: our extensions and modifications.
- Upstream behavior is the default unless CUMULUS-SPEC.md explicitly overrides it.
- If the two documents disagree, or neither covers the decision, **stop and ask the user**. Do not
  choose on your own.
- Once the user decides, record it in CUMULUS-SPEC.md in the same change, using the entry format
  given there.
- Edit `symphony-SPEC.md` only during a deliberate, reviewed upstream sync. That sync also updates
  the pinned commit in the file header.

## TDD (mandatory, every change)

- Write a failing test first and run it. Watch it fail for the right reason. Then write the minimum
  code to pass, then refactor. No production code without a failing test that demanded it.
- Bug fixes start with a test that reproduces the bug.
- Conformance tests name the spec section they prove in the test title, e.g.
  `it('§8.2 sorts by priority, then created_at, then identifier')`. Cumulus-specific behavior names
  the CUMULUS-SPEC entry, e.g. `it('C-6 UI override beats WORKFLOW.md')`.
- Shared contract suites (`test/contracts/`) must pass for every tracker, runner and executor
  implementation.

## Plan documents are not committed

Do not check plan documents (implementation plans, task breakdowns, scratch designs) into git. Keep
them in the session scratchpad or a temp directory. Durable decisions belong in CUMULUS-SPEC.md,
`docs/adapters/`, or this file.

## Scope control

When you find work that is deferred past the current task or the MVP, file it as a GitHub issue in
the Cumulus repo. Do not build it and do not expand the current task's scope.

## Layout

```
packages/shared/         Type-only package: Issue, AgentEvent, API DTOs, SSE events. No runtime code.
packages/orchestrator/   Fastify service (Node 24 LTS)
  src/config/            WORKFLOW.md loader, typed config, $VAR/~ resolution, settings precedence, reload
  src/tracker/           Tracker interface, in-memory tracker, azure-devops adapter
  src/runner/            AgentRunner interface + protocol adapters (opencode ACP, claude stream-json)
  src/executor/          WorkerExecutor interface: local process (dev/test) and Kubernetes Job + attach
  src/orchestrator/      State machine, tick, reconcile, retry, drain, startup cleanup
  src/db/                Drizzle schema + fail-open audit store (Postgres)
  src/http/              /api/v1/*, SSE, Entra OIDC, static UI
  test/                  Vitest tests; test/contracts/ holds shared contract suites
packages/ui/             Vue 3 + Vite + PrimeVue (Sakai) SPA, built into the orchestrator's public/
worker/                  Agent worker image (Ubuntu 24.04), context: worker/
  Dockerfile             Pinned tools (ARGs, Renovate-annotated), tini PID 1, user agent (10001)
  entrypoint.sh          Workspace + hooks + agent + after_run; stdout belongs to the agent only
  bin/                   cumulus-github-token, cumulus-git-credential, gh wrapper (run-scoped token)
  convert/               @cumulus/worker-convert: CloudOps-Skills marketplace -> OpenCode config
  mcp-pins.json          npx MCP packages installed globally at fixed versions
  test/                  bats tests + smoke.sh (runs against a built image)
chart/                   Helm chart for the `agents` namespace on cloudops-prod
scripts/                 CI helpers (set-chart-value.mjs) + bats tests
docs/spec/               Upstream spec copy + CUMULUS-SPEC.md
docs/adapters/           Tracker adapter profiles (required by upstream §11.2)
WORKFLOW.md              Default workflow: DevOps backlog, OpenCode runner
```

## Commands

```bash
pnpm install
pnpm test                      # all packages
pnpm typecheck
pnpm lint                      # eslint + prettier --check
pnpm --filter @cumulus/ui build
pnpm test:scripts              # bats: worker entrypoint, token helpers, scripts/ (needs jq)
helm lint chart && helm template chart | kubeconform -strict -summary -ignore-missing-schemas
```

Run all of them before every commit. For worker image changes also build it and run the smoke test
(CloudOps-Skills is private; pass a checkout at `CLOUDOPS_SKILLS_REF` as a named context):

```bash
docker buildx build --load --build-context cloudops-skills=<checkout> -t cumulus-worker:local worker
worker/test/smoke.sh cumulus-worker:local
```

Postgres tests use Testcontainers and need Docker. They skip, and report themselves as skipped, when
Docker is unavailable.

## UI (`packages/ui`)

Vue 3 + Vite + PrimeVue 4 (Aura preset) + Tailwind 4 (`tailwindcss-primeui`), shell taken from the
free Sakai template (layout SCSS in `src/assets/layout/`, trimmed). Tests: Vitest + @vue/test-utils
on jsdom.

```bash
pnpm --filter @cumulus/ui dev        # Vite dev server; proxies /api and /auth to 127.0.0.1:8080
pnpm --filter @cumulus/ui test       # vitest run
pnpm --filter @cumulus/ui typecheck  # vue-tsc --noEmit
pnpm --filter @cumulus/ui build      # writes packages/orchestrator/public (gitignored, emptied)
```

```
src/main.ts              PrimeVue (darkModeSelector '.app-dark'), router, global styles
src/router.ts            `sections`: the single list behind routes and the sidebar menu
src/api.ts               Only place that calls fetch. 401 -> /auth/login?returnTo=<path>
src/format.ts            Date, number, duration formatting
src/composables/         useTheme (System/Light/Dark), useLiveState (SSE + polling fallback),
                         useResource (load on mount, error state)
src/components/          SettingField (C-6 field semantics), IssueLink
src/layout/              Sakai shell: AppLayout, AppTopbar, AppSidebar, AppMenu, useLayout
src/views/               Dashboard, Runs, Queue, Workers, Settings (one per sidebar section)
test/                    *.test.ts; helpers.ts mounts with PrimeVue (theme 'none') + memory router;
                         setup.ts provides a default matchMedia for jsdom
```

- **Theme:** `useTheme()` is the only code that touches the `app-dark` class on `<html>`. Modes are
  `system` (default, follows `prefers-color-scheme` live), `light`, `dark`; stored in localStorage
  key `cumulus.theme`. All storage access is wrapped in try/catch.
- **API types** come from `@cumulus/shared` via `import type`. Components never call `fetch`
  directly; add a method to `api` with a test instead.
- **Live data:** `useLiveState()` owns the single EventSource on `/api/v1/events` and stops with
  its component. On SSE error it closes the stream and polls `/api/v1/state` every 10s.
- **Settings (C-6):** rendered generically from `GET /api/v1/settings`; never hard-code a key. A
  field without an override is empty, with the inherited value (`workflow_value ?? default_value`)
  as placeholder. An override shows its value, a `modified` Tag, a Reset link (`DELETE`) and who set
  it. Saving an empty field does nothing. After any change the list is reloaded from the API.
- **Dashboard:** "failing" means `GET /api/v1/runs?status=failed&limit=10`, reloaded when a run
  leaves the running set.
- `.vue` files are formatted by Prettier but not linted by ESLint; `vue-tsc` type-checks them.

## Conventions

- TypeScript, ESM, `strict`. Import type-only symbols with `import type`.
- Inject time (`Clock`), I/O and randomness so orchestrator tests are deterministic. No real timers
  or network in unit tests.
- Logs: pino JSON to stdout. Every log line in a run context carries `run_id`, `issue_id` and
  `issue_identifier`; session logs also carry `session_id`.
- Secrets: never logged, never passed to agent processes unless explicitly intended for them.
- Commits: Conventional Commits, single line, 8 words or fewer.
- Workflows: kebab-case, verb-first file names (infra-common ADR-0002).
- Images: deploy only immutable `GITHUB_RUN_ID` tags committed to `chart/values.yaml` (ADR-0003).
  ArgoCD auto-syncs the chart from `main`; CI never runs `helm upgrade`.

## Deploy

- Worker tool versions are `ARG`s in `worker/Dockerfile`; `worker/test/smoke.sh` reads them back,
  so bump only the ARG. CloudOps-Skills is pinned by `CLOUDOPS_SKILLS_REF`; the build prints
  `/opt/cumulus/UNMAPPED.md` (features OpenCode cannot use; file issues).
- The worker entrypoint contract (env names, exit 70 for setup and hook failures) is documented at
  the top of `worker/entrypoint.sh`; the executor that builds worker pods must match it.
