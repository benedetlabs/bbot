# BenedetLabsBots (bsuit.app)

> Monorepo Deno 2.x + TypeScript for Slack micro-utilities and AI agent control plane distributed via Cloudflare Tunnel and Kubernetes (k3s on Civo).

---

## 🛡️ Control Plane Architecture

The suite operates as an integrated governance and operations control plane inside Slack:

1. **Gatekeep (`/gatekeep`, `https://gatekeep.bsuit.app`) — Anchor Product #1**:
   - **Human-in-the-Loop (HITL) Approval Layer** for AI agents (Cursor, Claude Code, LangGraph) and CI/CD pipelines before irreversible real-world actions.
   - **Cryptographic Parameter Binding (RFC 8785)**: Generates SHA-256 canonical hash of action and parameters. Approvals are cryptographically tied to exact parameters.
   - **Single-Use Execution Tokens**: Once approved, agents receive an opaque single-use token verified at `/v1/requests/:id/consume`.
   - **Closed-Loop Execution Receipts**: Once executed, the card updates in-place (`chat.update`) with status and duration.
   - **Multiple Surfaces**: Remote & stdio MCP Server (`@suite/gatekeep-mcp`), TypeScript SDK (`@suite/gatekeep-sdk`), REST API, and GitHub Action (`actions/gatekeep`).
   - **Integrated with Suite**:
     - *Todo Follow-Through*: Rejections and execution failures automatically spawn follow-up tasks (`todosRepo.create`).
     - *Queue Resource Locking*: Gated deployments respect FIFO staging locks (`queuesRepo.joinQueue`).
     - *Just-in-Time Secrets*: Split-key credential release unlocked upon human approval.

2. **Secret App (`/secret`, `https://secret.bsuit.app`) — Anchor Product #2**:
   - Generates **one-time secret links** opened exclusively in the recipient's browser (`/s/:id#<clientKeyHex>`).
   - **Burn-after-read** and **split-key encryption** (half stored encrypted in server KV, half in URL hash fragment).
   - Zero destructive message deletion in Slack (100% compliant with Slack Marketplace policies).

3. **Queue App (`/queue`, `https://queue.bsuit.app`)**:
   - FIFO resource locking (mutex and semaphore slots) for staging environments and deploy coordination.
   - Real-time in-place card synchronization and DM notifications.

4. **Todo App (`/todo`)**:
   - GTD personal and delegated tasks with accountability reminders.

---

## 📦 Packages & Workspaces

| Workspace | Description |
|---|---|
| [`apps/gatekeep-app`](./apps/gatekeep-app) | Production Hono server for Gatekeep REST API, OAuth v2, MCP endpoint, and Slack Block Kit interactions. |
| [`apps/secret-app`](./apps/secret-app) | Production Hono server for Secret one-time link generation and browser reveal. |
| [`apps/queue-app`](./apps/queue-app) | Queue management server and Slack slash command handler. |
| [`apps/todo-app`](./apps/todo-app) | Todo GTD task server. |
| [`apps/outbox-worker`](./apps/outbox-worker) | Transactional outbox worker ensuring guaranteed delivery and sub-300ms Slack SLA. |
| [`packages/gatekeep-core`](./packages/gatekeep-core) | JCS canonical JSON serialization (RFC 8785), SHA-256 hashing, state machine, and policy evaluation. |
| [`packages/gatekeep-mcp`](./packages/gatekeep-mcp) | Model Context Protocol (MCP) server for Cursor, Claude Code, and AI agents. |
| [`packages/gatekeep-sdk`](./packages/gatekeep-sdk) | Official TypeScript SDK with `guard()` wrapper. |
| [`packages/crypto`](./packages/crypto) | AES-256-GCM encryption, split-key secrets, and fail-fast master key verification. |
| [`packages/db`](./packages/db) | PostgreSQL 18 repositories, migrations, PgCache read fallback, and KV store. |
| [`packages/slack-kit`](./packages/slack-kit) | Slack Block Kit UI builders, HMAC signature verification, and API client. |
| [`packages/outbox`](./packages/outbox) | Transactional outbox pattern scheduling and exponential backoff. |
| [`actions/gatekeep`](./actions/gatekeep) | GitHub Action for pausing workflows until Slack approval is granted. |

---

## 🚀 Development & Testing

### Prerequisites
- [Deno 2.x](https://deno.land/)
- PostgreSQL 18 (or Docker Compose)

### Running Tests
Run the entire test suite across all packages:
```bash
deno test -A
```

### Local Development
Copy environment configuration:
```bash
cp .env.example .env
```
Ensure required keys are configured:
- `MASTER_ENCRYPTION_KEY_HEX`: 64-character hex string (32 bytes AES-256 key).
- `SLACK_SIGNING_SECRET`: Slack app signing secret.

---

## 🚢 Deployment

Deployments to Civo Kubernetes (`k3s`) are orchestrated exclusively via Terraform:
```bash
terraform -chdir=infra/02-releases apply
```
Image tags are deterministic 12-character SHA-256 hashes calculated from source files and pushed to GitHub Container Registry (`ghcr.io/benedetlabs/*`).

See [`CIVO_DEPLOY.md`](./CIVO_DEPLOY.md) for full operational instructions.
