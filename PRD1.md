Product Requirements Document (PRD): The Slack Micro-Utility Suite

Document Version: 1.0 Status: Draft / Discovery Target Market: Global B2B SaaS
(Engineering, DevOps, Product, and Remote-First Teams) Product Language: English
(US) Product Philosophy: Native-first, zero context-switching, ultra-fast
response (<300ms), and PLG (Product-Led Growth) bundle strategy.

1. Executive Summary & Suite Vision

Modern software and product teams live inside Slack, yet their daily
micro-workflows are constantly interrupted by context switching. Sharing an .env
variable requires opening 1Password or a web-based OneTimeSecret; managing a
deployment queue requires awkward thread replies; tracking quick action items
requires spinning up a heavy Jira or Linear ticket.

The Suite Vision: Build an interconnected ecosystem of three single-purpose,
hyper-focused Slack apps—Secret (ephemeral credential sharing), Queue (resource
and deployment line management), and Todo (frictionless action capture). Each
app acts as a standalone PLG wedge that solves an immediate pain point in under
5 seconds, while sharing a unified billing, identity, and workspace management
backend.

Suite Synergy & Cross-Sell Matrix

Trigger Action in App A	Native Cross-Promotion / Integration in App B Secret:
User shares a database credential or API token.	Prompt in ephemeral
confirmation: "Need to rotate this key later? [Add reminder to Todo]" Queue:
User claims the #staging-deploy queue lock.	Automatically generates a temporary
pre-flight checklist via Todo inside the deploy thread. Queue: User needs to
pass a temporary testing token to the next person in line.	Inline button inside
Queue widget: "[Attach Ephemeral Secret] for the next holder." Todo: A task is
marked as blocked by an environment or PR review.	Inline action: "[Join Review
Queue] in #pr-reviews."

2. Shared Ecosystem Architecture & Slack UX Standards

To ensure a cohesive user experience and minimal maintenance overhead, all three
apps will share the same core infrastructure and design patterns:

⚬ Slack API Primitives: Built strictly on Slack Block Kit, Modals (views.open /
views.update), App Home Tabs, Message Shortcuts, and Slash Commands. ⚬ Zero
Web-Dashboard Dependency: 95% of user and admin configurations (permissions, TTL
defaults, queue rules, billing seat management) happen directly inside each
app's Slack App Home tab. ⚬ Strict Latency SLA: All slash commands and button
interactions must acknowledge (HTTP 200 OK) within 150ms to feel instantaneous,
using asynchronous workers for heavy state updates. ⚬ Tenant Isolation:
Multi-tenant architecture keyed by enterprise_id and team_id, allowing seamless
upgrades from single-workspace startups to Slack Enterprise Grid organizations.

3. Product 1: [App Name] Secret

Tagline: Zero-knowledge, self-destructing secrets directly inside Slack.

3.1 Problem Statement

Every day, engineers and ops teams paste API keys, .env files, database
passwords, and SSH keys directly into Slack DMs or channels. Even if deleted
later, these messages remain in Slack audit logs, compliance exports,
notification caches, and screen shares. Existing external tools (e.g.,
OneTimeSecret, Doppler Share, 1Password links) require leaving Slack,
authenticating in a browser, generating a link, and pasting it back.

3.2 Value Proposition & Security Model

A native Slack workflow where the plaintext secret never touches Slack’s message
history and is never stored in plaintext on our servers.

⚬ How it works: When a user invokes /secret, Slack opens a Modal. Inputs inside
Slack Modals are transmitted directly via TLS payload to our backend webhook and
are not logged in Slack's chat history. ⚬ Encryption: The backend immediately
encrypts the payload in-memory using AES-256-GCM. Part of the decryption key (or
a random salt) is embedded only in the ephemeral button payload or single-use
state token, ensuring that once read (or expired), the ciphertext is
cryptographically unrecoverable and purged from volatile storage (Redis/Memory).

3.3 Core User Flows & Functional Requirements

Flow A: Creating & Sending a Secret

1. Trigger: User types /secret [@user or #channel] or uses the Global Shortcut
   "Share a Secret".
2. Creation Modal: ⚬ Secret Payload (Multi-line plain-text input): Supports
   passwords, .env blocks, or JSON keys (up to 3,000 characters). ⚬
   Context/Label (Optional text input): Publicly visible description (e.g.,
   "Staging Stripe Webhook Secret"). ⚬ Expiration Policy (Dropdown): Burn after
   1 reading (default), Burn after X readings (for channels), 15 Minutes, 1
   Hour, 24 Hours. ⚬ Access Control (Checkbox/Select): "Restrict to specific
   users" or "Require recipient confirmation click".
3. In-Channel / DM Delivery: The app posts a rich Block Kit Card into the target
   conversation: 🔐 @leonardo shared an encrypted secret Context: Staging Stripe
   Webhook Secret Policy: ⏳ Expires in 1 hour | 🔥 Burn after 1 view Status: 🟢
   Available [ 👁️ Reveal Secret ] [ 🗑️ Revoke ]

Flow B: Consuming (Revealing) a Secret

1. Trigger: Recipient clicks [ 👁️ Reveal Secret ].
2. Verification: Backend validates user_id against allowed recipients and checks
   TTL/view count atomically.
3. Ephemeral Modal Delivery: Instead of posting the secret in chat (even as an
   ephemeral message, which can linger on screen), the app opens a Read-Only
   Modal (views.open using the interaction trigger_id): ⚬ Displays the decrypted
   secret inside a pre-formatted code block for easy copy-pasting. ⚬ Warning
   banner: "Close this window only after copying. This secret has now been
   permanently destroyed from our servers."
4. Message Update (Audit State): Immediately upon modal open, the original chat
   card updates in real-time via chat.update: 🔒 Encrypted Secret (Destroyed)
   Context: Staging Stripe Webhook Secret Status: 🔴 Viewed by @ariadine on Oct
   3 at 14:22 UTC (Payload permanently purged).

Flow C: Requesting a Secret (/secret request)

⚬ A user can type /secret request @user "Prod Read-Only DB Password". ⚬ Sends a
card to @user with a [ 🔑 Fulfill Secret Request ] button that directly opens
the Creation Modal pre-addressed to the requester.

3.4 App Home & Enterprise Features

⚬ Audit Log (Metadata Only): Workspace admins can view who shared secrets with
whom, timestamps, and when they were opened/expired—without ever seeing payload
contents. ⚬ Secret Scanning Guardrail (Pro/Enterprise): Optional bot listener in
public channels using high-entropy regex patterns (AWS keys, GitHub PATs,
Postgres URIs, Private Keys). If someone pastes a raw key in chat, the bot
immediately posts an ephemeral warning offering to delete the message (if
granted admin token) and convert it into an encrypted Secret card.

4. Product 2: [App Name] Queue

Tagline: Dead-simple resource locking, deployment lines, and PR triage inside
Slack.

4.1 Problem Statement

Engineering teams constantly contend for shared bottlenecks: staging
environments, QA test devices, database migration windows, or on-call responder
rotations. Today, teams manage this by typing "Anyone using staging?" or "I'm
next for deploy" in a noisy channel. Messages get buried, two devs deploy
simultaneously, staging breaks, and hours are wasted.

4.2 Value Proposition

A persistent, self-updating visual queue widget per channel or resource. One
click to join, one click to pass the baton, automatic timeouts for idle holders,
and automated Slack notifications when it is your turn.

4.3 Core User Flows & Functional Requirements

Flow A: Initializing & Configuring a Queue

1. Trigger: /queue create [name] (e.g., /queue create staging-api) or /queue
   config.
2. Configuration Modal: ⚬ Queue Name & Description: e.g., staging-api — Main
   Kubernetes staging environment. ⚬ Concurrency Limit (Number): Default 1
   (exclusive mutex lock). Can be set to N (e.g., 3 QA testers at once). ⚬ Max
   Hold Time / Auto-Expire: e.g., 45 minutes. Action on timeout: Ping holder
   first (5m grace) or Auto-kick and advance queue. ⚬ Sticky Message / Bookmark:
   Option to auto-pin the Queue Status Card to the channel header or re-post it
   to the bottom of the channel whenever updated so it never gets lost in
   scrollback.

Flow B: Daily Queue Operations (Button & Slash Driven)

The core artifact is the Live Queue Card:

🚦 Queue: staging-api (1/1 Active Slots) 🟢 Active Holder: @leonardo (for 18m —
"Testing hotfix #412") — ⏳ Auto-releases in 27m 📋 Up Next (2 waiting):

1. @caio (waiting 12m — "DB migration test")
2. @giovanna (waiting 4m)

[ 🙋 Join Queue ] [ ✅ Leave / Done ] [ ⏱️️ +15m Extend ] [ ⚙️ Manage ]

⚬ Joining (/queue join [reason] or Button): If the queue is empty, the user
immediately acquires the lock. If occupied, they are appended to the FIFO list.
⚬ Releasing & Handoff (/queue done or Button): When @leonardo clicks Leave /
Done, the backend pops @caio into the Active slot, updates the card in-place,
and sends a direct ping/DM to @caio: "🚀 You're up! You now hold the lock on
staging-api. [Click here to Release when done]." ⚬ Swap & Snooze: Waiting users
can click [ 🔄 Swap Position ] or [ 💤 Step Back 1 Spot ] if they are in a
meeting when their turn approaches. ⚬ Admin Override / Force Eject: Channel
managers or users with override permissions can click [ ⚠️ Force Release ] (or
/queue kick) if a holder goes AFK, logging the override reason in the channel.

Flow C: Triage / Round-Robin Mode (Secondary Use Case)

Beyond FIFO resource locking, Queue supports Load-Balanced Assignment (e.g.,
/queue assign #pr-reviews <link>):

⚬ Maintains a roster of engineers. ⚬ Assigns incoming PRs or support tickets
using Round-Robin or Least-Recently-Assigned, skipping users whose Slack status
is set to 🌴 Vacation / Out of Office or 🔴 Do Not Disturb.

5. Product 3: [App Name] Todo

Tagline: Turn Slack conversations into tracked action items in one click.

5.1 Problem Statement

Slack is where work is discussed, while Jira/Linear/Asana is where work is
formally tracked. However, 60% of daily micro-tasks ("Send the updated SQL query
to Pedro", "Review the Terraform plan after lunch", "Follow up on customer
billing email") are too small for a Jira ticket. Users currently rely on Slack's
native "Save for later" (which lacks structure, delegation, and channel
visibility) or let tasks die in thread scrollback.

5.2 Value Proposition

A lightning-fast task layer built natively into Slack’s Message Shortcuts, Emoji
Reactions, and App Home. It supports both Personal Todos (private productivity)
and Channel/Shared Todos (lightweight team checklists without leaving the chat).

5.3 Core User Flows & Functional Requirements

Flow A: 3 Frictionless Capture Methods

1. Emoji Trigger (Zero-Click Capture): Reacting to any message with :todo: or
   :ballot_box_with_check: automatically captures the message text, author, and
   a permanent deep-link (Permalink) back to the exact Slack thread, adding it
   to the reactor's Todo list and sending a quiet ephemeral confirmation.
2. Message Shortcut ("Create Todo from Message"): Opens a lightweight modal
   pre-filled with the message content and link, allowing the user to assign it
   to a teammate, set a due date, and pick a priority (P0, P1, P2).
3. Slash Command (/todo): ⚬ /todo Call vendor about SSL renewal tomorrow at 2pm
   -> Natural Language Processing (chrono-node style parser) automatically
   extracts the task title and sets the reminder for tomorrow at 14:00 in the
   user's local Slack timezone. ⚬ /todo @user Verify staging logs by 5pm ->
   Delegated task. Sends an interactive card to @user to Accept or Decline, and
   notifies the creator when @user checks it off.

Flow B: Shared Channel Lists & Thread Checklists

⚬ Every channel has an optional shared list accessed via /todo list. ⚬ Deploy /
Incident Checklists: Users can save reusable templates (e.g., /todo template run
release-v2). This posts an interactive Block Kit message with checkboxes
directly into the channel or incident thread, recording who checked off which
item and when.

Flow C: The "App Home" Command Center & Daily Digest

⚬ App Home Dashboard: When a user clicks on the Todo app in their Slack sidebar,
they get a full, interactive Kanban/List view rendered in Block Kit: ⚬ Sections:
🔥 Overdue, 📅 Today, 📥 Inbox (From Saved Messages), 🤝 Delegated to Others,
and ✅ Completed. ⚬ One-Click Actions: Complete, Snooze (+1h, Tomorrow, Next
Week), Edit, or Jump to Original Thread. ⚬ Smart Morning Digest: At 9:00 AM
(user's local timezone, weekdays only), the bot sends a single, consolidated
summary of tasks due today and delegated tasks completed yesterday—never
spamming individual notifications unless a hard deadline is set.

6. Monetization, Pricing & PLG Packaging Strategy

To maximize adoption and minimize procurement friction, the apps should be sold
both individually (low-friction land strategy) and as an All-in-One Workspace
Bundle (expansion strategy).

Feature / Tier	Free Tier (Forever) (Land & Viral Loop)	Pro Tier
($2 / active user / mo per app)	Suite Bundle (All 3 Apps) ($4 / active user / mo
— Save 33%) Billing Model	Free up to 5 active users or usage cap	Fair-billing:
Only charge for users who interact with the app that month	Unified workspace
invoice for all 3 apps Secret	Up to 25 secrets/month; max 1h TTL; 1-view burn
only	Unlimited secrets; custom TTLs; multi-view channel secrets; Secret request
flows	Everything in Pro + Regex Leak Detection & Audit Logs Queue	Max 2 active
queues per workspace; max 3 people in line	Unlimited queues; Auto-expire/kick
timers; Round-robin PR assignment; Analytics	Everything in Pro + Webhook
triggers (GitHub Actions / CI unlock) Todo	Personal todos only (up to 30
active); Emoji capture	Unlimited personal & shared channel lists; Delegated
tasks; Recurring templates	Everything in Pro + 2-Way sync with Linear / Jira /
GitHub Issues

Built-in Viral Mechanics (PLG Loops)

1. Cross-User Exposure: In Secret and Todo, an active user sends a secret or
   delegates a task to a non-user in the workspace, immediately onboarding the
   recipient without setup.
2. External Slack Connect (B2B Viral Loop): All three apps should support Slack
   Connect (Shared Channels). When an agency or SaaS vendor shares an encrypted
   Secret or a Todo checklist with a client in a shared Slack Connect channel,
   the client organization sees the branded card and can install the app in
   their own workspace in 2 clicks.

3. Phased Execution Roadmap & MVP Prioritization

Phase 1: The Wedge — Secret (Weeks 1–3)

⚬ Why start here: Lowest database complexity (stateless/ephemeral by design),
highest immediate security value, and easiest to pass Slack Marketplace security
review while building your core multi-tenant OAuth + Billing foundation. ⚬
Deliverables: Multi-workspace OAuth v2 flow, /secret modal, AES-256-GCM
encryption engine, ephemeral reveal modal, and App Home audit trail.

Phase 2: The Team Utility — Queue (Weeks 4–6)

⚬ Why second: Introduces high-visibility channel cards that everyone in an
engineering channel sees multiple times a day. Drives massive organic engagement
inside the workspace. ⚬ Deliverables: /queue CRUD commands, Live Block Kit state
machine, background worker for TTL auto-expiration and DM notifications, App
Home queue overview.

Phase 3: The Daily Habit — Todo & Bundle Launch (Weeks 7–10)

⚬ Why third: Highest daily retention and largest TAM (every role in a company
uses Todo, not just engineers). Expands the suite from the engineering
department to the entire company. ⚬ Deliverables: Message shortcuts, reaction
listener (reaction_added event), App Home task manager, natural language date
parsing, Morning Digest scheduler, and unified Stripe Suite Billing.

Would you like to dive deeper into the Slack Block Kit JSON payloads and UI
wireframes for any of the three apps, or detail the technical architecture and
database schema to support all three on a single backend?
