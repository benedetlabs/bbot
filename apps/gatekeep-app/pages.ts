/**
 * @module @apps/gatekeep-app/pages
 * Public HTML pages for Gatekeep (landing, privacy, support, install confirmation, error).
 * Satisfies Slack Marketplace requirements for public distribution.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b0f19;
      --card: #111827;
      --ink: #f9fafb;
      --muted: #9ca3af;
      --line: #1f2937;
      --accent: #38bdf8;
      --accent-hover: #0ea5e9;
      --button-bg: #2563eb;
      --button-hover: #1d4ed8;
      --button-ink: #ffffff;
      --code-bg: #1e293b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --card: #ffffff;
        --ink: #0f172a;
        --muted: #64748b;
        --line: #e2e8f0;
        --accent: #0284c7;
        --accent-hover: #0369a1;
        --button-bg: #2563eb;
        --button-hover: #1d4ed8;
        --button-ink: #ffffff;
        --code-bg: #f1f5f9;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      padding: 0 1.25rem 4rem;
    }
    header {
      max-width: 48rem;
      margin: 0 auto;
      padding: 2rem 0 1.5rem;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header a.brand {
      font-weight: 700;
      font-size: 1.25rem;
      color: var(--ink);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    header nav a {
      color: var(--muted);
      text-decoration: none;
      margin-left: 1.25rem;
      font-size: 0.95rem;
      transition: color 0.15s ease;
    }
    header nav a:hover { color: var(--ink); }
    main {
      max-width: 48rem;
      margin: 2.5rem auto 0;
    }
    h1 {
      font-size: 2.25rem;
      line-height: 1.2;
      letter-spacing: -0.03em;
      margin: 0 0 1rem;
    }
    h2 {
      font-size: 1.5rem;
      letter-spacing: -0.02em;
      margin: 2.25rem 0 0.75rem;
      border-bottom: 1px solid var(--line);
      padding-bottom: 0.5rem;
    }
    p { margin: 0.75rem 0; color: var(--muted); }
    strong { color: var(--ink); }
    ul, ol { color: var(--muted); padding-left: 1.5rem; }
    li { margin: 0.5rem 0; }
    a { color: var(--accent); }
    a:hover { color: var(--accent-hover); }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      font-weight: 600;
      border-radius: 8px;
      text-decoration: none;
      background: var(--button-bg);
      color: var(--button-ink);
      transition: background 0.15s ease;
      margin-top: 1rem;
    }
    .btn:hover {
      background: var(--button-hover);
      color: var(--button-ink);
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1.75rem;
      margin: 1.5rem 0;
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 1rem;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem;
      color: var(--ink);
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
      background: var(--code-bg);
      padding: 0.15em 0.35em;
      border-radius: 4px;
    }
    footer {
      max-width: 48rem;
      margin: 4rem auto 0;
      padding-top: 1.5rem;
      border-top: 1px solid var(--line);
      text-align: center;
      font-size: 0.85rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <header>
    <a href="/" class="brand">🛡️ Gatekeep</a>
    <nav>
      <a href="/">Overview</a>
      <a href="/privacy">Privacy</a>
      <a href="/support">Support</a>
      <a href="/slack/install">Install</a>
    </nav>
  </header>
  <main>
    ${body}
  </main>
  <footer>
    &copy; ${new Date().getFullYear()} Benedet Labs &bull; <a href="https://bsuit.app">bsuit.app</a> &bull; <a href="/privacy">Privacy Policy</a> &bull; <a href="/support">Support</a>
  </footer>
</body>
</html>`;
}

export function landingPage(): string {
  return layout(
    "Gatekeep — Human-in-the-Loop AI Approvals for Slack",
    `<h1>Human approval for AI agents — right in Slack</h1>
    <p>Gatekeep provides a secure human-in-the-loop control plane for AI agents (Cursor, Claude Code, LangGraph, custom agents) and CI/CD pipelines before they execute irreversible real-world actions.</p>
    
    <div style="margin: 2rem 0;">
      <a href="/slack/install" class="btn">
        <svg width="20" height="20" viewBox="0 0 122.8 122.8" fill="none"><path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/><path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zm0 6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 1 1 0-25.8h32.3z" fill="#36C5F0"/><path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zm-6.5 0a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/><path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 1 1 0 25.8H77.6z" fill="#ECB22E"/></svg>
        Add to Slack
      </a>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Why Gatekeep?</h3>
      <ul>
        <li><strong>Cryptographic Hash Binding (RFC 8785):</strong> The approval token is cryptographically bound to the SHA-256 canonical hash of the action and parameters. What runs is guaranteed to match what the human approved.</li>
        <li><strong>Single-Use Execution Tokens:</strong> Tokens expire quickly and cannot be reused or manipulated by hallucinating LLMs.</li>
        <li><strong>Zero Context-Switching:</strong> Review risk level, parameters, and justification directly in Slack with sub-300ms interactive acknowledgments.</li>
        <li><strong>Closed-Loop Receipts:</strong> Once execution completes, the Slack card updates in real time to show execution status and duration.</li>
        <li><strong>Default-Deny Governance:</strong> Timeouts, policy omissions, and connection drops always resolve safely to rejection.</li>
      </ul>
    </div>

    <h2>How it works</h2>
    <ol>
      <li><strong>Agent pauses before execution:</strong> When your agent or pipeline is about to run a dangerous command (e.g. <code>terraform apply</code>, <code>DROP TABLE</code>, Stripe refund), it calls Gatekeep via MCP, REST API, or TypeScript/Python SDK.</li>
      <li><strong>Interactive Slack Card:</strong> Gatekeep posts a structured approval card to your designated ops or governance channel.</li>
      <li><strong>Human Decision:</strong> Authorized team members can <strong>Approve</strong>, <strong>Reject</strong> with reason, <strong>Edit parameters</strong>, or <strong>Ask for context</strong>.</li>
      <li><strong>Guaranteed Execution:</strong> The agent receives a single-use token and verifies parameter integrity before performing the action.</li>
    </ol>

    <h2>Connect via Model Context Protocol (MCP)</h2>
    <p>Add Gatekeep to your Cursor or Claude Code configuration in seconds:</p>
    <pre><code>{
  "mcpServers": {
    "gatekeep": {
      "command": "deno",
      "args": [
        "run",
        "-A",
        "jsr:@suite/gatekeep-mcp",
        "--api-key",
        "gk_live_your_key_id_secret",
        "--server",
        "https://gatekeep.bsuit.app"
      ]
    }
  }
}</code></pre>`,
  );
}

export function privacyPage(): string {
  return layout(
    "Gatekeep Privacy Policy",
    `<h1>Privacy Policy</h1>
    <p>Last updated: October 2026. Gatekeep is an enterprise micro-utility by Benedet Labs that provides human-in-the-loop approval workflows for Slack.</p>

    <h2>1. Data We Collect</h2>
    <ul>
      <li><strong>Slack Installation Metadata:</strong> Workspace ID, workspace name, enterprise ID (if applicable), and installer user ID.</li>
      <li><strong>Slack Bot Tokens:</strong> Bot tokens required to post Block Kit cards and update interactive views. Tokens are encrypted at rest with AES-256-GCM using hardware-derived master keys.</li>
      <li><strong>Approval Request Payloads:</strong> Action names, target identifiers, parameters JSON, justification notes, and execution results submitted by your agents.</li>
      <li><strong>Decisions & Audit Logs:</strong> User ID of the decision maker, timestamp, decision outcome, review comments, and canonical hash digests.</li>
    </ul>

    <h2>2. How We Use Data</h2>
    <ul>
      <li>To present interactive approval cards and modals in your designated Slack channels.</li>
      <li>To verify cryptographic parameter integrity via RFC 8785 JSON Canonicalization Scheme (JCS).</li>
      <li>To maintain tamper-evident audit records of human oversight for compliance purposes.</li>
      <li>We <strong>never sell</strong> customer data, and we <strong>never use</strong> customer approval payloads, parameters, or actions to train machine learning models.</li>
    </ul>

    <h2>3. Data Retention & Deletion</h2>
    <ul>
      <li><strong>Uninstalling the app:</strong> When the Gatekeep Slack app is uninstalled or tokens are revoked, the encrypted bot credentials and active pending approval requests for that workspace are purged immediately.</li>
      <li><strong>Audit Logs:</strong> Historical decision records and execution receipts are retained for your compliance records and can be completely removed upon request.</li>
      <li><strong>Right to Deletion:</strong> To request complete deletion of workspace records or an export of audit logs, email <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>. Requests are honored within two business days.</li>
    </ul>

    <h2>4. Security</h2>
    <p>All HTTP communications require TLS 1.3. Slack requests are validated using HMAC-SHA256 request signature verification with timing-safe comparison. Sensitive tokens are encrypted using AES-256-GCM fail-fast cryptography.</p>

    <h2>5. Contact Us</h2>
    <p>If you have questions about this privacy policy, please contact us at <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>.</p>`,
  );
}

export function supportPage(): string {
  return layout(
    "Gatekeep Support",
    `<h1>Support & Help Center</h1>
    <p>Need assistance configuring Gatekeep, setting up policies, or connecting agents via MCP? We are here to help.</p>

    <div class="card">
      <h3 style="margin-top:0;">Direct Contact</h3>
      <p>Email our engineering team directly at <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>. We respond to all technical and account inquiries within two business days.</p>
    </div>

    <h2>Frequently Asked Questions</h2>
    <h3>How do I generate an agent API key?</h3>
    <p>Open the Gatekeep App Home in Slack by clicking on <strong>Gatekeep</strong> in your Slack sidebar, or run <code>/gatekeep status</code> in any channel. You can generate scoped keys for your CI/CD pipelines and AI agents.</p>

    <h3>What happens if a request times out?</h3>
    <p>Gatekeep operates under a strict <strong>default-deny</strong> security model. If no human reviews the card before the configured timeout (default: 15 minutes), the request expires and any execution attempts are rejected.</p>

    <h3>Can an agent tamper with parameters after approval?</h3>
    <p>No. When an approval is granted, an execution token is cryptographically bound to the RFC 8785 canonical hash of the approved parameters. If the agent changes even a single character before calling <code>/v1/requests/:id/execute</code>, the execution is blocked.</p>

    <h2>Documentation & Resources</h2>
    <ul>
      <li><a href="https://bsuit.app">bsuit.app home</a></li>
      <li><a href="/privacy">Privacy Policy</a></li>
      <li><a href="/slack/install">Install Gatekeep to Slack</a></li>
    </ul>`,
  );
}

export function installedPage(teamName: string): string {
  return layout(
    "Gatekeep Installed Successfully",
    `<h1>🛡️ Gatekeep is installed!</h1>
    <p>Gatekeep has been successfully connected to <strong>${escapeHtml(teamName)}</strong>.</p>
    
    <div class="card">
      <h3 style="margin-top:0;">Next Steps</h3>
      <ol>
        <li>Open Slack and go to the <strong>Gatekeep</strong> app in your sidebar.</li>
        <li>Check the <strong>App Home</strong> tab to verify your workspace status.</li>
        <li>Configure your AI agents or CI/CD pipelines with the Gatekeep REST API or MCP server.</li>
      </ol>
    </div>

    <p><a href="/" class="btn">Go to Overview</a></p>`,
  );
}

export function oauthErrorPage(message: string): string {
  return layout(
    "Gatekeep Installation Error",
    `<h1>Installation Incomplete</h1>
    <p style="color: #ef4444;">${escapeHtml(message)}</p>
    <p>Please try the installation again from the link below:</p>
    <p><a href="/slack/install" class="btn">Retry Installation</a></p>`,
  );
}
