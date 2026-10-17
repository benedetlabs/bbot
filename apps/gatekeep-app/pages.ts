/**
 * @module @apps/gatekeep-app/pages
 * Public HTML pages for Gatekeep & bsuit.app (Flagship Landing Page, Privacy, Support, OAuth).
 * Designed in Dark Tech / Control Plane aesthetic (Linear / Vercel / Cloudflare inspired).
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const BRAND_LOGO_SVG = `<svg width="32" height="32" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="gk-grad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#10B981"/>
      <stop offset="100%" stop-color="#06B6D4"/>
    </linearGradient>
    <linearGradient id="gk-glow" x1="6" y1="4" x2="30" y2="32" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#10B981" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#06B6D4" stop-opacity="0.05"/>
    </linearGradient>
  </defs>
  <path d="M18 2.5L31 8.2V17.6C31 25.7 25.4 32.1 18 34C10.6 32.1 5 25.7 5 17.6V8.2L18 2.5Z" fill="url(#gk-glow)" stroke="url(#gk-grad)" stroke-width="2"/>
  <path d="M12.5 15.5V13.5C12.5 10.46 14.96 8 18 8C21.04 8 23.5 10.46 23.5 13.5V15.5" stroke="#E2E8F0" stroke-width="2" stroke-linecap="round"/>
  <rect x="10.5" y="15.5" width="15" height="11" rx="3" fill="#090D16" stroke="url(#gk-grad)" stroke-width="1.8"/>
  <path d="M15.5 21L17.3 22.8L20.8 19.3" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const FAVICON_DATA_URI =
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none"><path d="M18 2.5L31 8.2V17.6C31 25.7 25.4 32.1 18 34C10.6 32.1 5 25.7 5 17.6V8.2L18 2.5Z" fill="#090D16" stroke="#10B981" stroke-width="2.5"/><path d="M14 18.5L17 21.5L22.5 15.5" stroke="#06B6D4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );

const SLACK_LOGO_SVG = `<svg width="20" height="20" viewBox="0 0 122.8 122.8" fill="none" aria-hidden="true"><path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 1 1-25.8 0V77.6z" fill="#E01E5A"/><path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2zm0 6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 1 1 0-25.8h32.3z" fill="#36C5F0"/><path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2zm-6.5 0a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 1 1 25.8 0v32.3z" fill="#2EB67D"/><path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 1 1 0 25.8H77.6z" fill="#ECB22E"/></svg>`;

export function layout(title: string, body: string, isLanding = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="Gatekeep by bsuit.app — Human-in-the-loop approval layer for AI agents (Cursor, Claude Code, LangGraph) and CI/CD pipelines inside Slack with RFC 8785 cryptographic hash binding.">
  <meta name="theme-color" content="#090d16">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="Stop AI agents from running irreversible actions blind. Approve, edit parameters, or reject risky MCP & SDK tool calls right in Slack.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://bsuit.app">
  <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
  <style>
    :root {
      color-scheme: dark;
      --bg: #090d16;
      --bg-elevated: #0f1624;
      --card: rgba(15, 22, 36, 0.78);
      --card-solid: #111827;
      --ink: #f8fafc;
      --muted: #94a3b8;
      --subtle: #64748b;
      --line: rgba(148, 163, 184, 0.14);
      --line-strong: rgba(16, 185, 129, 0.35);
      --emerald: #10b981;
      --emerald-hover: #059669;
      --cyan: #06b6d4;
      --amber: #f59e0b;
      --danger: #ef4444;
      --code-bg: #060911;
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      background-image:
        radial-gradient(circle at 18% 0%, rgba(16, 185, 129, 0.13), transparent 42%),
        radial-gradient(circle at 82% 8%, rgba(6, 182, 212, 0.12), transparent 40%),
        linear-gradient(rgba(148, 163, 184, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(148, 163, 184, 0.03) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 36px 36px, 36px 36px;
      color: var(--ink);
      font-family: var(--font-sans);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: ${isLanding ? "74rem" : "52rem"};
      margin: 0 auto;
      padding: 0 1.5rem;
    }
    header.site-header {
      position: sticky;
      top: 0;
      z-index: 50;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      background: rgba(9, 13, 22, 0.82);
      border-bottom: 1px solid var(--line);
    }
    .header-inner {
      max-width: 74rem;
      margin: 0 auto;
      padding: 0.95rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    a.brand {
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--ink);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.65rem;
      letter-spacing: -0.02em;
    }
    .brand-badge {
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--cyan);
      background: rgba(6, 182, 212, 0.12);
      border: 1px solid rgba(6, 182, 212, 0.28);
      padding: 0.12rem 0.45rem;
      border-radius: 999px;
      letter-spacing: 0.02em;
    }
    nav.main-nav {
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }
    nav.main-nav a {
      color: var(--muted);
      text-decoration: none;
      font-size: 0.92rem;
      font-weight: 500;
      transition: color 0.15s ease;
    }
    nav.main-nav a:hover { color: var(--ink); }
    .nav-cta {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      background: rgba(16, 185, 129, 0.14);
      color: #34d399 !important;
      border: 1px solid rgba(16, 185, 129, 0.35);
      padding: 0.42rem 0.9rem;
      border-radius: 8px;
      font-weight: 600 !important;
      font-size: 0.88rem !important;
      transition: all 0.15s ease;
    }
    .nav-cta:hover {
      background: rgba(16, 185, 129, 0.24);
      border-color: var(--emerald);
      color: #ffffff !important;
    }
    main {
      padding: 3rem 0 5rem;
    }
    h1 {
      font-size: clamp(2.25rem, 4.5vw, 3.6rem);
      line-height: 1.08;
      letter-spacing: -0.035em;
      margin: 0 0 1.25rem;
      font-weight: 800;
    }
    h2 {
      font-size: clamp(1.6rem, 2.8vw, 2.2rem);
      letter-spacing: -0.025em;
      margin: 2.5rem 0 0.85rem;
      font-weight: 750;
    }
    h3 {
      font-size: 1.15rem;
      letter-spacing: -0.01em;
      margin: 0 0 0.5rem;
      color: var(--ink);
    }
    p { margin: 0.75rem 0; color: var(--muted); }
    strong { color: var(--ink); }
    ul, ol { color: var(--muted); padding-left: 1.4rem; }
    li { margin: 0.5rem 0; }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      padding: 0.82rem 1.45rem;
      font-size: 0.98rem;
      font-weight: 600;
      border-radius: 10px;
      text-decoration: none !important;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: #04130d;
      box-shadow: 0 0 28px rgba(16, 185, 129, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.25);
      transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
      border: none;
      cursor: pointer;
    }
    .btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 0 36px rgba(16, 185, 129, 0.42);
      filter: brightness(1.06);
      color: #04130d;
    }
    .btn-secondary {
      background: rgba(15, 22, 36, 0.85);
      color: var(--ink);
      border: 1px solid var(--line);
      box-shadow: none;
    }
    .btn-secondary:hover {
      background: rgba(30, 41, 59, 0.8);
      border-color: rgba(148, 163, 184, 0.35);
      box-shadow: none;
      color: var(--ink);
    }
    .card {
      background: var(--card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 1.75rem;
      margin: 1.5rem 0;
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 1.1rem;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 0.84rem;
      line-height: 1.55;
      color: #e2e8f0;
      margin: 0.75rem 0;
    }
    code {
      font-family: var(--font-mono);
      font-size: 0.86em;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.15);
      padding: 0.14em 0.4em;
      border-radius: 5px;
      color: #38bdf8;
    }
    pre code {
      background: transparent;
      border: none;
      padding: 0;
      color: inherit;
    }
    /* Hero & Interactive Control Plane */
    .hero {
      text-align: center;
      max-width: 54rem;
      margin: 1rem auto 3rem;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.55rem;
      padding: 0.35rem 0.9rem;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.28);
      color: #34d399;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 1.4rem;
      letter-spacing: 0.01em;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 10px var(--emerald);
    }
    .gradient-text {
      background: linear-gradient(135deg, #ffffff 20%, #34d399 65%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero-sub {
      font-size: 1.16rem;
      color: var(--muted);
      max-width: 44rem;
      margin: 0 auto 2rem;
    }
    .hero-actions {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .hero-meta {
      margin-top: 1rem;
      font-size: 0.82rem;
      color: var(--subtle);
    }
    .workbench {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 1.5rem;
      margin: 2.5rem 0 4.5rem;
      align-items: stretch;
    }
    @media (max-width: 920px) {
      .workbench { grid-template-columns: 1fr; }
      nav.main-nav .hide-mobile { display: none; }
    }
    .pane {
      background: rgba(11, 15, 25, 0.92);
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    }
    .pane-header {
      background: rgba(15, 22, 36, 0.95);
      border-bottom: 1px solid var(--line);
      padding: 0.75rem 1.1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
    }
    .window-dots {
      display: flex;
      gap: 6px;
    }
    .window-dots span {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(148, 163, 184, 0.25);
    }
    .tab-group {
      display: flex;
      gap: 0.35rem;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.28rem 0.65rem;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab-btn.active {
      background: rgba(6, 182, 212, 0.14);
      color: #38bdf8;
      border-color: rgba(6, 182, 212, 0.3);
    }
    .pane-body {
      padding: 1.25rem;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .slack-card {
      background: #1a1d21;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-left: 4px solid var(--amber);
      border-radius: 10px;
      padding: 1.1rem;
      font-size: 0.9rem;
      transition: border-color 0.2s ease;
    }
    .slack-card.approved { border-left-color: var(--emerald); }
    .slack-card.rejected { border-left-color: var(--danger); }
    .slack-card.edited { border-left-color: var(--cyan); }
    .slack-app-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.65rem;
    }
    .slack-app-badge {
      font-size: 0.68rem;
      background: rgba(255, 255, 255, 0.12);
      color: #cbd5e1;
      padding: 0.08rem 0.38rem;
      border-radius: 4px;
      font-weight: 600;
    }
    .slack-meta-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.55rem;
      background: rgba(0, 0, 0, 0.28);
      border-radius: 8px;
      padding: 0.7rem;
      margin: 0.65rem 0;
      font-size: 0.8rem;
    }
    .slack-hash-pill {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      color: #94a3b8;
      background: rgba(0, 0, 0, 0.35);
      padding: 0.35rem 0.6rem;
      border-radius: 6px;
      margin: 0.5rem 0 0.85rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .slack-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .slack-btn {
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.42rem 0.8rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: #222529;
      color: #f8fafc;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .slack-btn:hover { background: #2c3036; }
    .slack-btn.approve {
      background: #007a5a;
      border-color: #007a5a;
      color: #ffffff;
    }
    .slack-btn.approve:hover { background: #148567; }
    .slack-btn.reject {
      background: #e01e5a;
      border-color: #e01e5a;
      color: #ffffff;
    }
    .slack-btn.reject:hover { background: #c9184f; }
    .section-header {
      text-align: center;
      max-width: 44rem;
      margin: 4.5rem auto 2.25rem;
    }
    .section-eyebrow {
      color: var(--emerald);
      font-family: var(--font-mono);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.35rem;
    }
    @media (max-width: 860px) {
      .grid-3 { grid-template-columns: 1fr; }
    }
    .feature-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 1.5rem;
      transition: border-color 0.2s ease, transform 0.2s ease;
    }
    .feature-card:hover {
      border-color: rgba(16, 185, 129, 0.35);
      transform: translateY(-2px);
    }
    .feature-icon {
      width: 38px;
      height: 38px;
      border-radius: 9px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.25);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #34d399;
      font-size: 1.1rem;
      margin-bottom: 0.9rem;
    }
    .pricing-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.85rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
    }
    .pricing-card.featured {
      background: linear-gradient(180deg, rgba(16, 185, 129, 0.1) 0%, rgba(15, 22, 36, 0.92) 100%);
      border-color: var(--emerald);
      box-shadow: 0 0 40px rgba(16, 185, 129, 0.14);
    }
    .popular-badge {
      position: absolute;
      top: -12px;
      right: 20px;
      background: var(--emerald);
      color: #04130d;
      font-size: 0.72rem;
      font-weight: 800;
      padding: 0.2rem 0.65rem;
      border-radius: 999px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .price-tag {
      font-size: 2.5rem;
      font-weight: 800;
      color: var(--ink);
      letter-spacing: -0.03em;
      margin: 0.5rem 0 0.25rem;
    }
    .price-tag span {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--muted);
    }
    .check-list {
      list-style: none;
      padding: 0;
      margin: 1.25rem 0 1.75rem;
    }
    .check-list li {
      display: flex;
      align-items: flex-start;
      gap: 0.55rem;
      font-size: 0.9rem;
      color: #cbd5e1;
      margin: 0.6rem 0;
    }
    .check-list li::before {
      content: "✓";
      color: var(--emerald);
      font-weight: 800;
    }
    footer.site-footer {
      border-top: 1px solid var(--line);
      background: rgba(6, 9, 17, 0.85);
      padding: 3rem 0 2.5rem;
      margin-top: 4rem;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .footer-grid {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 2rem;
    }
    .footer-links {
      display: flex;
      gap: 2.5rem;
      flex-wrap: wrap;
    }
    .footer-col h4 {
      color: var(--ink);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0 0 0.75rem;
    }
    .footer-col a {
      display: block;
      color: var(--muted);
      margin: 0.4rem 0;
      font-size: 0.88rem;
    }
    .footer-col a:hover { color: var(--ink); }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="brand">
        ${BRAND_LOGO_SVG}
        <span>Gatekeep</span>
        <span class="brand-badge">bsuit.app</span>
      </a>
      <nav class="main-nav">
        <a href="/#quickstart" class="hide-mobile">Agents Setup</a>
        <a href="/#how-it-works" class="hide-mobile">Security</a>
        <a href="/#pricing">Pricing</a>
        <a href="/docs" style="color:#34d399; font-weight:600;">Docs &amp; API</a>
        <a href="/support" class="hide-mobile">Support</a>
        <a href="/slack/install" class="nav-cta">Add to Slack &rarr;</a>
      </nav>
    </div>
  </header>
  <main class="container">
    ${body}
  </main>
  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid">
        <div style="max-width: 22rem;">
          <a href="/" class="brand" style="margin-bottom: 0.6rem;">
            ${BRAND_LOGO_SVG}
            <span>Gatekeep</span>
          </a>
          <p style="font-size: 0.85rem; margin: 0.4rem 0;">
            Cryptographic human-in-the-loop control plane for AI agents and CI/CD pipelines inside Slack.
          </p>
          <p style="font-size: 0.78rem; color: var(--subtle); margin-top: 1rem;">
            &copy; ${new Date().getFullYear()} Benedet Labs &bull; Built on RFC 8785 (JCS) &amp; Model Context Protocol.
          </p>
        </div>
        <div class="footer-links">
          <div class="footer-col">
            <h4>Gatekeep</h4>
            <a href="/docs">Documentation &amp; API</a>
            <a href="/#quickstart">Multi-Agent Setup</a>
            <a href="/#pricing">Pricing</a>
            <a href="/slack/install">Install to Slack</a>
          </div>
          <div class="footer-col">
            <h4>Agent Guides</h4>
            <a href="/docs#claude-code">Claude Code &amp; Desktop</a>
            <a href="/docs#openai-codex">OpenAI Codex &amp; GPT</a>
            <a href="/docs#hermes-agent">Hermes Agent</a>
            <a href="/docs#openclaw">OpenClaw</a>
          </div>
          <div class="footer-col">
            <h4>bsuit Ecosystem</h4>
            <a href="https://secret.bsuit.app">bsuit Secret (Burn-After-Read)</a>
            <a href="https://queue.bsuit.app">bsuit Queue (Deploy Locks)</a>
          </div>
          <div class="footer-col">
            <h4>Legal &amp; Trust</h4>
            <a href="/privacy">Privacy Policy</a>
            <a href="/support">Support Center</a>
            <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>
          </div>
        </div>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

export function landingPage(): string {
  return layout(
    "Gatekeep by bsuit.app — Human Approval Layer for AI Agents in Slack",
    `
    <!-- HERO -->
    <section class="hero">
      <div class="status-pill">
        <span class="status-dot"></span>
        <span>RFC 8785 JCS Hash-Bound &bull; Remote Streamable HTTP MCP Ready</span>
      </div>
      <h1>
        Human approval for AI agents — <span class="gradient-text">right in Slack.</span>
      </h1>
      <p class="hero-sub">
        Stop autonomous agents from running irreversible actions blind. Gatekeep intercepts risky tool calls from <strong>Claude Code</strong>, <strong>OpenAI Codex &amp; ChatGPT</strong>, <strong>Cursor</strong>, <strong>Hermes Agent</strong>, and <strong>OpenClaw</strong>, binds their exact JSON parameters to a SHA-256 hash, and requires a 1-click Slack approval before execution.
      </p>
      <div class="hero-actions">
        <a href="/slack/install" class="btn">
          ${SLACK_LOGO_SVG}
          <span>Add to Slack — Free</span>
        </a>
        <a href="#quickstart" class="btn btn-secondary">
          <span>Connect Your Agent &rarr;</span>
        </a>
        <a href="/docs" class="btn btn-secondary" style="border-color:rgba(16, 185, 129, 0.35); color:#34d399;">
          <span>📖 Full Docs &amp; API Reference</span>
        </a>
      </div>

      <!-- SUPPORTED AGENTS ECOSYSTEM STRIP -->
      <div style="display:flex; justify-content:center; align-items:center; flex-wrap:wrap; gap:0.55rem; margin-top:1.5rem;">
        <span style="font-size:0.76rem; color:var(--subtle); font-family:var(--font-mono); text-transform:uppercase; letter-spacing:0.06em; margin-right:0.25rem;">Works out-of-the-box with:</span>
        <a href="#quickstart" onclick="selectSetupFromHero('claude')" style="background:rgba(15,22,36,0.85); border:1px solid var(--line); border-radius:999px; padding:0.26rem 0.75rem; font-size:0.78rem; color:#f8fafc; text-decoration:none;">🟠 <strong>Claude Code &amp; Desktop</strong></a>
        <a href="#quickstart" onclick="selectSetupFromHero('codex')" style="background:rgba(15,22,36,0.85); border:1px solid var(--line); border-radius:999px; padding:0.26rem 0.75rem; font-size:0.78rem; color:#f8fafc; text-decoration:none;">🟢 <strong>OpenAI Codex &amp; GPT</strong></a>
        <a href="#quickstart" onclick="selectSetupFromHero('cursor')" style="background:rgba(15,22,36,0.85); border:1px solid var(--line); border-radius:999px; padding:0.26rem 0.75rem; font-size:0.78rem; color:#f8fafc; text-decoration:none;">🔵 <strong>Cursor &amp; Windsurf</strong></a>
        <a href="#quickstart" onclick="selectSetupFromHero('hermes')" style="background:rgba(15,22,36,0.85); border:1px solid var(--line); border-radius:999px; padding:0.26rem 0.75rem; font-size:0.78rem; color:#f8fafc; text-decoration:none;">🟣 <strong>Hermes Agent</strong></a>
        <a href="#quickstart" onclick="selectSetupFromHero('openclaw')" style="background:rgba(15,22,36,0.85); border:1px solid var(--line); border-radius:999px; padding:0.26rem 0.75rem; font-size:0.78rem; color:#f8fafc; text-decoration:none;">🦞 <strong>OpenClaw</strong></a>
      </div>

      <div class="hero-meta">
        Free Sandbox includes 100 governed requests/mo &bull; No SQL or credit card required &bull; Sub-200ms Slack SLA
      </div>
    </section>

    <!-- INTERACTIVE CONTROL PLANE WORKBENCH -->
    <section class="workbench" aria-label="Interactive Gatekeep Control Plane Demo">
      <!-- LEFT: AGENT / MCP TERMINAL -->
      <div class="pane">
        <div class="pane-header">
          <div style="display:flex; align-items:center; gap:0.75rem;">
            <div class="window-dots"><span></span><span></span><span></span></div>
            <span style="font-family:var(--font-mono); font-size:0.78rem; color:var(--muted);">agent-runtime</span>
          </div>
          <div class="tab-group" role="tablist">
            <button type="button" class="tab-btn active" onclick="switchTab('mcp', this)">MCP (Claude/Codex/Cursor)</button>
            <button type="button" class="tab-btn" onclick="switchTab('sdk', this)">TypeScript SDK</button>
            <button type="button" class="tab-btn" onclick="switchTab('curl', this)">REST API</button>
          </div>
        </div>
        <div class="pane-body">
          <div id="code-mcp">
            <pre style="margin:0;"><code><span style="color:#64748b;">// 1. Agent calls Gatekeep MCP tool before risky action</span>
{
  <span style="color:#38bdf8;">"method"</span>: <span style="color:#34d399;">"tools/call"</span>,
  <span style="color:#38bdf8;">"params"</span>: {
    <span style="color:#38bdf8;">"name"</span>: <span style="color:#34d399;">"request_approval"</span>,
    <span style="color:#38bdf8;">"arguments"</span>: {
      <span style="color:#38bdf8;">"action"</span>: <span style="color:#f59e0b;">"deploy.k8s.rollout"</span>,
      <span style="color:#38bdf8;">"target"</span>: <span style="color:#34d399;">"civo:prod-k3s/slack-suite"</span>,
      <span style="color:#38bdf8;">"risk"</span>: <span style="color:#ef4444;">"high"</span>,
      <span style="color:#38bdf8;">"params"</span>: {
        <span style="color:#38bdf8;">"service"</span>: <span style="color:#34d399;">"gatekeep-app"</span>,
        <span style="color:#38bdf8;">"replicas"</span>: <span id="code-replicas" style="color:#f59e0b;">3</span>,
        <span style="color:#38bdf8;">"environment"</span>: <span style="color:#34d399;">"production"</span>
      },
      <span style="color:#38bdf8;">"justification"</span>: <span style="color:#34d399;">"Rollout production release"</span>
    }
  }
}</code></pre>
          </div>
          <div id="code-sdk" style="display:none;">
            <pre style="margin:0;"><code><span style="color:#64748b;">import</span> { GatekeepClient } <span style="color:#64748b;">from</span> <span style="color:#34d399;">"@suite/gatekeep-sdk"</span>;

<span style="color:#64748b;">const</span> gk = <span style="color:#64748b;">new</span> GatekeepClient({
  apiKey: Deno.env.get(<span style="color:#34d399;">"GATEKEEP_API_KEY"</span>)!,
});

<span style="color:#64748b;">// Blocks until human approves in Slack, verifies JCS hash &amp; sends receipt</span>
<span style="color:#64748b;">await</span> gk.guard(
  {
    action: <span style="color:#f59e0b;">"deploy.k8s.rollout"</span>,
    target: <span style="color:#34d399;">"civo:prod-k3s/slack-suite"</span>,
    params: { service: <span style="color:#34d399;">"gatekeep-app"</span>, replicas: <span style="color:#f59e0b;">3</span> },
    justification: <span style="color:#34d399;">"Rollout production release"</span>,
  },
  <span style="color:#64748b;">async</span> (approvedParams) =&gt; {
    <span style="color:#64748b;">return await</span> rolloutK8s(approvedParams);
  }
);</code></pre>
          </div>
          <div id="code-curl" style="display:none;">
            <pre style="margin:0;"><code>curl -X POST https://gatekeep.bsuit.app/v1/requests \\
  -H <span style="color:#34d399;">"Authorization: Bearer gk_live_48437c_..."</span> \\
  -H <span style="color:#34d399;">"Idempotency-Key: deploy-prod-001"</span> \\
  -d <span style="color:#34d399;">'{
    "action": "deploy.k8s.rollout",
    "target": "civo:prod-k3s/slack-suite",
    "params": {"service":"gatekeep-app","replicas":3},
    "justification": "Rollout production release"
  }'</span></code></pre>
          </div>

          <div id="terminal-status" style="margin-top:1rem; padding:0.75rem 0.9rem; border-radius:8px; background:rgba(245, 158, 11, 0.1); border:1px solid rgba(245, 158, 11, 0.3); font-family:var(--font-mono); font-size:0.78rem; color:#fcd34d;">
            ⏳ <strong>STATUS: PENDING HUMAN REVIEW</strong><br>
            <span style="color:#94a3b8;">Long-polling <code>GET /v1/requests/gk_req_04550bcd?wait=25</code> — Click a button in the Slack card &rarr;</span>
          </div>
        </div>
      </div>

      <!-- RIGHT: INTERACTIVE SLACK CARD SIMULATOR -->
      <div class="pane">
        <div class="pane-header">
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <span style="color:#94a3b8; font-weight:700; font-size:0.86rem;"># prod-approvals</span>
            <span style="font-size:0.72rem; color:var(--subtle);">Slack Channel &bull; Interactive Demo</span>
          </div>
          <button type="button" class="tab-btn" onclick="resetDemo()" title="Reset interactive Slack card">↺ Reset</button>
        </div>
        <div class="pane-body">
          <div id="demo-slack-card" class="slack-card">
            <div class="slack-app-row">
              ${BRAND_LOGO_SVG}
              <div>
                <div style="display:flex; align-items:center; gap:0.4rem;">
                  <strong style="font-size:0.92rem;">Gatekeep</strong>
                  <span class="slack-app-badge">APP</span>
                  <span style="font-size:0.72rem; color:var(--subtle);">Just now</span>
                </div>
                <div style="font-size:0.76rem; color:var(--muted);">Requested by <code>claude-code</code> on behalf of <strong>@leonardo</strong></div>
              </div>
            </div>

            <div style="font-weight:700; font-size:0.98rem; color:#ffffff; margin:0.5rem 0 0.25rem;">
              🛡️ Action Approval: <code>deploy.k8s.rollout</code>
            </div>
            <p style="margin:0.2rem 0 0.6rem; font-size:0.83rem; color:#cbd5e1;">
              "Rollout production release"
            </p>

            <div class="slack-meta-grid">
              <div>
                <div style="color:var(--subtle); font-size:0.7rem; text-transform:uppercase;">Target</div>
                <div style="color:#f8fafc; font-family:var(--font-mono); font-size:0.78rem;">civo:prod-k3s/slack-suite</div>
              </div>
              <div>
                <div style="color:var(--subtle); font-size:0.7rem; text-transform:uppercase;">Risk / Gate</div>
                <div><span style="color:#f87171; font-weight:700;">HIGH</span> &bull; <span id="demo-rev-badge" style="color:#38bdf8;">Rev #1</span></div>
              </div>
            </div>

            <pre id="demo-params-box" style="margin:0.4rem 0; padding:0.65rem; font-size:0.77rem; background:#0d1117;">{
  "environment": "production",
  "replicas": 3,
  "service": "gatekeep-app"
}</pre>

            <div class="slack-hash-pill">
              <span>🔒 JCS SHA-256 (<a href="#security" style="color:#38bdf8;">RFC 8785</a>)</span>
              <span id="demo-hash-val" style="color:#34d399;">kzgOWh_-FfHbf6EG...</span>
            </div>

            <div id="demo-actions" class="slack-actions">
              <button type="button" class="slack-btn approve" onclick="triggerDemo('approve')">✓ Approve</button>
              <button type="button" class="slack-btn" onclick="triggerDemo('edit')">✎ Edit Params</button>
              <button type="button" class="slack-btn" onclick="triggerDemo('ask')">? Ask Info</button>
              <button type="button" class="slack-btn reject" onclick="triggerDemo('reject')">✕ Reject</button>
            </div>
            <div id="demo-decision-banner" style="display:none; margin-top:0.65rem; padding:0.55rem 0.75rem; border-radius:6px; font-size:0.82rem; font-weight:600;"></div>
          </div>

          <div style="font-size:0.76rem; color:var(--subtle); text-align:center; margin-top:0.85rem;">
            👆 Click any button above to test how Gatekeep transitions state &amp; issues single-use tokens.
          </div>
        </div>
      </div>
    </section>

    <!-- 60-SECOND MULTI-AGENT QUICKSTART HUB -->
    <section id="quickstart">
      <div class="section-header">
        <div class="section-eyebrow">Universal Agent Onboarding</div>
        <h2>Connect Claude Code, OpenAI Codex, Cursor, Hermes or OpenClaw in 60s</h2>
        <p>Generate your scoped <code>gk_live_...</code> key directly inside Slack with <code>/gatekeep new-key</code>—zero SQL queries required—and plug it into any agent runtime.</p>
      </div>

      <div class="grid-3">
        <div class="feature-card">
          <div class="feature-icon">1</div>
          <h3>Install to Slack</h3>
          <p style="font-size:0.9rem;">Click <a href="/slack/install">Add to Slack</a> to authorize Gatekeep in your workspace in one click via OAuth 2.0.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">2</div>
          <h3>Run <code>/gatekeep new-key</code></h3>
          <p style="font-size:0.9rem;">In any Slack channel, run <code>/gatekeep new-key claude</code> (or <code>codex</code>, <code>hermes</code>, <code>openclaw</code>). Gatekeep replies privately with your key.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">3</div>
          <h3>Pick Your Agent Below</h3>
          <p style="font-size:0.9rem;">Copy the configuration for your agent runtime below or explore the <a href="/docs">Full Documentation &amp; API Reference</a>.</p>
        </div>
      </div>

      <!-- MULTI-AGENT INTERACTIVE SETUP SWITCHER -->
      <div class="pane" style="margin-top:1.75rem;">
        <div class="pane-header" style="flex-wrap:wrap; gap:0.6rem;">
          <div class="tab-group" role="tablist" style="flex-wrap:wrap;" id="setup-tabs">
            <button type="button" class="tab-btn active" id="tab-setup-claude" onclick="switchAgentSetup('claude', this)">🟠 Claude Code</button>
            <button type="button" class="tab-btn" id="tab-setup-codex" onclick="switchAgentSetup('codex', this)">🟢 OpenAI Codex / GPT</button>
            <button type="button" class="tab-btn" id="tab-setup-cursor" onclick="switchAgentSetup('cursor', this)">🔵 Cursor / Windsurf</button>
            <button type="button" class="tab-btn" id="tab-setup-hermes" onclick="switchAgentSetup('hermes', this)">🟣 Hermes Agent</button>
            <button type="button" class="tab-btn" id="tab-setup-openclaw" onclick="switchAgentSetup('openclaw', this)">🦞 OpenClaw</button>
            <button type="button" class="tab-btn" id="tab-setup-python" onclick="switchAgentSetup('python', this)">🐍 Python / REST</button>
          </div>
          <div style="display:flex; align-items:center; gap:0.65rem;">
            <span style="font-family:var(--font-mono); font-size:0.74rem; color:var(--emerald);">https://gatekeep.bsuit.app/mcp</span>
            <button type="button" class="tab-btn" id="copy-setup-btn" onclick="copyActiveSetup()" style="border-color:var(--line); color:#e2e8f0;">Copy Snippet</button>
          </div>
        </div>

        <div class="pane-body">
          <!-- CLAUDE CODE -->
          <div id="setup-claude" class="setup-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🟠 Claude Code CLI &amp; <code>.mcp.json</code> (Anthropic Native HTTP MCP)</strong>
              <a href="/docs#claude-code" style="font-size:0.8rem;">Full Claude Guide &rarr;</a>
            </div>
            <pre style="margin:0;"><code># Option 1: One-liner in Claude Code CLI
claude mcp add --transport http gatekeep https://gatekeep.bsuit.app/mcp \\
  --header "Authorization: Bearer gk_live_your_key_id_secret"

# Option 2: Project .mcp.json (or claude_desktop_config.json)
{
  "mcpServers": {
    "gatekeep": {
      "type": "http",
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_your_key_id_secret"
      }
    }
  }
}</code></pre>
          </div>

          <!-- OPENAI CODEX & GPT -->
          <div id="setup-codex" class="setup-panel" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🟢 OpenAI Codex CLI (<code>~/.codex/config.toml</code>) &amp; OpenAI Responses API (GPT-4.1 / o3 / GPT-5)</strong>
              <a href="/docs#openai-codex" style="font-size:0.8rem;">Full OpenAI / Codex Guide &rarr;</a>
            </div>
            <pre style="margin:0;"><code># 1. OpenAI Codex CLI (~/.codex/config.toml)
[mcp_servers.gatekeep]
url = "https://gatekeep.bsuit.app/mcp"
http_headers = { Authorization = "Bearer gk_live_your_key_id_secret" }

# 2. OpenAI Responses API (Native Remote MCP Connector)
const response = await openai.responses.create({
  model: "gpt-4.1",
  tools: [{
    type: "mcp",
    server_label: "gatekeep",
    server_url: "https://gatekeep.bsuit.app/mcp",
    headers: { Authorization: "Bearer gk_live_your_key_id_secret" },
    require_approval: "never" // Gatekeep enforces approval in Slack
  }],
  input: "Request Slack approval via Gatekeep before deploying prod-api"
});</code></pre>
          </div>

          <!-- CURSOR & WINDSURF -->
          <div id="setup-cursor" class="setup-panel" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🔵 Cursor (<code>.cursor/mcp.json</code>) &amp; Windsurf IDE</strong>
              <a href="/docs#cursor-windsurf" style="font-size:0.8rem;">Full Cursor &amp; Windsurf Guide &rarr;</a>
            </div>
            <pre style="margin:0;"><code>{
  "mcpServers": {
    "gatekeep": {
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_your_key_id_secret"
      }
    }
  }
}</code></pre>
          </div>

          <!-- HERMES AGENT -->
          <div id="setup-hermes" class="setup-panel" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🟣 Hermes Agent by Nous Research (<code>~/.hermes/config.yaml</code>)</strong>
              <a href="/docs#hermes-agent" style="font-size:0.8rem;">Full Hermes Agent Guide &rarr;</a>
            </div>
            <pre style="margin:0;"><code># ~/.hermes/config.yaml
mcp_servers:
  gatekeep:
    transport: http
    url: "https://gatekeep.bsuit.app/mcp"
    headers:
      Authorization: "Bearer gk_live_your_key_id_secret"
    timeout: 60</code></pre>
          </div>

          <!-- OPENCLAW -->
          <div id="setup-openclaw" class="setup-panel" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🦞 OpenClaw Autonomous Agent (<code>~/.openclaw/openclaw.json</code>)</strong>
              <a href="/docs#openclaw" style="font-size:0.8rem;">Full OpenClaw Guide &rarr;</a>
            </div>
            <pre style="margin:0;"><code>// ~/.openclaw/openclaw.json
{
  "mcpServers": {
    "gatekeep": {
      "type": "streamable-http",
      "url": "https://gatekeep.bsuit.app/mcp",
      "headers": {
        "Authorization": "Bearer gk_live_your_key_id_secret"
      }
    }
  }
}</code></pre>
          </div>

          <!-- PYTHON / REST -->
          <div id="setup-python" class="setup-panel" style="display:none;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
              <strong style="font-size:0.9rem; color:#f8fafc;">🐍 Python, LangGraph, CrewAI &amp; Any HTTP Runtime</strong>
              <a href="/docs#rest-api" style="font-size:0.8rem;">Full REST API Reference &rarr;</a>
            </div>
            <pre style="margin:0;"><code>import httpx

res = httpx.post(
    "https://gatekeep.bsuit.app/v1/requests",
    headers={"Authorization": "Bearer gk_live_your_key_id_secret"},
    json={
        "action": "db.migration.apply",
        "target": "postgres:prod",
        "params": {"migration": "004_users.sql"},
        "justification": "Apply production schema update",
    },
).json()

# Poll with server-side long-polling (?wait=25) until approved in Slack
decision = httpx.get(f"{res['poll_url']}?wait=25", headers={"Authorization": "Bearer gk_live_..."}).json()</code></pre>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-top:1.1rem; padding-top:0.9rem; border-top:1px solid var(--line);">
            <span style="font-size:0.82rem; color:var(--muted);">Need OpenAPI 3.1 schemas for ChatGPT Actions, webhook verification, or JCS hash details?</span>
            <a href="/docs" class="btn btn-secondary" style="padding:0.45rem 1rem; font-size:0.84rem;">Explore Product &amp; API Documentation (/docs) &rarr;</a>
          </div>
        </div>
      </div>
    </section>

    <!-- ARCHITECTURE & SECURITY -->
    <section id="how-it-works">
      <div id="security" class="section-header">
        <div class="section-eyebrow">Cryptographic Integrity</div>
        <h2>Why engineering teams trust Gatekeep</h2>
        <p>Built from the ground up so hallucinating LLMs or compromised prompts cannot bypass human oversight.</p>
      </div>

      <div class="grid-3">
        <div class="feature-card">
          <div class="feature-icon">🔒</div>
          <h3>RFC 8785 Hash Binding</h3>
          <p style="font-size:0.9rem;">Approval tokens are cryptographically bound to the canonical JSON (JCS) SHA-256 digest of <code>{action, target, params, revision}</code>. Changing a single byte invalidates the token.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🎟️</div>
          <h3>Single-Use CAS Tokens</h3>
          <p style="font-size:0.9rem;">Execution tokens (<code>gkt_...</code>) have a 5-minute TTL and are consumed atomically in PostgreSQL 18 via Compare-And-Swap. Replay attacks are impossible.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">✏️</div>
          <h3>In-Slack Parameter Editing</h3>
          <p style="font-size:0.9rem;">Need to change <code>replicas: 10</code> to <code>2</code>? Edit the JSON directly inside the Slack modal. Gatekeep creates Revision #2, re-hashes, and hands the safe params to the agent.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🛡️</div>
          <h3>Strict Default-Deny</h3>
          <p style="font-size:0.9rem;">Timeouts, unconfigured rules, or network drops always resolve to rejection. Even if your workspace hits a plan quota, Gatekeep routes to human review—never auto-allow.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🧾</div>
          <h3>Closed-Loop Receipts</h3>
          <p style="font-size:0.9rem;">Agents report execution outcomes (<code>succeeded</code> / <code>failed</code> + duration) back to Gatekeep, updating the Slack card in place for full operational visibility.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">⚡</div>
          <h3>Transactional Outbox</h3>
          <p style="font-size:0.9rem;">Powered by an asynchronous Outbox Worker with exponential backoff, guaranteeing Slack card delivery and automatic TTL expiration without blocking agent calls.</p>
        </div>
      </div>
    </section>

    <!-- PRICING -->
    <section id="pricing">
      <div class="section-header">
        <div class="section-eyebrow">Fair-Play Workspace Pricing</div>
        <h2>Flat pricing per Slack workspace. Zero per-agent tax.</h2>
        <p>Create as many specialized agents as you need. You only scale by governed actions per month.</p>
      </div>

      <div class="grid-3">
        <!-- FREE -->
        <div class="pricing-card">
          <div>
            <h3>Free Sandbox</h3>
            <p style="font-size:0.86rem; margin-top:0.2rem;">For indie builders &amp; testing MCP workflows in Slack.</p>
            <div class="price-tag">\$0 <span>/ month</span></div>
            <ul class="check-list">
              <li><strong>100 governed requests</strong> / month</li>
              <li><strong>2 Agent API Keys</strong> (<code>gk_live_...</code>)</li>
              <li>Up to <strong>5 human approvers</strong></li>
              <li>Remote MCP + TS SDK + REST API</li>
              <li>Approve, Reject, Edit Params &amp; Ask Info</li>
              <li>RFC 8785 JCS Hash Binding &amp; Receipts</li>
              <li>7-day audit log retention</li>
            </ul>
          </div>
          <a href="/slack/install" class="btn btn-secondary" style="width:100%;">Add to Slack — Free</a>
        </div>

        <!-- PRO -->
        <div class="pricing-card featured">
          <div class="popular-badge">Most Popular</div>
          <div>
            <h3>Pro</h3>
            <p style="font-size:0.86rem; margin-top:0.2rem;">For engineering &amp; AI teams running production agents.</p>
            <div class="price-tag">\$29 <span>/ workspace / mo</span></div>
            <ul class="check-list">
              <li><strong>2,000 governed requests</strong> / month</li>
              <li><strong>10 Agent API Keys</strong></li>
              <li>Up to <strong>30 human approvers</strong></li>
              <li><strong>Custom Policy Engine</strong> (glob rules, auto-approve low risk, custom channels)</li>
              <li>Quorum approvals &amp; HMAC Webhooks</li>
              <li>90-day tamper-evident audit retention</li>
              <li>Priority email support</li>
            </ul>
          </div>
          <a href="/slack/install?plan=pro" class="btn" style="width:100%;">Start Pro in Slack &rarr;</a>
        </div>

        <!-- SUITE CONTROL PLANE -->
        <div class="pricing-card">
          <div>
            <h3>Suite Control Plane</h3>
            <p style="font-size:0.86rem; margin-top:0.2rem;">Complete Slack governance + Secret &amp; Queue bundle.</p>
            <div class="price-tag">\$79 <span>/ workspace / mo</span></div>
            <ul class="check-list">
              <li><strong>20,000 governed requests</strong> / month</li>
              <li><strong>Unlimited</strong> Agent API Keys &amp; Approvers</li>
              <li>Multi-stage approvals &amp; time windows</li>
              <li>Includes <strong>bsuit Secret</strong> (burn-after-read split-key credentials)</li>
              <li>Includes <strong>bsuit Queue</strong> (FIFO &amp; semaphore deploy locks)</li>
              <li>1-year audit retention + CSV/JSON export</li>
              <li>Dedicated onboarding &amp; SLA support</li>
            </ul>
          </div>
          <a href="/slack/install?plan=suite" class="btn btn-secondary" style="width:100%;">Deploy Full Suite &rarr;</a>
        </div>
      </div>
    </section>

    <script>
      function switchTab(tab, btn) {
        document.getElementById('code-mcp').style.display = tab === 'mcp' ? 'block' : 'none';
        document.getElementById('code-sdk').style.display = tab === 'sdk' ? 'block' : 'none';
        document.getElementById('code-curl').style.display = tab === 'curl' ? 'block' : 'none';
        var buttons = btn.parentElement.querySelectorAll('.tab-btn');
        for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active');
        btn.classList.add('active');
      }

      var currentSetupAgent = 'claude';
      function switchAgentSetup(agent, btn) {
        currentSetupAgent = agent;
        var agents = ['claude', 'codex', 'cursor', 'hermes', 'openclaw', 'python'];
        for (var i = 0; i < agents.length; i++) {
          var el = document.getElementById('setup-' + agents[i]);
          if (el) el.style.display = agents[i] === agent ? 'block' : 'none';
        }
        var tabs = document.getElementById('setup-tabs').querySelectorAll('.tab-btn');
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
        if (btn) btn.classList.add('active');
      }

      function selectSetupFromHero(agent) {
        var btn = document.getElementById('tab-setup-' + agent);
        switchAgentSetup(agent, btn);
      }

      function copyActiveSetup() {
        var panel = document.getElementById('setup-' + currentSetupAgent);
        if (!panel) return;
        var pre = panel.querySelector('pre');
        if (!pre) return;
        var btn = document.getElementById('copy-setup-btn');
        navigator.clipboard.writeText(pre.innerText || pre.textContent).then(function() {
          btn.textContent = 'Copied ✓';
          btn.style.color = '#34d399';
          setTimeout(function() {
            btn.textContent = 'Copy Snippet';
            btn.style.color = '#e2e8f0';
          }, 1800);
        });
      }

      function triggerDemo(action) {
        var card = document.getElementById('demo-slack-card');
        var banner = document.getElementById('demo-decision-banner');
        var term = document.getElementById('terminal-status');
        var paramsBox = document.getElementById('demo-params-box');
        var hashVal = document.getElementById('demo-hash-val');
        var revBadge = document.getElementById('demo-rev-badge');
        card.className = 'slack-card ' + (action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'edited');
        banner.style.display = 'block';

        if (action === 'approve') {
          banner.style.background = 'rgba(16, 185, 129, 0.16)';
          banner.style.color = '#34d399';
          banner.innerHTML = '✅ Approved by @you &bull; Single-use token <code>gkt_9f8a21c4...</code> issued &bull; Executed in 420ms';
          term.style.background = 'rgba(16, 185, 129, 0.12)';
          term.style.borderColor = 'rgba(16, 185, 129, 0.35)';
          term.style.color = '#34d399';
          term.innerHTML = '✅ <strong>STATUS: EXECUTED (Revision #1)</strong><br><span style="color:#94a3b8;">Token <code>gkt_9f8a21c4</code> verified against JCS hash <code>kzgOWh_-FfHbf6EG...</code> &bull; Receipt logged.</span>';
        } else if (action === 'edit') {
          paramsBox.textContent = '{\\n  "environment": "production",\\n  "replicas": 2,\\n  "service": "gatekeep-app"\\n}';
          hashVal.textContent = '7bE9xLm_2pQ8vR1k...';
          revBadge.textContent = 'Rev #2 (Edited)';
          banner.style.background = 'rgba(6, 182, 212, 0.16)';
          banner.style.color = '#38bdf8';
          banner.innerHTML = '✏️ Edited &amp; Approved by @you (replicas: 3 &rarr; 2) &bull; New JCS Hash bound to Revision #2';
          term.style.background = 'rgba(6, 182, 212, 0.12)';
          term.style.borderColor = 'rgba(6, 182, 212, 0.35)';
          term.style.color = '#38bdf8';
          term.innerHTML = '✏️ <strong>STATUS: EDITED &amp; APPROVED (Revision #2)</strong><br><span style="color:#94a3b8;">Agent received revised params <code>{"replicas": 2}</code> with updated JCS hash <code>7bE9xLm_...</code></span>';
        } else if (action === 'ask') {
          banner.style.background = 'rgba(245, 158, 11, 0.16)';
          banner.style.color = '#fcd34d';
          banner.innerHTML = '❓ Question sent to agent: "Did staging smoke tests pass?" &bull; Status: needs_info';
          term.style.background = 'rgba(245, 158, 11, 0.12)';
          term.style.borderColor = 'rgba(245, 158, 11, 0.35)';
          term.style.color = '#fcd34d';
          term.innerHTML = '❓ <strong>STATUS: NEEDS_INFO</strong><br><span style="color:#94a3b8;">Agent prompted to call <code>provide_context</code> with answer to reviewer question.</span>';
        } else if (action === 'reject') {
          banner.style.background = 'rgba(239, 68, 68, 0.16)';
          banner.style.color = '#f87171';
          banner.innerHTML = '🛑 Rejected by @you &bull; No execution token issued (Default-Deny)';
          term.style.background = 'rgba(239, 68, 68, 0.12)';
          term.style.borderColor = 'rgba(239, 68, 68, 0.35)';
          term.style.color = '#f87171';
          term.innerHTML = '🛑 <strong>STATUS: REJECTED</strong><br><span style="color:#94a3b8;">Gatekeep denied execution token. Agent aborted action safely.</span>';
        }
      }

      function resetDemo() {
        var card = document.getElementById('demo-slack-card');
        var banner = document.getElementById('demo-decision-banner');
        var term = document.getElementById('terminal-status');
        var paramsBox = document.getElementById('demo-params-box');
        var hashVal = document.getElementById('demo-hash-val');
        var revBadge = document.getElementById('demo-rev-badge');
        card.className = 'slack-card';
        banner.style.display = 'none';
        paramsBox.textContent = '{\\n  "environment": "production",\\n  "replicas": 3,\\n  "service": "gatekeep-app"\\n}';
        hashVal.textContent = 'kzgOWh_-FfHbf6EG...';
        revBadge.textContent = 'Rev #1';
        term.style.background = 'rgba(245, 158, 11, 0.1)';
        term.style.borderColor = 'rgba(245, 158, 11, 0.3)';
        term.style.color = '#fcd34d';
        term.innerHTML = '⏳ <strong>STATUS: PENDING HUMAN REVIEW</strong><br><span style="color:#94a3b8;">Long-polling <code>GET /v1/requests/gk_req_04550bcd?wait=25</code> — Click a button in the Slack card &rarr;</span>';
      }
    </script>
    `,
    true,
  );
}

export function privacyPage(): string {
  return layout(
    "Gatekeep Privacy Policy — bsuit.app",
    `<h1>Privacy Policy</h1>
    <p>Last updated: October 2026. Gatekeep is an enterprise control plane by Benedet Labs (<a href="https://bsuit.app">bsuit.app</a>) that provides human-in-the-loop approval workflows for AI agents and CI/CD inside Slack.</p>

    <h2>1. Data We Collect</h2>
    <ul>
      <li><strong>Slack Installation Metadata:</strong> Workspace ID, workspace name, enterprise ID (if applicable), and installer user ID.</li>
      <li><strong>Slack Bot Tokens:</strong> Bot tokens required to post Block Kit cards and update interactive views. Tokens are encrypted at rest with AES-256-GCM using hardware-derived master keys.</li>
      <li><strong>Approval Request Payloads:</strong> Action names, target identifiers, parameters JSON (encrypted at rest with AES-256-GCM), justification notes, and execution receipts submitted by your agents.</li>
      <li><strong>Decisions &amp; Audit Logs:</strong> User ID of the decision maker, timestamp, decision outcome, review comments, and RFC 8785 canonical SHA-256 hash digests.</li>
    </ul>

    <h2>2. How We Use Data</h2>
    <ul>
      <li>To present interactive approval cards and modals in your designated Slack channels.</li>
      <li>To verify cryptographic parameter integrity via RFC 8785 JSON Canonicalization Scheme (JCS).</li>
      <li>To maintain tamper-evident audit records of human oversight for compliance purposes.</li>
      <li>We <strong>never sell</strong> customer data, and we <strong>never use</strong> customer approval payloads, parameters, or actions to train machine learning models.</li>
    </ul>

    <h2>3. Data Retention &amp; Deletion</h2>
    <ul>
      <li><strong>Uninstalling the app:</strong> When the Gatekeep Slack app is uninstalled or tokens are revoked, the encrypted bot credentials and active ephemeral records for that workspace are purged immediately.</li>
      <li><strong>Audit Logs:</strong> Historical decision records and execution receipts are retained according to your workspace plan (7 days on Free, 90 days on Pro, 1 year on Suite) and can be completely removed upon request.</li>
      <li><strong>Right to Deletion:</strong> To request complete deletion of workspace records or an export of audit logs, email <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>. Requests are honored within two business days.</li>
    </ul>

    <h2>4. Security</h2>
    <p>All HTTP communications require TLS 1.3. Slack requests are validated using HMAC-SHA256 request signature verification with timing-safe comparison. Sensitive tokens and request parameters are encrypted using AES-256-GCM fail-fast cryptography.</p>

    <h2>5. Contact Us</h2>
    <p>If you have questions about this privacy policy, please contact us at <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>.</p>`,
  );
}

export function supportPage(): string {
  return layout(
    "Gatekeep Support — bsuit.app",
    `<h1>Support &amp; Help Center</h1>
    <p>Need assistance configuring Gatekeep, setting up governance policies, or connecting agents via MCP? We are here to help.</p>

    <div class="card">
      <h3 style="margin-top:0;">Direct Engineering Support</h3>
      <p>Email our engineering team directly at <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>. We respond to all technical and account inquiries within two business days (under 4 business hours for Pro &amp; Suite workspaces).</p>
    </div>

    <h2>Frequently Asked Questions</h2>
    <h3>How do I generate an agent API key without touching a database?</h3>
    <p>In any Slack channel where Gatekeep is installed, run <code>/gatekeep new-key cursor</code> (or any agent name). Gatekeep responds with a private ephemeral message containing your <code>gk_live_...</code> key and the exact JSON snippet for Cursor and Claude Code.</p>

    <h3>What happens if a request times out?</h3>
    <p>Gatekeep operates under a strict <strong>default-deny</strong> security model. If no human reviews the card before the configured timeout (default: 30 minutes), the request expires automatically and any execution attempts are rejected.</p>

    <h3>Can an agent tamper with parameters after approval?</h3>
    <p>No. When an approval is granted, the single-use execution token is cryptographically bound to the RFC 8785 canonical SHA-256 hash of the approved parameters. If the agent alters even a single character before consuming the token, execution is blocked.</p>

    <h2>Documentation &amp; Resources</h2>
    <ul>
      <li><a href="https://bsuit.app">bsuit.app Home</a></li>
      <li><a href="/privacy">Privacy Policy</a></li>
      <li><a href="/slack/install">Install Gatekeep to Slack</a></li>
    </ul>`,
  );
}

export function installedPage(teamName: string): string {
  return layout(
    "Gatekeep Installed Successfully — bsuit.app",
    `<h1>🛡️ Gatekeep is installed! Connected to ${escapeHtml(teamName)}</h1>
    <p>Your Slack workspace is now protected by Gatekeep's human-in-the-loop control plane.</p>
    
    <div class="card">
      <h3 style="margin-top:0;">Next Steps (60 Seconds)</h3>
      <ol>
        <li>Open Slack and type <code>/gatekeep new-key cursor</code> in your ops or approvals channel.</li>
        <li>Copy the generated <code>gk_live_...</code> key and paste the MCP snippet into your <code>.cursor/mcp.json</code> or Claude Code CLI.</li>
        <li>Ask your AI agent to run a governed action and approve your first interactive card in Slack!</li>
      </ol>
    </div>

    <p><a href="/" class="btn">Back to Gatekeep Overview</a></p>`,
  );
}

export function oauthErrorPage(message: string): string {
  return layout(
    "Gatekeep Installation Error — bsuit.app",
    `<h1>Installation Incomplete</h1>
    <p style="color: #ef4444;">${escapeHtml(message)}</p>
    <p>Please try the installation again from the link below:</p>
    <p><a href="/slack/install" class="btn">Retry Installation</a></p>`,
  );
}

export { docsPage } from "./docs.ts";

