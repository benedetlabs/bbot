/**
 * @module @apps/gatekeep-app/docs
 * Comprehensive Product, Agent Integration & API Documentation Portal for Gatekeep (bsuit.app/docs).
 */

import { layout } from "./pages.ts";

export function docsPage(): string {
  return layout(
    "Gatekeep Documentation & API Reference — bsuit.app",
    `
    <style>
      .docs-wrapper {
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr);
        gap: 2.5rem;
        padding: 2.25rem 0 4rem;
        align-items: start;
      }
      @media (max-width: 960px) {
        .docs-wrapper {
          grid-template-columns: 1fr;
        }
        .docs-sidebar {
          position: static !important;
          max-height: none !important;
        }
      }
      .docs-sidebar {
        position: sticky;
        top: 5rem;
        max-height: calc(100vh - 6.5rem);
        overflow-y: auto;
        background: rgba(15, 22, 36, 0.75);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 1.15rem;
        backdrop-filter: blur(12px);
      }
      .docs-search {
        width: 100%;
        background: #060911;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0.48rem 0.75rem;
        color: var(--ink);
        font-family: var(--font-sans);
        font-size: 0.82rem;
        margin-bottom: 1rem;
        outline: none;
      }
      .docs-search:focus {
        border-color: var(--emerald);
      }
      .docs-nav-group {
        margin-bottom: 1.15rem;
      }
      .docs-nav-title {
        font-family: var(--font-mono);
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--emerald);
        font-weight: 700;
        margin: 0 0 0.45rem;
      }
      .docs-nav-link {
        display: block;
        font-size: 0.84rem;
        color: var(--muted);
        padding: 0.28rem 0.5rem;
        border-radius: 6px;
        text-decoration: none;
        transition: all 0.14s ease;
      }
      .docs-nav-link:hover {
        color: var(--ink);
        background: rgba(148, 163, 184, 0.08);
        text-decoration: none;
      }
      .docs-main {
        min-width: 0;
      }
      .docs-section {
        padding-bottom: 2.75rem;
        margin-bottom: 2.75rem;
        border-bottom: 1px solid var(--line);
        scroll-margin-top: 5.5rem;
      }
      .docs-section:last-child {
        border-bottom: none;
      }
      .docs-section h1 {
        font-size: 2.25rem;
        letter-spacing: -0.03em;
        margin: 0 0 0.75rem;
      }
      .docs-section h2 {
        font-size: 1.5rem;
        letter-spacing: -0.02em;
        margin: 0 0 0.75rem;
        color: var(--ink);
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .docs-section h3 {
        font-size: 1.12rem;
        margin: 1.65rem 0 0.5rem;
        color: #e2e8f0;
      }
      .badge-method {
        font-family: var(--font-mono);
        font-size: 0.72rem;
        font-weight: 700;
        padding: 0.18rem 0.55rem;
        border-radius: 5px;
        text-transform: uppercase;
      }
      .badge-post {
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.35);
      }
      .badge-get {
        background: rgba(6, 182, 212, 0.18);
        color: #38bdf8;
        border: 1px solid rgba(6, 182, 212, 0.35);
      }
      .endpoint-box {
        background: rgba(15, 22, 36, 0.85);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 1.25rem;
        margin: 1.25rem 0;
      }
      .endpoint-header {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        font-family: var(--font-mono);
        font-size: 0.9rem;
        color: var(--ink);
        margin-bottom: 0.65rem;
        flex-wrap: wrap;
      }
      .docs-table {
        width: 100%;
        border-collapse: collapse;
        margin: 1rem 0 1.4rem;
        font-size: 0.86rem;
      }
      .docs-table th, .docs-table td {
        text-align: left;
        padding: 0.65rem 0.85rem;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      .docs-table th {
        color: var(--ink);
        font-family: var(--font-mono);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: rgba(6, 9, 17, 0.6);
      }
      .docs-table td {
        color: #cbd5e1;
      }
      .callout {
        background: rgba(16, 185, 129, 0.08);
        border-left: 3px solid var(--emerald);
        border-radius: 0 10px 10px 0;
        padding: 0.9rem 1.15rem;
        margin: 1.1rem 0;
        font-size: 0.9rem;
        color: #e2e8f0;
      }
      .callout.warn {
        background: rgba(245, 158, 11, 0.08);
        border-left-color: var(--amber);
      }
      .code-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #0b101d;
        border: 1px solid var(--line);
        border-bottom: none;
        border-radius: 10px 10px 0 0;
        padding: 0.45rem 0.9rem;
        font-family: var(--font-mono);
        font-size: 0.75rem;
        color: var(--muted);
        margin-top: 0.85rem;
      }
      .code-header + pre {
        margin-top: 0;
        border-top-left-radius: 0;
        border-top-right-radius: 0;
      }
      .copy-btn {
        background: rgba(148, 163, 184, 0.12);
        border: 1px solid var(--line);
        color: #cbd5e1;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        padding: 0.18rem 0.55rem;
        border-radius: 5px;
        cursor: pointer;
      }
      .copy-btn:hover {
        border-color: var(--emerald);
        color: #34d399;
      }
      .agent-badge-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
        gap: 0.75rem;
        margin: 1.25rem 0;
      }
      .agent-jump-card {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 0.85rem 1rem;
        text-decoration: none;
        transition: all 0.15s ease;
      }
      .agent-jump-card:hover {
        border-color: var(--emerald);
        transform: translateY(-2px);
        text-decoration: none;
      }
      .agent-jump-card strong {
        color: var(--ink);
        font-size: 0.9rem;
      }
      .agent-jump-card span {
        color: var(--muted);
        font-size: 0.76rem;
      }
    </style>

    <div class="docs-wrapper">
      <!-- STICKY SIDEBAR -->
      <aside class="docs-sidebar" aria-label="Documentation Navigation">
        <input
          type="search"
          id="docs-filter"
          class="docs-search"
          placeholder="Filter docs (e.g. codex, mcp, jcs)..."
          oninput="filterDocsNav(this.value)"
          aria-label="Filter documentation sections"
        />

        <div class="docs-nav-group">
          <div class="docs-nav-title">Getting Started</div>
          <a href="#overview" class="docs-nav-link">Overview &amp; Architecture</a>
          <a href="#slack-setup" class="docs-nav-link">Slack Install &amp; Commands</a>
          <a href="#state-machine" class="docs-nav-link">Request State Machine</a>
        </div>

        <div class="docs-nav-group">
          <div class="docs-nav-title">Agent Integrations</div>
          <a href="#claude-code" class="docs-nav-link">Claude Code &amp; Desktop</a>
          <a href="#openai-codex" class="docs-nav-link">OpenAI Codex &amp; GPT / API</a>
          <a href="#cursor-windsurf" class="docs-nav-link">Cursor &amp; Windsurf IDE</a>
          <a href="#hermes-agent" class="docs-nav-link">Hermes Agent (Nous)</a>
          <a href="#openclaw" class="docs-nav-link">OpenClaw Framework</a>
          <a href="#langgraph-python" class="docs-nav-link">Python / LangGraph / CrewAI</a>
        </div>

        <div class="docs-nav-group">
          <div class="docs-nav-title">Protocols &amp; APIs</div>
          <a href="#mcp-reference" class="docs-nav-link">Remote MCP Reference</a>
          <a href="#rest-api" class="docs-nav-link">REST API Reference (/v1)</a>
          <a href="#sdk-reference" class="docs-nav-link">TypeScript / Deno SDK</a>
        </div>

        <div class="docs-nav-group">
          <div class="docs-nav-title">Security &amp; Governance</div>
          <a href="#cryptography" class="docs-nav-link">RFC 8785 JCS &amp; CAS Tokens</a>
          <a href="#policy-engine" class="docs-nav-link">Policy Engine &amp; Rules</a>
          <a href="#slack-workflows" class="docs-nav-link">Slack Interactive Flows</a>
        </div>
      </aside>

      <!-- MAIN DOCUMENTATION CONTENT -->
      <div class="docs-main">
        <!-- 1. OVERVIEW -->
        <section id="overview" class="docs-section">
          <div class="section-eyebrow" style="text-align:left; margin-bottom:0.4rem;">Gatekeep Developer Documentation &bull; v1.0</div>
          <h1>Human-in-the-Loop Control Plane for Autonomous Agents</h1>
          <p>
            <strong>Gatekeep</strong> (<a href="https://bsuit.app">bsuit.app</a>) is a cryptographic approval layer that sits between autonomous AI agents (<strong>Claude Code</strong>, <strong>OpenAI Codex / GPT</strong>, <strong>Cursor</strong>, <strong>Hermes Agent</strong>, <strong>OpenClaw</strong>, and custom pipelines) and your production infrastructure.
          </p>
          <p>
            Whenever an agent attempts an irreversible or sensitive action—such as deploying to Kubernetes, running database migrations, issuing Stripe refunds, or modifying cloud resources—Gatekeep pauses execution, posts an interactive Block Kit review card in your designated Slack channel, and issues a single-use execution token bound to the exact <strong>RFC 8785 JSON Canonicalization Scheme (JCS) SHA-256 hash</strong> of the approved parameters.
          </p>

          <div class="agent-badge-grid">
            <a href="#claude-code" class="agent-jump-card">
              <strong>🟠 Claude Code &amp; Desktop</strong>
              <span>Native HTTP MCP &amp; CLAUDE.md</span>
            </a>
            <a href="#openai-codex" class="agent-jump-card">
              <strong>🟢 OpenAI Codex &amp; GPT</strong>
              <span>Codex CLI, Responses API &amp; Actions</span>
            </a>
            <a href="#cursor-windsurf" class="agent-jump-card">
              <strong>🔵 Cursor &amp; Windsurf</strong>
              <span>.cursor/mcp.json &amp; .mdc rules</span>
            </a>
            <a href="#hermes-agent" class="agent-jump-card">
              <strong>🟣 Hermes Agent</strong>
              <span>~/.hermes/config.yaml HTTP MCP</span>
            </a>
            <a href="#openclaw" class="agent-jump-card">
              <strong>🦞 OpenClaw</strong>
              <span>openclaw.json &amp; SOUL.md guardrails</span>
            </a>
            <a href="#rest-api" class="agent-jump-card">
              <strong>⚡ REST API &amp; TS SDK</strong>
              <span>HTTP /v1/requests &amp; @suite/gatekeep-sdk</span>
            </a>
          </div>

          <h3>End-to-End Execution Flow</h3>
          <pre><code>┌──────────────────────┐    1. POST /mcp or /v1/requests    ┌──────────────────────────┐
│  AI Agent Runtime    │ ─────────────────────────────────► │   Gatekeep Control Plane │
│ (Claude, Codex,      │    (action, target, params, risk)  │  • RFC 8785 JCS SHA-256  │
│  Cursor, Hermes,     │                                    │  • Policy Engine Check   │
│  OpenClaw, Python)   │ ◄───────────────────────────────── │  • AES-256-GCM Encrypt   │
└──────────┬───────────┘    2. Long-Poll (wait=25s)         └────────────┬─────────────┘
           │                                                             │
           │ 5. start_execution (Verify Hash &amp; Consume Token)            │ 3. Transactional Outbox
           ▼                                                             ▼
┌──────────────────────┐    6. report_execution (Receipt)   ┌──────────────────────────┐
│ Production Target    │ ─────────────────────────────────► │   Slack Approval Channel │
│ (K8s, DB, Stripe)    │                                    │  [✓ Approve] [✎ Edit]    │
└──────────────────────┘                                    │  [? Ask Info] [✕ Reject] │
                                                            └──────────────────────────┘</code></pre>
        </section>

        <!-- 2. SLACK SETUP & SLASH COMMANDS -->
        <section id="slack-setup" class="docs-section">
          <h2>Slack Installation &amp; Zero-DB Slash Commands</h2>
          <p>
            Gatekeep requires zero external database administration to manage agent credentials. Once installed via <a href="/slack/install">Add to Slack</a>, manage your entire workspace directly from any Slack channel using the <code>/gatekeep</code> command.
          </p>

          <table class="docs-table">
            <thead>
              <tr>
                <th>Slash Command</th>
                <th>Description</th>
                <th>Example</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>/gatekeep new-key &lt;name&gt;</code></td>
                <td>Generates a new scoped Agent API Key (<code>gk_live_&lt;id&gt;_&lt;secret&gt;</code>) and returns a private ephemeral message with ready-to-paste MCP configuration.</td>
                <td><code>/gatekeep new-key claude-prod</code></td>
              </tr>
              <tr>
                <td><code>/gatekeep keys</code></td>
                <td>Lists all active Agent API Keys in your Slack workspace, including key prefix, creator, creation date, and last used timestamp.</td>
                <td><code>/gatekeep keys</code></td>
              </tr>
              <tr>
                <td><code>/gatekeep revoke-key &lt;id&gt;</code></td>
                <td>Immediately revokes an Agent API Key by its ID prefix. Any subsequent MCP or REST calls using that key fail with <code>401 Unauthorized</code>.</td>
                <td><code>/gatekeep revoke-key 48437c334bac</code></td>
              </tr>
              <tr>
                <td><code>/gatekeep status</code></td>
                <td>Displays workspace connection status, default approval channel, and active policy version.</td>
                <td><code>/gatekeep status</code></td>
              </tr>
              <tr>
                <td><code>/gatekeep policy</code></td>
                <td>Displays the active JSON governance policy rules, default verdict, and default TTL.</td>
                <td><code>/gatekeep policy</code></td>
              </tr>
            </tbody>
          </table>

          <div class="callout">
            <strong>Security Note:</strong> The raw secret portion of <code>gk_live_&lt;key_id&gt;_&lt;secret&gt;</code> is shown <strong>only once</strong> inside an ephemeral Slack message visible solely to you. Gatekeep stores only the <code>SHA-256</code> digest of the secret in PostgreSQL.
          </div>
        </section>

        <!-- 3. STATE MACHINE -->
        <section id="state-machine" class="docs-section">
          <h2>Request Lifecycle &amp; CAS State Machine</h2>
          <p>
            Every approval request transitions deterministically using atomic PostgreSQL Compare-And-Swap (CAS) updates. Concurrent clicks in Slack or duplicate network retries cannot cause double execution.
          </p>
          <table class="docs-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Terminal?</th>
                <th>Meaning &amp; Agent Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>pending</code></td>
                <td>No</td>
                <td>Waiting for a human decision in Slack. Agent should continue calling <code>get_approval_status</code> with <code>wait_seconds: 25</code>.</td>
              </tr>
              <tr>
                <td><code>needs_info</code></td>
                <td>No</td>
                <td>A human reviewer clicked <strong>? Ask Info</strong> in Slack and asked a question. Agent should call <code>provide_context</code> with the answer, which transitions the request back to <code>pending</code>.</td>
              </tr>
              <tr>
                <td><code>approved</code></td>
                <td>No (Ready)</td>
                <td>Human clicked <strong>✓ Approve</strong> on Revision #1. A single-use <code>gkt_...</code> token is issued. Agent must call <code>start_execution</code>, execute the action, and call <code>report_execution</code>.</td>
              </tr>
              <tr>
                <td><code>edited</code></td>
                <td>No (Ready)</td>
                <td>Human clicked <strong>✎ Edit</strong>, modified the JSON parameters in Slack, and approved Revision #2+. Agent <strong>must</strong> adopt the returned <code>params</code> and pass them to <code>start_execution</code>.</td>
              </tr>
              <tr>
                <td><code>executing</code></td>
                <td>No</td>
                <td>The single-use approval token has been consumed via <code>start_execution</code> / <code>POST /v1/requests/:id/consume</code>.</td>
              </tr>
              <tr>
                <td><code>executed</code></td>
                <td><strong>Yes</strong></td>
                <td>Agent reported <code>status: "succeeded"</code> via <code>report_execution</code>. Slack card is updated with execution duration and summary.</td>
              </tr>
              <tr>
                <td><code>failed</code></td>
                <td><strong>Yes</strong></td>
                <td>Agent reported <code>status: "failed"</code>. Gatekeep updates the Slack card with the failure alert.</td>
              </tr>
              <tr>
                <td><code>rejected</code></td>
                <td><strong>Yes</strong></td>
                <td>Human clicked <strong>✕ Reject</strong> (or policy matched <code>DENY</code>). Agent must abort the action immediately.</td>
              </tr>
              <tr>
                <td><code>expired</code></td>
                <td><strong>Yes</strong></td>
                <td>No human decided before <code>expires_at</code> (default: 30 minutes). Strict default-deny applies.</td>
              </tr>
              <tr>
                <td><code>cancelled</code></td>
                <td><strong>Yes</strong></td>
                <td>Agent cancelled the pending request via <code>cancel_request</code>.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 4. CLAUDE CODE & CLAUDE DESKTOP -->
        <section id="claude-code" class="docs-section">
          <h2>🟠 Integrating with Claude Code &amp; Claude Desktop</h2>
          <p>
            Gatekeep natively supports Anthropic's <strong>Remote Streamable HTTP MCP</strong> transport. No local Node/Python wrapper or Docker container is required.
          </p>

          <h3>Option A: Claude Code CLI (One-Liner)</h3>
          <p>Run the following command in your terminal to register Gatekeep globally (<code>-s user</code>) or for your current repository (<code>-s project</code>):</p>
          <div class="code-header">
            <span>Terminal — Claude Code CLI</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>claude mcp add --transport http gatekeep https://gatekeep.bsuit.app/mcp \\
  --header "Authorization: Bearer gk_live_YOUR_KEY_ID_SECRET"</code></pre>

          <h3>Option B: Project-Scoped <code>.mcp.json</code> (Recommended for Teams)</h3>
          <p>Check a <code>.mcp.json</code> file into the root of your repository and reference an environment variable so every developer's Claude Code session is governed:</p>
          <div class="code-header">
            <span>.mcp.json</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>{
  "mcpServers": {
    "gatekeep": {
      "type": "http",
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer \${GATEKEEP_API_KEY}"
      }
    }
  }
}</code></pre>

          <h3>Option C: Recommended <code>CLAUDE.md</code> Governance Rule</h3>
          <p>Add this snippet to your project's <code>CLAUDE.md</code> so Claude automatically invokes Gatekeep before high-impact operations:</p>
          <div class="code-header">
            <span>CLAUDE.md</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code># Gatekeep Human-in-the-Loop Governance
Before running any production deployment, Terraform/Helm apply, database migration, destructive SQL query, or external customer action:
1. Call the \`gatekeep\` MCP tool \`request_approval\` with \`action\`, \`target\`, exact \`params\`, and \`justification\`.
2. Poll \`get_approval_status\` with \`wait_seconds: 25\` until the status is terminal.
3. If status is \`needs_info\`, answer the reviewer's question using \`provide_context\`.
4. Only if status is \`approved\` or \`edited\`, call \`start_execution\` (using the revised params if \`edited\`), run the command, and call \`report_execution\`.</code></pre>
        </section>

        <!-- 5. OPENAI CODEX CLI & OPENAI RESPONSES API / CHATGPT -->
        <section id="openai-codex" class="docs-section">
          <h2>🟢 Integrating with OpenAI Codex CLI, Responses API &amp; ChatGPT</h2>
          <p>
            Gatekeep integrates directly with <strong>OpenAI Codex CLI</strong>, the <strong>OpenAI Responses API</strong> (native Remote MCP tool in <code>gpt-4.1</code>, <code>o3</code>, <code>o4-mini</code>, and <code>gpt-5</code>), and <strong>ChatGPT Custom GPT Actions</strong>.
          </p>

          <h3>1. OpenAI Codex CLI (<code>~/.codex/config.toml</code>)</h3>
          <p>
            OpenAI's open-source terminal agent (<code>codex</code>) supports remote Streamable HTTP MCP servers in <code>~/.codex/config.toml</code>:
          </p>
          <div class="code-header">
            <span>~/.codex/config.toml</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>[mcp_servers.gatekeep]
url = "https://gatekeep.bsuit.app/mcp"
http_headers = { Authorization = "Bearer gk_live_YOUR_KEY_ID_SECRET" }</code></pre>
          <p style="font-size:0.86rem; color:var(--muted);">
            Tip: You can also use <code>env_http_headers = { Authorization = "GATEKEEP_BEARER_TOKEN" }</code> in <code>~/.codex/config.toml</code> if you prefer storing the token in your shell environment.
          </p>

          <h3>2. OpenAI Responses API (Native Remote MCP Connector)</h3>
          <p>
            When building agents with the official OpenAI SDK, pass Gatekeep directly as a native Remote MCP tool. OpenAI's cloud runtime connects directly to <code>https://gatekeep.bsuit.app/mcp</code>:
          </p>
          <div class="code-header">
            <span>TypeScript / Node.js — OpenAI Responses API</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>import OpenAI from "openai";

const client = new OpenAI();

const response = await client.responses.create({
  model: "gpt-4.1",
  tools: [
    {
      type: "mcp",
      server_label: "gatekeep",
      server_url: "https://gatekeep.bsuit.app/mcp",
      headers: {
        Authorization: \`Bearer \${process.env.GATEKEEP_API_KEY}\`,
      },
      require_approval: "never", // Gatekeep enforces human approval in Slack
    },
  ],
  input: "Request Slack approval via Gatekeep before scaling prod-api to 6 replicas.",
});</code></pre>

          <h3>3. ChatGPT Custom GPTs (OpenAPI 3.1 Action Schema)</h3>
          <p>
            To allow a Custom GPT inside ChatGPT Team/Enterprise to request human approvals in Slack, configure an Action with Authentication set to <strong>API Key (Bearer)</strong> and paste this OpenAPI 3.1 schema:
          </p>
          <div class="code-header">
            <span>OpenAPI 3.1 Schema for ChatGPT Actions</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>openapi: 3.1.0
info:
  title: Gatekeep Human Approval API
  version: 1.0.0
servers:
  - url: https://gatekeep.bsuit.app
paths:
  /v1/requests:
    post:
      operationId: requestApproval
      summary: Request human approval in Slack before executing a sensitive action
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [action, params, justification]
              properties:
                action: { type: string, example: "stripe.refund.create" }
                target: { type: string, example: "stripe:prod" }
                params: { type: object }
                justification: { type: string }
      responses:
        "201":
          description: Created pending approval request
  /v1/requests/{id}:
    get:
      operationId: getApprovalStatus
      summary: Poll approval status (pass wait=25 for long polling)
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
        - name: wait
          in: query
          schema: { type: integer, default: 25 }
      responses:
        "200":
          description: Current request status</code></pre>
        </section>

        <!-- 6. CURSOR & WINDSURF -->
        <section id="cursor-windsurf" class="docs-section">
          <h2>🔵 Integrating with Cursor &amp; Windsurf IDE</h2>
          <p>
            Connect Cursor or Windsurf to Gatekeep in under 30 seconds using the Remote MCP configuration file.
          </p>

          <h3>Cursor (<code>.cursor/mcp.json</code> or <code>~/.cursor/mcp.json</code>)</h3>
          <div class="code-header">
            <span>.cursor/mcp.json</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>{
  "mcpServers": {
    "gatekeep": {
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_YOUR_KEY_ID_SECRET"
      }
    }
  }
}</code></pre>

          <h3>Windsurf (<code>~/.codeium/windsurf/mcp_config.json</code>)</h3>
          <div class="code-header">
            <span>~/.codeium/windsurf/mcp_config.json</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>{
  "mcpServers": {
    "gatekeep": {
      "serverUrl": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_YOUR_KEY_ID_SECRET"
      }
    }
  }
}</code></pre>
        </section>

        <!-- 7. HERMES AGENT -->
        <section id="hermes-agent" class="docs-section">
          <h2>🟣 Integrating with Hermes Agent (Nous Research)</h2>
          <p>
            <strong>Hermes Agent</strong> is an autonomous multi-step agent capable of shell execution, subagent delegation, and persistent memory. Because Hermes runs unattended background loops, pairing it with Gatekeep ensures it cannot execute destructive commands without human sign-off in Slack.
          </p>

          <h3>1. Add Gatekeep to <code>~/.hermes/config.yaml</code></h3>
          <p>
            Configure Gatekeep under the <code>mcp_servers</code> section in your Hermes configuration file:
          </p>
          <div class="code-header">
            <span>~/.hermes/config.yaml</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>mcp_servers:
  gatekeep:
    transport: http
    url: "https://gatekeep.bsuit.app/mcp"
    headers:
      Authorization: "Bearer gk_live_YOUR_KEY_ID_SECRET"
    timeout: 60</code></pre>

          <h3>2. Add a Hermes Governance Skill / Memory Rule</h3>
          <p>
            Instruct Hermes Agent in your workspace instructions or persistent memory so autonomous subagents always gate high-risk actions:
          </p>
          <div class="code-header">
            <span>Hermes Agent Governance Instruction</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>When running autonomous tasks that mutate production state, modify cloud infrastructure, delete files/tables, or send external messages:
- Always call the \`gatekeep\` MCP tool \`request_approval\` first.
- Wait for approval via \`get_approval_status(request_id, wait_seconds=25)\`.
- If the human reviewer edits the parameters (\`status == "edited"\`), strictly use the updated parameters returned by Gatekeep.
- Call \`start_execution\` right before running the command and \`report_execution\` immediately after.</code></pre>
        </section>

        <!-- 8. OPENCLAW -->
        <section id="openclaw" class="docs-section">
          <h2>🦞 Integrating with OpenClaw</h2>
          <p>
            <strong>OpenClaw</strong> agents operate continuously across messaging platforms, local shells, and browser sessions. Adding Gatekeep gives you a cryptographic kill-switch and parameter editor in Slack before OpenClaw runs privileged skills.
          </p>

          <h3>1. Register Gatekeep in <code>~/.openclaw/openclaw.json</code></h3>
          <div class="code-header">
            <span>~/.openclaw/openclaw.json</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>{
  "mcpServers": {
    "gatekeep": {
      "type": "streamable-http",
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_YOUR_KEY_ID_SECRET"
      }
    }
  }
}</code></pre>

          <h3>2. Add Guardrail Policy to OpenClaw <code>SOUL.md</code> or <code>AGENTS.md</code></h3>
          <div class="code-header">
            <span>~/.openclaw/workspace/SOUL.md</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>## Mandatory Slack Approval via Gatekeep (bsuit.app)
Never execute shell commands that alter production servers, transfer funds, delete repositories, or send bulk external communications without first obtaining a verified Gatekeep token:
1. Call \`gatekeep.request_approval\` with the exact command/parameters.
2. Poll \`gatekeep.get_approval_status\` until \`approved\` or \`edited\`.
3. Call \`gatekeep.start_execution\` to consume the single-use token, execute the skill, and log the result with \`gatekeep.report_execution\`.</code></pre>
        </section>

        <!-- 9. PYTHON / LANGGRAPH / CREWAI -->
        <section id="langgraph-python" class="docs-section">
          <h2>🐍 Python, LangGraph &amp; CrewAI Integration</h2>
          <p>
            Any Python agent or workflow can call Gatekeep's REST API directly with standard <code>httpx</code> or <code>requests</code>—zero custom SDK dependencies required:
          </p>
          <div class="code-header">
            <span>Python — Governed Tool Wrapper</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>import os, time, httpx

GATEKEEP_URL = "https://gatekeep.bsuit.app"
HEADERS = {"Authorization": f"Bearer {os.environ['GATEKEEP_API_KEY']}"}

def require_slack_approval(action: str, target: str, params: dict, justification: str) -> dict:
    with httpx.Client(timeout=35.0) as client:
        # 1. Create approval request
        req = client.post(f"{GATEKEEP_URL}/v1/requests", headers=HEADERS, json={
            "action": action,
            "target": target,
            "params": params,
            "justification": justification,
        }).raise_for_status().json()
        req_id = req["id"]

        # 2. Long-poll until human decides in Slack
        while True:
            status_res = client.get(f"{GATEKEEP_URL}/v1/requests/{req_id}?wait=25", headers=HEADERS).json()
            st = status_res["status"]
            if st in ("approved", "edited"):
                return status_res
            if st in ("rejected", "expired", "cancelled"):
                raise PermissionError(f"Action {action} denied by Gatekeep ({st})")
            time.sleep(1)</code></pre>
        </section>

        <!-- 10. MCP REFERENCE -->
        <section id="mcp-reference" class="docs-section">
          <h2>🔌 Remote Model Context Protocol (MCP) Reference</h2>
          <p>
            Gatekeep exposes a stateless JSON-RPC 2.0 MCP server at <code>POST https://gatekeep.bsuit.app/mcp</code> (alias: <code>POST https://gatekeep.bsuit.app/gatekeep</code>).
          </p>
          <ul>
            <li><strong>Protocol Version:</strong> <code>2024-11-05</code> / <code>2025-03-26</code> (Streamable HTTP)</li>
            <li><strong>Authentication:</strong> <code>Authorization: Bearer gk_live_&lt;key_id&gt;_&lt;secret&gt;</code></li>
            <li><strong>Supported JSON-RPC Methods:</strong> <code>initialize</code>, <code>ping</code>, <code>tools/list</code>, <code>tools/call</code>, <code>prompts/list</code>, <code>prompts/get</code></li>
          </ul>

          <h3>Available MCP Tools (6 Tools)</h3>
          <table class="docs-table">
            <thead>
              <tr>
                <th>Tool Name</th>
                <th>Required Arguments</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>request_approval</code></td>
                <td><code>action</code>, <code>params</code>, <code>justification</code></td>
                <td>Creates a new governed request, computes the RFC 8785 JCS SHA-256 hash, evaluates workspace policy, and dispatches an interactive Slack card. Optional: <code>target</code>, <code>risk</code> (<code>low</code>|<code>medium</code>|<code>high</code>|<code>critical</code>), <code>preview</code>, <code>editable</code>, <code>expires_in_seconds</code>.</td>
              </tr>
              <tr>
                <td><code>get_approval_status</code></td>
                <td><code>request_id</code></td>
                <td>Polls the current status of the request. Pass <code>wait_seconds: 25</code> (default) to hold the HTTP connection until a human clicks a button in Slack.</td>
              </tr>
              <tr>
                <td><code>provide_context</code></td>
                <td><code>request_id</code>, <code>answer</code></td>
                <td>When an approver clicks <strong>? Ask Info</strong> in Slack (<code>status: "needs_info"</code>), call this tool to post the agent's answer back to the Slack card and return status to <code>pending</code>.</td>
              </tr>
              <tr>
                <td><code>start_execution</code></td>
                <td><code>request_id</code>, <code>params</code></td>
                <td>Verifies that <code>params</code> match the approved revision's JCS canonical hash and atomically consumes the single-use <code>gkt_...</code> approval token.</td>
              </tr>
              <tr>
                <td><code>report_execution</code></td>
                <td><code>request_id</code>, <code>status</code></td>
                <td>Reports final execution outcome (<code>succeeded</code> | <code>failed</code> | <code>skipped</code>), optional <code>summary</code>, and <code>output_url</code>. Updates the Slack card in place.</td>
              </tr>
              <tr>
                <td><code>cancel_request</code></td>
                <td><code>request_id</code></td>
                <td>Cancels a <code>pending</code> request and updates the Slack card to <code>Cancelled</code>.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 11. REST API REFERENCE -->
        <section id="rest-api" class="docs-section">
          <h2>⚡ REST API Reference (<code>/v1</code>)</h2>
          <p>
            All REST endpoints are served over HTTPS from <code>https://gatekeep.bsuit.app</code> and require a Bearer API key in the <code>Authorization</code> header.
          </p>

          <!-- POST /v1/requests -->
          <div class="endpoint-box">
            <div class="endpoint-header">
              <span class="badge-method badge-post">POST</span>
              <code>https://gatekeep.bsuit.app/v1/requests</code>
            </div>
            <p style="font-size:0.88rem; margin:0.25rem 0 0.75rem;">
              Submits a new action for policy evaluation and human approval in Slack. Supports optional <code>Idempotency-Key</code> header (returns <code>200 OK</code> if identical payload hash, or <code>409 Conflict</code> if payload differs).
            </p>
            <div class="code-header">
              <span>Request &amp; 201 Created Response</span>
              <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
            </div>
            <pre><code>// POST /v1/requests
{
  "action": "deploy.k8s.rollout",
  "target": "civo:prod-k3s/slack-suite",
  "risk": "high",
  "params": {
    "service": "gatekeep-app",
    "image_tag": "6829205c9e44",
    "replicas": 3
  },
  "justification": "Roll out new landing page and /docs portal",
  "callback_url": "https://ci.example.com/webhooks/gatekeep"
}

// Response (201 Created)
{
  "id": "gk_req_04550bcd55d74ba48d294be1",
  "status": "pending",
  "params_hash": "kzgOWh_-FfHbf6EG8s1vN4xL9qP2mW7rT0yU3iO5pA8",
  "risk": "high",
  "gate": "slack_channel",
  "expires_at": "2026-10-17T05:00:00.000Z",
  "poll_url": "https://gatekeep.bsuit.app/v1/requests/gk_req_04550bcd55d74ba48d294be1"
}</code></pre>
          </div>

          <!-- GET /v1/requests/:id -->
          <div class="endpoint-box">
            <div class="endpoint-header">
              <span class="badge-method badge-get">GET</span>
              <code>https://gatekeep.bsuit.app/v1/requests/:id?wait=25</code>
            </div>
            <p style="font-size:0.88rem; margin:0.25rem 0 0.75rem;">
              Retrieves the current state of an approval request. Pass <code>?wait=1..30</code> to enable server-side long-polling: the server holds the request open until the status changes from <code>pending</code> or the timeout elapses.
            </p>
            <pre><code>// Response (200 OK)
{
  "id": "gk_req_04550bcd55d74ba48d294be1",
  "status": "approved",
  "action": "deploy.k8s.rollout",
  "target": "civo:prod-k3s/slack-suite",
  "risk": "high",
  "gate": "slack_channel",
  "current_revision": 1,
  "params_hash": "kzgOWh_-FfHbf6EG8s1vN4xL9qP2mW7rT0yU3iO5pA8",
  "expires_at": "2026-10-17T05:00:00.000Z",
  "decided_at": "2026-10-17T04:31:12.000Z",
  "executed_at": null
}</code></pre>
          </div>

          <!-- POST /v1/requests/:id/consume -->
          <div class="endpoint-box">
            <div class="endpoint-header">
              <span class="badge-method badge-post">POST</span>
              <code>https://gatekeep.bsuit.app/v1/requests/:id/consume</code>
            </div>
            <p style="font-size:0.88rem; margin:0.25rem 0 0.75rem;">
              Atomically verifies the single-use <code>approval_token</code> (<code>gkt_...</code>) and checks that <code>params_hash</code> matches the approved revision. Transitions status to <code>executing</code>.
            </p>
            <pre><code>// Request Body
{
  "approval_token": "gkt_9f8a21c4e7b01928374655647382910abcdef1234567890",
  "params_hash": "kzgOWh_-FfHbf6EG8s1vN4xL9qP2mW7rT0yU3iO5pA8"
}

// Response (200 OK)
{
  "ok": true,
  "status": "executing",
  "jti": "c9a8b7d6-e5f4-4321-8765-1029384756ab"
}</code></pre>
          </div>

          <!-- POST /v1/requests/:id/receipt -->
          <div class="endpoint-box">
            <div class="endpoint-header">
              <span class="badge-method badge-post">POST</span>
              <code>https://gatekeep.bsuit.app/v1/requests/:id/receipt</code>
            </div>
            <p style="font-size:0.88rem; margin:0.25rem 0 0.75rem;">
              Records the final execution outcome (<code>succeeded</code>, <code>failed</code>, or <code>skipped</code>) and updates the Slack card with the execution badge, summary, and duration.
            </p>
            <pre><code>// Request Body
{
  "status": "succeeded",
  "summary": "2/2 replicas rolled out healthy in namespace slack-suite",
  "output_url": "https://signoz.bsuit.app",
  "duration_ms": 1420
}

// Response (200 OK)
{
  "ok": true,
  "status": "executed"
}</code></pre>
          </div>

          <!-- POST /v1/requests/:id/context & /cancel -->
          <div class="endpoint-box">
            <div class="endpoint-header">
              <span class="badge-method badge-post">POST</span>
              <code>/v1/requests/:id/context</code> &amp; <code>/v1/requests/:id/cancel</code>
            </div>
            <p style="font-size:0.88rem; margin:0.25rem 0 0.75rem;">
              <code>POST /v1/requests/:id/context</code> submits <code>{"answer": "..."}</code> when a reviewer asks a question (<code>needs_info</code> &rarr; <code>pending</code>).<br>
              <code>POST /v1/requests/:id/cancel</code> submits <code>{"reason": "..."}</code> to abort a pending request (<code>pending</code> &rarr; <code>cancelled</code>).
            </p>
          </div>
        </section>

        <!-- 12. TYPESCRIPT / DENO SDK -->
        <section id="sdk-reference" class="docs-section">
          <h2>📦 TypeScript / Deno / Node.js SDK (<code>@suite/gatekeep-sdk</code>)</h2>
          <p>
            The official TypeScript SDK provides a high-level <code>gk.guard()</code> method that orchestrates request creation, long-polling, JCS hash validation, token consumption, and execution receipt reporting in a single call.
          </p>
          <div class="code-header">
            <span>TypeScript — GatekeepClient.guard()</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>import { GatekeepClient } from "@suite/gatekeep-sdk";

const gk = new GatekeepClient({
  apiKey: process.env.GATEKEEP_API_KEY!,
  baseUrl: "https://gatekeep.bsuit.app",
});

const result = await gk.guard(
  {
    action: "db.migration.apply",
    target: "postgres:prod-origin",
    risk: "critical",
    params: {
      migration: "004_add_billing_index.sql",
      lock_timeout_ms: 5000,
    },
    justification: "Add composite index for monthly quota queries",
  },
  async (approvedParams) => {
    // Runs ONLY after Slack approval (and uses revised params if human edited them)
    return await applyMigration(approvedParams);
  },
);</code></pre>
        </section>

        <!-- 13. CRYPTOGRAPHY & RFC 8785 -->
        <section id="cryptography" class="docs-section">
          <h2>🔒 Cryptographic Integrity: RFC 8785 (JCS) &amp; Single-Use Tokens</h2>
          <p>
            Standard JSON serialization is non-deterministic because object key ordering varies across languages and runtimes. Gatekeep implements <strong>RFC 8785 (JSON Canonicalization Scheme — JCS)</strong> to guarantee byte-identical canonical representations across Deno, Node.js, Python, Go, and Rust.
          </p>

          <h3>How Canonical Hash Binding Works</h3>
          <ol>
            <li>Gatekeep constructs the canonical envelope: <code>{"action": action, "params": params, "revision": revision, "target": target}</code>.</li>
            <li>All object keys are recursively sorted lexicographically by UTF-16 code units, whitespace is stripped, and numbers are formatted per IEEE 754 / ECMAScript rules.</li>
            <li>The UTF-8 byte stream is hashed with <strong>SHA-256</strong> and encoded as <strong>base64url</strong> (no padding).</li>
            <li>When a human clicks <strong>✓ Approve</strong> in Slack, the button payload includes the exact <code>params_hash</code> displayed on the card. If the card revision changed in the meantime, PostgreSQL rejects the stale decision.</li>
          </ol>

          <div class="callout warn">
            <strong>Tamper Protection:</strong> If an AI agent gets approval for <code>{"amount_cents": 500}</code> and attempts to call <code>start_execution</code> with <code>{"amount_cents": 50000}</code>, the recomputed JCS SHA-256 hash will not match the token's bound <code>params_hash</code>, and Gatekeep immediately blocks execution.
          </div>
        </section>

        <!-- 14. POLICY ENGINE -->
        <section id="policy-engine" class="docs-section">
          <h2>⚖️ Policy Engine &amp; Governance Rules</h2>
          <p>
            Each Slack workspace has a versioned <code>GatekeepPolicyDocument</code> evaluated on every incoming request. Rules are matched in order using glob patterns on <code>action</code> and <code>target</code>.
          </p>
          <div class="code-header">
            <span>Example Workspace Policy JSON</span>
            <button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button>
          </div>
          <pre><code>{
  "version": 2,
  "default_verdict": "REVIEW",
  "default_risk": "medium",
  "default_ttl_seconds": 1800,
  "default_channel_id": "C0C74RUH52R",
  "rules": [
    {
      "id": "allow-staging-deploys",
      "action_glob": "deploy.*",
      "target_glob": "env:staging*",
      "verdict": "AUTO_APPROVE",
      "risk": "low"
    },
    {
      "id": "prod-critical-review",
      "action_glob": "deploy.k8s.*",
      "target_glob": "civo:prod*",
      "verdict": "REVIEW",
      "risk": "critical",
      "ttl_seconds": 900,
      "slack_channel_id": "C0C74RUH52R"
    },
    {
      "id": "block-drop-database",
      "action_glob": "db.drop.*",
      "verdict": "DENY",
      "risk": "critical"
    }
  ]
}</code></pre>
        </section>

        <!-- 15. SLACK WORKFLOWS -->
        <section id="slack-workflows" class="docs-section">
          <h2>💬 Slack Interactive Workflows</h2>
          <p>
            Every Gatekeep approval card in Slack gives human reviewers four interactive actions:
          </p>
          <ul>
            <li><strong>✓ Approve:</strong> Atomically transitions the request to <code>approved</code>, generates a single-use <code>gkt_...</code> token (5-minute TTL), cancels the expiration timer, and updates the card with the approver's Slack handle.</li>
            <li><strong>✎ Edit:</strong> Opens a Slack modal pre-populated with the decrypted JSON parameters. When submitted, Gatekeep increments <code>current_revision</code> (e.g., <code>Rev #2</code>), computes the new RFC 8785 JCS hash, encrypts the new parameters with AES-256-GCM, and transitions the request to <code>edited</code>.</li>
            <li><strong>? Ask Info:</strong> Opens a modal for the reviewer to ask a clarifying question (e.g., <em>"Did the dry-run migration succeed on staging?"</em>). Transitions the request to <code>needs_info</code> so the agent can reply via <code>provide_context</code>.</li>
            <li><strong>✕ Reject:</strong> Opens a modal for an optional rejection reason, transitions the request to <code>rejected</code>, and immediately notifies the waiting agent to abort.</li>
          </ul>
        </section>
      </div>
    </div>

    <script>
      function copyCode(btn) {
        var header = btn.parentElement;
        var pre = header.nextElementSibling;
        if (!pre) return;
        var text = pre.innerText || pre.textContent;
        navigator.clipboard.writeText(text).then(function() {
          var orig = btn.textContent;
          btn.textContent = 'Copied ✓';
          btn.style.color = '#34d399';
          setTimeout(function() {
            btn.textContent = orig;
            btn.style.color = '';
          }, 1800);
        });
      }

      function filterDocsNav(query) {
        var q = (query || '').toLowerCase().trim();
        var links = document.querySelectorAll('.docs-nav-link');
        for (var i = 0; i < links.length; i++) {
          var txt = (links[i].textContent || '').toLowerCase();
          var href = (links[i].getAttribute('href') || '').toLowerCase();
          links[i].style.display = (!q || txt.indexOf(q) !== -1 || href.indexOf(q) !== -1) ? 'block' : 'none';
        }
      }
    </script>
    `,
    true,
  );
}
