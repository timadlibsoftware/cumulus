# Cumulus

Adlib's implementation of the [OpenAI Symphony spec](docs/spec/symphony-SPEC.md). Cumulus polls the
Azure DevOps DevOps backlog for work items tagged `cumulus` and runs coding agents (OpenCode, Claude Code)
on them in Kubernetes Jobs. Agents open GitHub PRs; humans review and merge. It pairs with Nimbus.

- Extensions and modifications to the upstream spec: [docs/spec/CUMULUS-SPEC.md](docs/spec/CUMULUS-SPEC.md)
- Azure DevOps adapter profile: [docs/adapters/azure-devops.md](docs/adapters/azure-devops.md)
- Contributor and agent instructions: [AGENTS.md](AGENTS.md)
- Deployment and one-time prerequisites: [docs/deploy.md](docs/deploy.md)
