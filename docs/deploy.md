# Deploying Cumulus

Cumulus runs in the `agents` namespace on `cloudops-prod-aks`. ArgoCD syncs `chart/` from `main`
(release `cumulus`, auto-sync with prune and self-heal). CI builds two images and commits their
immutable `GITHUB_RUN_ID` tags to `chart/values.yaml` (infra-common ADR-0003, CD exception):

| Image                                            | Workflow                            | Values key         |
| ------------------------------------------------ | ----------------------------------- | ------------------ |
| `adlibcloudops.azurecr.io/agents/cumulus`        | `build-and-deploy-orchestrator.yml` | `image.tag`        |
| `adlibcloudops.azurecr.io/agents/cumulus-worker` | `build-worker-image.yml`            | `worker.image.tag` |

Chart-only changes need no image build. CI never runs `helm upgrade`.

## One-time prerequisites

Do these in order. Terraform goes in `tf-org` (applied manually, pushed straight to `main`). The
snippets below follow that repo's conventions; adjust names if a reviewer prefers otherwise.

### 1. Managed identities and workload identity federation (tf-org)

Two user-assigned identities, one per Kubernetes service account. File:
`workloads/azure/kubernetes/cloudops-prod/cumulus-workload-identity.tf`.

```hcl
locals {
  cumulus_service_accounts = {
    orchestrator = "system:serviceaccount:agents:cumulus"
    agent        = "system:serviceaccount:agents:cumulus-agent"
  }
}

resource "azurerm_user_assigned_identity" "cumulus" {
  for_each = local.cumulus_service_accounts

  name                = "cumulus-${each.key}-uami"
  location            = data.azurerm_resource_group.infrastructure.location
  resource_group_name = data.azurerm_resource_group.infrastructure.name
  tags                = var.default_tags

  lifecycle {
    ignore_changes = [
      tags["status"],
      tags["NextReviewDate"],
      tags["Owner"],
    ]
  }
}

resource "azurerm_federated_identity_credential" "cumulus" {
  for_each = local.cumulus_service_accounts

  name                = "cumulus-${each.key}-agents-sa"
  resource_group_name = data.azurerm_resource_group.infrastructure.name
  parent_id           = azurerm_user_assigned_identity.cumulus[each.key].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = data.azurerm_kubernetes_cluster.cloudops_prod.oidc_issuer_url
  subject             = each.value
}

output "cumulus_orchestrator_client_id" {
  description = "Set as workloadIdentity.orchestratorClientId in cumulus chart/values.yaml."
  value       = azurerm_user_assigned_identity.cumulus["orchestrator"].client_id
}

output "cumulus_agent_client_id" {
  description = "Set as workloadIdentity.agentClientId in cumulus chart/values.yaml."
  value       = azurerm_user_assigned_identity.cumulus["agent"].client_id
}
```

Then set `workloadIdentity.orchestratorClientId` and `workloadIdentity.agentClientId` in
`chart/values.yaml`.

Azure DevOps: the orchestrator identity reads and writes work items in `AdlibCTP` (C-1, C-11). Add
`cumulus-orchestrator-uami` to the `adlibsoftware` organization as a user (Basic access) with
contributor rights on the DevOps team's area path. Note that `ops-ai-agents` moved OpenCode from a
user-assigned identity to an app registration (`opencode-ado-sp`) because the identity could not
read work items; verify ADO access for the identity early and fall back to the same pattern if it
fails.

The agent identity gets only the Azure roles the agents need (start with nothing, or `Reader`). It
has no Kubernetes RBAC.

### 2. Postgres database and Entra role (tf-org + one SQL step)

Database on `adlib-cloudops-prod-psql`, in `workloads/azure/databases/cloudops/postgresql.tf`:

```hcl
resource "azurerm_postgresql_flexible_server_database" "cumulus" {
  name      = "cumulus"
  server_id = module.postgresql.id
  charset   = "utf8"
  collation = "en_US.utf8"
}
```

tf-org has no Postgres role provider, so create the Entra role by hand as a member of the server's
Entra admin group (`azure-cloudops-administrators`):

```sql
-- database: postgres
SELECT * FROM pgaadauth_create_principal('cumulus-orchestrator-uami', false, false);
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE cumulus TO "cumulus-orchestrator-uami";
-- database: cumulus
GRANT USAGE, CREATE ON SCHEMA public TO "cumulus-orchestrator-uami";
```

The role name must match `db.user` in `chart/values.yaml`.

### 3. GitHub Actions to ACR (tf-org, ADR-0004)

In `workloads/azure/kubernetes/cloudops-prod/github-auth.tf`:

```hcl
# GitHub OIDC for cumulus (orchestrator and worker image builds)
resource "azuread_application" "github_cumulus" {
  display_name = "cloudops-github-cumulus-sp"
  owners       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_service_principal" "github_cumulus" {
  client_id = azuread_application.github_cumulus.client_id
  owners    = [data.azurerm_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "github_cumulus_main" {
  application_id = azuread_application.github_cumulus.id
  display_name   = "github-main-cumulus"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:Adlibsoftware/cumulus:ref:refs/heads/main"
}

resource "azurerm_role_assignment" "github_cumulus_acr_push" {
  scope                = module.cloudops_container_registry.acr_id
  role_definition_name = "AcrPush"
  principal_id         = azuread_service_principal.github_cumulus.object_id
  description          = "GitHub Actions OIDC access to push cumulus images to adlibcloudops ACR"
}
```

No pull-request credential: PR runs only test, they never push images.

Repository settings for `Adlibsoftware/cumulus`:

- Variables: `AZURE_CLIENT_ID` (the app above), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
  `ACR_LOGIN_SERVER=adlibcloudops.azurecr.io`, `CUMULUS_GITHUB_APP_ID`.
- Secret: `CUMULUS_GITHUB_APP_PRIVATE_KEY`. The worker build uses the GitHub App to check out the
  private `cloudops-skills` repo.
- Access to the `self-hosted-linux` runner group.
- `github-actions[bot]` must be able to push to `main` (the image workflows commit tags there).

### 4. Entra ID app registration for operator sign-in (C-8)

- App `cumulus`, web redirect URI `https://cumulus.adlibsys.com/auth/callback`, a client secret.
- Enterprise application: **Assignment required = Yes**, assign the one operator group.
- Set `oidc.clientId` in `chart/values.yaml`. The issuer is already set for the Adlib tenant.

```hcl
resource "azuread_application" "cumulus" {
  display_name     = "cumulus"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azurerm_client_config.current.object_id]

  web {
    redirect_uris = ["https://cumulus.adlibsys.com/auth/callback"]
  }
}

resource "azuread_service_principal" "cumulus" {
  client_id                    = azuread_application.cumulus.client_id
  app_role_assignment_required = true
  owners                       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_app_role_assignment" "cumulus_operators" {
  app_role_id         = "00000000-0000-0000-0000-000000000000" # default access
  principal_object_id = data.azuread_group.cumulus_operators.object_id
  resource_object_id  = azuread_service_principal.cumulus.object_id
}
```

### 5. GitHub App `cumulus` (C-10)

- Repository permissions: Contents read/write, Pull requests read/write, Metadata read. Add
  Workflows read/write only if agents must edit `.github/workflows`.
- Install it on the `Adlibsoftware` organization, all repositories.
- Store the App ID and private key in Key Vault (next step) and in the repo settings (step 3).

### 6. Key Vault secrets (`adlib-aks-kv`)

External Secrets reads these through `ClusterSecretStore/adlib-aks-kv`:

| Key Vault secret          | Kubernetes Secret / key                                         | Value                                                         |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| `CumulusOidcClientSecret` | `cumulus` / `CUMULUS_OIDC_CLIENT_SECRET`                        | Entra app client secret (step 4)                              |
| `CumulusSessionKey`       | `cumulus` / `CUMULUS_SESSION_SECRET`                            | `openssl rand -base64 48`                                     |
| `CumulusGithubAppId`      | `cumulus` / `CUMULUS_GITHUB_APP_ID`                             | GitHub App ID (step 5)                                        |
| `CumulusGithubAppKey`     | `cumulus` / `CUMULUS_GITHUB_APP_PRIVATE_KEY`                    | GitHub App private key, PEM                                   |
| `CumulusLitellmKey`       | `cumulus-agent-env` / `LITELLM_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | LiteLLM virtual key for agent runs (OpenCode and Claude Code) |

Agent env entries come from `agentEnv` in `chart/values.yaml`; add more there (for example tokens
the CloudOps-Skills MCP servers read, listed in the worker image's `/opt/cumulus/UNMAPPED.md`).

### 7. ArgoCD application (aks-gitops)

Copy `deploy/argocd/cumulus.yaml` to `aks-gitops/argocd/cloudops-prod/cumulus.yaml` and push to
`aks-gitops` `main`. It deploys `chart/` from this repo's `main` into `agents` as release
`cumulus`. ArgoCD reads the repo over SSH (`git@github.com:Adlibsoftware/cumulus.git`), so confirm
its repository credentials cover the new repo.

## First deploy

1. Apply steps 1 to 6 and fill the client IDs into `chart/values.yaml`.
2. Merge to `main`. The image workflows replace the placeholder tags (`'0'`) with real run IDs.
3. Add the ArgoCD application (step 7) once both tags are real.
4. Check `kubectl get pods -n agents -l app.kubernetes.io/name=cumulus --context cloudops-prod-aks`
   and open https://cumulus.adlibsys.com.
