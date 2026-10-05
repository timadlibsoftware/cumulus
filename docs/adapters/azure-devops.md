# Azure DevOps Adapter Profile

This is the adapter profile required by upstream §11.2. It covers CUMULUS-SPEC entries C-1 and C-11.
Code: `packages/orchestrator/src/tracker/azure-devops.ts`.

## Kind

`tracker.kind: azure_devops`

## `tracker.provider` keys

| Key                   | Required | Default                   | Notes                                                                       |
| --------------------- | -------- | ------------------------- | --------------------------------------------------------------------------- |
| `organization`        | yes      |                           | e.g. `adlibsoftware`                                                        |
| `project`             | yes      |                           | e.g. `AdlibCTP`                                                             |
| `team`                | yes      |                           | Board owner, e.g. `DevOps`                                                  |
| `board`               | no       | `Stories`                 | Board used by the move-card tool                                            |
| `area_path`           | yes      |                           | Scope; matched with `UNDER` (includes children)                             |
| `iteration_path`      | no       | none                      | Scope; matched with `UNDER`                                                 |
| `work_item_types`     | no       | `[User Story, Bug]`       | Scope                                                                       |
| `agent_columns`       | no       | `[Dev, Test, Review]`     | Columns the agent may move a card to                                        |
| `blocker_done_states` | no       | `[Done, Closed, Removed]` | Predecessor states (board column, else `System.State`) that no longer block |
| `max_results`         | no       | `20000`                   | WIQL `$top`; a result at the cap fails with `tracker_pagination`            |
| `base_url`            | no       | `https://dev.azure.com`   | Testing only                                                                |
| `pat`                 | no       | none                      | `$VAR` only. If set but resolving to empty: `missing_tracker_secret`        |

A missing or empty required key fails with `invalid_tracker_config`.

**Authentication:** when `pat` is set, the adapter sends Basic auth with that PAT. Otherwise it sends
an Entra bearer token for scope `499b84ac-1321-427f-aa17-267ca6975798/.default`, obtained through
`DefaultAzureCredential` (workload identity in AKS, `az login` locally). The orchestrator's managed
identity must be an Azure DevOps user with read access to the project and write access to work items
(for the tools).

**Secret environment names** (removed from child environments): the `pat` variable name, `ADO_PAT`,
`AZURE_DEVOPS_EXT_PAT` and `SYSTEM_ACCESSTOKEN`. Agent pods never receive tracker credentials.

## Scope selection and pagination

- **Candidates:** WIQL `POST {org}/{project}/_apis/wit/wiql?$top=max_results`. The query filters on
  `TeamProject`, `AreaPath UNDER`, optional `IterationPath UNDER`, `WorkItemType IN`, and
  `System.BoardColumn IN (<requested states>)`, ordered by `System.Id`.
- **Details:** `POST {org}/{project}/_apis/wit/workitemsbatch` in chunks of 200 IDs, with
  `$expand: Relations` and `errorPolicy: Omit`. WIQL order is preserved across chunks.
- **ID refresh:** the same batch call. Items that no longer exist, or have left the scope (area,
  iteration or type), are omitted.
- Request timeout is 30 s. There are no automatic retries; the orchestrator retries on the next tick.

## Normalization

| Issue field                 | Source                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `System.Id` as a string                                                                                                                                                                                    |
| `identifier`                | `AB#<id>` (the same syntax GitHub↔ADO linking uses)                                                                                                                                                        |
| `title`                     | `System.Title` (required)                                                                                                                                                                                  |
| `description`               | `System.Description`, HTML→text, followed by `Acceptance criteria:` and `Microsoft.VSTS.Common.AcceptanceCriteria` when present                                                                            |
| `priority`                  | `Microsoft.VSTS.Common.Priority` if it is an integer, else null                                                                                                                                            |
| `state`                     | **`System.BoardColumn`**, falling back to `System.State` for items not on a board (e.g. Removed). Provider spelling is preserved.                                                                          |
| `branch_name`               | null. Cumulus derives the branch itself (C-10).                                                                                                                                                            |
| `url`                       | `{base}/{org}/{project}/_workitems/edit/{id}`                                                                                                                                                              |
| `assignee_id`               | `System.AssignedTo.uniqueName`, else its `id`                                                                                                                                                              |
| `labels`                    | `System.Tags` split on `;`, trimmed, lowercased, blanks dropped, de-duplicated                                                                                                                             |
| `blocked_by`                | `System.LinkTypes.Dependency-Reverse` (Predecessor) relations: `{id, identifier: AB#id, state}`, where `state` is the board column, else `System.State`. `state` is null if the predecessor can't be read. |
| `dispatchable`              | In scope **and** no predecessor whose state is known and not in `blocker_done_states`. A predecessor of unknown state does not block.                                                                      |
| `created_at` / `updated_at` | `System.CreatedDate` / `System.ChangedDate` as RFC 3339, null if unparsable                                                                                                                                |
| `native_ref`                | `{work_item_id, rev, work_item_type, area_path, project}` (no secrets)                                                                                                                                     |

**Malformed records:** a record is malformed when the title is empty or it has neither a board column
nor a state. State-list calls omit and log malformed records. ID refresh fails with
`tracker_response`.

## Provider-native tools (C-11)

The tools are served to the agent through the orchestrator's per-run MCP endpoint. They run host-side
with the adapter's credential.

| Tool                       | Input                                    | Mutates | Behavior                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `azure_devops_move_card`   | `{column}` restricted to `agent_columns` | yes     | Reads the board (`GET {org}/{project}/{team}/_apis/work/boards/{board}`) once for the column field reference name and the column→state mapping. Then it sends a JSON-patch to the work item setting `System.State` (mapped for the item's type) and the board's `Kanban.Column` field. |
| `azure_devops_add_comment` | `{markdown}` (1–100000 chars)            | yes     | `POST .../workItems/{id}/comments?format=markdown&api-version=7.1-preview.4`                                                                                                                                                                                                           |

- Scope: only the current run's work item. The ID comes from tool context, never from arguments.
- Results: `{ok: true, output: {...}}` on success.
- Errors: `{ok: false, output: {error: {code, message}}}`, where `code` is one of
  `invalid_arguments`, `unsupported_tool`, or an error category from the table below. Errors never
  throw into the session.
- No idempotency keys: repeated comments create duplicates.
- Azure DevOps rate limits apply to the orchestrator's identity.

## Error mapping

| Condition                                                              | Category                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Missing/invalid provider key                                           | `invalid_tracker_config`                                                 |
| `pat` `$VAR` resolves empty; no workload identity token                | `missing_tracker_secret`                                                 |
| Network failure / timeout                                              | `tracker_request`                                                        |
| Non-2xx other than 429                                                 | `tracker_status` (message includes status + first 300 chars of the body) |
| HTTP 429                                                               | `tracker_rate_limited` (`retryAfterMs` from `Retry-After`)               |
| Non-JSON body, missing `workItems`/`value`, malformed requested record | `tracker_response`                                                       |
| WIQL result at the `max_results` cap                                   | `tracker_pagination`                                                     |

All errors are `TrackerError` instances with `category` and `message`.

## Verification

- `test/tracker/azure-devops.test.ts` runs the shared contract and the rows above against a fake
  built from real response shapes.
- `test/live/azure-devops.live.test.ts` is a read-only check against the real organization. Run it
  with `CUMULUS_LIVE_ADO=1 pnpm --filter @cumulus/orchestrator test`. It is skipped otherwise.
- The `format=markdown` comment parameter and the move-card patch have not yet been exercised against
  the live service. Verify them in the first real-integration run (§17.8).
