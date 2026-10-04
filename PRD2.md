Flow 2: The In-Channel Encrypted Card (Active vs. Burned States)

⚬ State 1: Active & Unread
+-------------------------------------------------------------------+ | 🔐
@leonardo shared an encrypted secret | | | | 📌 Context: Staging DB & Stripe Env
Vars | | 🛡️ Access: Restricted to @caio | | ⏳ Policy: Burns after 1 view
(Auto-destroys in 59m) | | | | [ 👁️ Reveal Secret ] [ 🗑️ Revoke & Destroy ] |
+-------------------------------------------------------------------+

⚬ State 2: Revealed Modal (Shown ONLY to @caio upon clicking Reveal)
+-------------------------------------------------------------------+ | 🔓
Decrypted Secret [X] |
+-------------------------------------------------------------------+ | ⚠️
WARNING: THIS SECRET HAS NOW BEEN DESTROYED ON OUR SERVERS. | | Copy the value
below before closing this window. | | | |
`|
  | DATABASE_URL="postgresql://ro_user:9x8a7s@db.internal:5432"       |
  | STRIPE_WEBHOOK_SECRET="whsec_8f92a..."                            |
  |`
| | | | Shared by: @leonardo • Destroyed at: 2026-10-03 14:22:10 UTC | | 💡 Need
to rotate this later? [ + Add Reminder to Todo ] |
+-------------------------------------------------------------------+ | [ Done /
Close ] +-------------------------------------------------------------------+

⚬ State 3: Burned / Audit Card (Updated in-place via chat.update the millisecond
State 2 opens)
+-------------------------------------------------------------------+ | 🔒
Encrypted Secret (Permanently Destroyed) | | | | 📌 Context: Staging DB & Stripe
Env Vars | | 🔴 Status: Viewed by @caio on Oct 3 at 14:22 UTC | | 🧹
Cryptographic payload purged from memory. |
+-------------------------------------------------------------------+

4. Product 2: Queue — Deep-Dive Specification

Tagline: Dead-simple resource locking, deployment lines, and PR triage inside
Slack.

4.1 Core Concepts & State Machine

Every Queue is a finite state machine scoped to a Slack Channel (or Workspace)
with three primary operational modes:

1. Exclusive Mutex Mode (max_concurrency = 1): Classic deployment line
   (#staging-deploy, #db-migrations). Only 1 person holds the lock; everyone
   else waits in FIFO order.
2. Semaphore / Pool Mode (max_concurrency = N): Shared test clusters or QA
   device pools (e.g., 3 available staging sandboxes). Up to N users hold active
   slots simultaneously; user N+1 waits for the first of the N holders to
   finish.
3. Round-Robin / Triage Mode (Stateless Assignment): Used for #pr-reviews or
   #support-escalation. Automatically assigns incoming items to the next
   available engineer on the roster, checking Slack API (users.getPresence and
   users.profile.get) to skip anyone who is Out-of-Office or in Do Not Disturb.

4.2 User Flows & Wireframes (Block Kit)

Flow 1: Slash Commands & Quick Actions

⚬ /queue or /queue status -> Renders (or bumps to the bottom of the channel) the
live interactive Queue Card. ⚬ /queue join [optional note] -> Adds the user to
the default channel queue (e.g., /queue join Testing hotfix #882). ⚬ /queue
leave or /queue done -> Releases the active slot and automatically notifies the
next person in line. ⚬ /queue kick @user -> Admin/peer override when someone
goes AFK while holding the lock. ⚬ /queue swap @user -> Requests or executes a
position swap in the waiting line.

Flow 2: The Live Queue Card (In-Channel Widget)

Whenever anyone joins, leaves, or times out, the app updates the existing card
via chat.update (or deletes the old card and posts a fresh one at the bottom of
the channel if "Sticky Bottom Mode" is enabled):

+-------------------------------------------------------------------+ | 🚦
Queue: #staging-api • [ 1/1 Active Slots Occupied ] |
+-------------------------------------------------------------------+ | 🟢
ACTIVE HOLDER | | 👉 @leonardo (Holding for 22m) | | 💬 "Running migration v42 &
smoke tests" | | ⏳ Auto-expires in 23m | | | | 📋 WAITING LINE (2 in queue —
Est. wait: ~20m) | | 1️⃣ @caio (Waiting 14m) — "Verify billing webhook fix" | |
2️⃣ @giovanna (Waiting 3m) — "QA checkout flow" |
+-------------------------------------------------------------------+ | [ 🙋
Join Queue ] [ ✅ Done / Release ] [ ⏱️ +15m ] [ ⚙️ Manage ]|
+-------------------------------------------------------------------+

Flow 3: Automated Timeout & Handoff Engine (Background Worker)

One of the biggest pain points in engineering queues is when a developer deploys
to staging, forgets to release the lock, and goes to lunch. Queue solves this
automatically:

1. Soft Warning (T minus 5 minutes): At 40 minutes (for a 45m TTL queue), the
   bot sends a DM/ephemeral ping to @leonardo: "⏳ Your lock on #staging-api
   expires in 5 minutes, and @caio is waiting in line. Need more time?" [ ⏱️
   Extend +15m ] [ ✅ I'm Done — Release Now ]
2. Auto-Eject & Handoff (T = 0): If @leonardo does not respond within 5 minutes:
   ⚬ @leonardo is automatically removed from the Active slot. ⚬ @caio is
   promoted to Active Holder. ⚬ @caio receives an instant DM and thread mention:
   "🚀 You're up! You now hold the active lock on #staging-api (auto-released
   from @leonardo)."

3. Product 3: Todo — Deep-Dive Specification

Tagline: Turn Slack conversations into tracked action items in one click.

5.1 Core Design Philosophy: Why Not Just Use Jira or Linear?

Jira and Linear are built for sprint planning and multi-day engineering tickets.
They are terrible for the 15 micro-promises you make in Slack every day:

⚬ "Can you send me that SQL query after the standup?" ⚬ "Remind me to check the
Cloudflare cache settings at 4pm." ⚬ "Let's make sure we update the customer
docs before Friday."

Todo lives 100% inside Slack and captures tasks at the speed of thought via
three zero-friction entry points: Reactions, Message Shortcuts, and Slash
Commands.

5.2 User Flows & Wireframes (Block Kit)

Flow 1: The 3 Capture Mechanisms

1. Emoji Reaction Capture (Zero-Modal): ⚬ User reacts to any message in any
   channel or DM with :todo: (or :ballot_box_with_check:, configurable per
   workspace). ⚬ The bot listens to reaction_added, fetches the message text and
   chat.getPermalink, creates a personal task linked to that thread, and sends a
   quiet ephemeral message to the user: ✅ Saved to your Todo list: "Can you
   review the pg_bouncer config..." [ 📅 Set Due Date ] [ 👤 Assign ] [ 🗑️ Undo
   ]
2. Message Shortcut ("Create Todo / Assign"): ⚬ Clicking the ⋮ menu on any Slack
   message -> "Create Todo" opens a modal with the message text pre-populated,
   allowing the user to assign it to a teammate, attach it to a Channel Shared
   List, or set a deadline.
3. Slash Command with Natural Language Date Parsing (/todo): ⚬ /todo Check
   Hetzner backup logs tomorrow at 10am #ops ⚬ Our NLP parser automatically
   strips tomorrow at 10am (converting it to a UTC timestamp based on the user's
   Slack profile tz_offset) and tags #ops.

Flow 2: Delegated Tasks & Social Accountability

When @leonardo runs /todo @caio Update Terraform state before 5pm:

1. @caio receives an interactive card in the channel (or DM):
   +-------------------------------------------------------------------+ | 📌
   New Task Assigned to @caio (by @leonardo) | | | | "Update Terraform state" |
   | ⏰ Due: Today at 17:00 BRT • 🔗 Context: #infra-team | | | | [ ✅ Mark
   Complete ] [ ⏳ Snooze 1h ] [ 💬 Discuss in Thread ] |
   +-------------------------------------------------------------------+

2. The moment @caio clicks [ ✅ Mark Complete ], the card updates with a green
   checkmark and @leonardo receives a quiet notification: "🎉 @caio completed
   the task you assigned: 'Update Terraform state' (took 42m)."

Flow 3: The "App Home" Personal & Team Command Center

Clicking on the Todo app in the left Slack sidebar opens the App Home tab
(views.publish), acting as a full GTD (Getting Things Done) manager inside
Slack:

+-----------------------------------------------------------------------+ | ✅
Todo Command Center [ + New Task ] [ 📋 Templates ] | | View: [ 👤 My Tasks (4)
] [ 👥 Delegated by Me (2) ] [ #️⃣ Channel ] |
+-----------------------------------------------------------------------+ | 🔥
OVERDUE (1) | | [ ] Rotate staging API keys (from 🔐 Secret) | | ⚠️ Due
Yesterday • [ ✅ Done ] [ 💤 Tomorrow ] [ 🗑️ ] | | | | 📅 DUE TODAY (2) | | [ ]
Review @ariadine's Q4 budget sheet (🔗 Jump to thread) | | ⏰ Due 15:00 • [ ✅
Done ] [ 💤 +2h ] [ ✏️ Edit ] | | [ ] Check Hetzner backup logs (#ops) | | ⏰
Due 17:00 • [ ✅ Done ] [ 💤 Tomorrow ] [ ✏️ Edit ] | | | | 📥 INBOX / NO DUE
DATE (1) | | [ ] "Can you send me that SQL query after standup?" (via :todo:
emoji)| | 💬 From @caio in #database • [ ✅ Done ] [ 📅 Set Date ] |
+-----------------------------------------------------------------------+

6. Unified Technical Architecture & Database Schema

To run all three apps with high reliability, near-zero latency, and minimal
hosting cost (easily running on a single Hetzner/Dokploy cluster or lightweight
cloud setup), we use a Modular Monolith architecture.

6.1 Recommended Tech Stack

⚬ Runtime & API Layer: Go (Golang) or TypeScript (Node.js / Deno with
Fastify/Hono). ⚬ Why: Slack requires every slash command, button click
(block_actions), and modal submission (view_submission) to return an HTTP 200 OK
within 3,000ms (ideally <150ms for snappy UX). ⚬ Primary Relational Database:
PostgreSQL 17/18 ⚬ Stores workspaces, OAuth tokens (encrypted at rest), active
user billing buckets, queues, todos, and immutable audit metadata for Secret. ⚬
Volatile Memory & Locking Engine: Redis (or Valkey) ⚬ For Secret: Stores
AES-256-GCM encrypted ciphertexts in memory with strict EXPIRE TTLs and atomic
GETDEL burn-on-read operations. ⚬ For Queue: Provides distributed mutex locking
and fast sorted sets (ZSET) for timeout scheduling. ⚬ For Billing: Tracks
monthly active user_id sets per workspace (SADD
billing:active_users:{workspace_id}:{YYYY-MM} {user_id}) with O(1) cardinality
checks (SCARD).

6.2 Core PostgreSQL Schema (Shared & App-Specific)

# -- ============================================================================ -- 1. SHARED PLATFORM & FLAT-TIER BILLING SCHEMA --

CREATE TABLE workspaces ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
slack_team_id VARCHAR(32) UNIQUE NOT NULL, slack_enterprise_id VARCHAR(32),
team_name VARCHAR(255) NOT NULL, bot_access_token_enc BYTEA NOT NULL, --
Encrypted via KMS/Master Key installed_apps TEXT[] NOT NULL DEFAULT '{}', --
e.g., {'secret', 'queue', 'todo'} plan_tier VARCHAR(32) NOT NULL DEFAULT 'free',
-- 'free', 'starter_10', 'growth_30', 'scale_50', 'suite_starter',
'suite_growth', 'suite_scale' has_secret_audit_addon BOOLEAN NOT NULL DEFAULT
FALSE, -- The $99/mo add-on stripe_customer_id VARCHAR(64),
stripe_subscription_id VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT
NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW() );

-- Tracks Monthly Active Users (MAU) per workspace to enforce the 5 / 10 / 30 /
50+ buckets CREATE TABLE workspace_monthly_active_users ( workspace_id UUID NOT
NULL REFERENCES workspaces(id) ON DELETE CASCADE, billing_month CHAR(7) NOT
NULL, -- Format: '2026-10' slack_user_id VARCHAR(32) NOT NULL,
first_interaction_app VARCHAR(16) NOT NULL, -- 'secret', 'queue', or 'todo'
interaction_count INT NOT NULL DEFAULT 1, first_seen_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY
(workspace_id, billing_month, slack_user_id) );

CREATE INDEX idx_mau_workspace_month ON
workspace_monthly_active_users(workspace_id, billing_month);

-- ============================================================================
-- 2. SECRET APP SCHEMA (ZERO-KNOWLEDGE METADATA & $99 AUDIT LOGS ONLY) -- Note:
Actual encrypted secret payloads NEVER touch PostgreSQL; they live in Redis RAM.
-- ============================================================================

CREATE TABLE secret_audit_logs ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
secret_ephemeral_id VARCHAR(64) NOT NULL, -- Matches Redis key ID
creator_slack_user_id VARCHAR(32) NOT NULL, target_channel_id VARCHAR(32),
allowed_recipient_ids TEXT[], -- NULL if open to channel public_context_label
VARCHAR(255), max_views INT NOT NULL DEFAULT 1, current_views INT NOT NULL
DEFAULT 0, status VARCHAR(24) NOT NULL DEFAULT 'active', -- 'active',
'viewed_and_burned', 'revoked', 'expired_ttl' viewed_by_slack_user_id
VARCHAR(32), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at
TIMESTAMPTZ NOT NULL, destroyed_at TIMESTAMPTZ );

CREATE INDEX idx_secret_audit_workspace_created ON
secret_audit_logs(workspace_id, created_at DESC);

# -- ============================================================================ -- 3. QUEUE APP SCHEMA --

CREATE TABLE queues ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
slack_channel_id VARCHAR(32) NOT NULL, name VARCHAR(64) NOT NULL, -- e.g.,
'staging-api', 'default' max_concurrency INT NOT NULL DEFAULT 1,
max_hold_minutes INT NOT NULL DEFAULT 45, sticky_message_ts VARCHAR(32), --
Slack message timestamp of the live card created_at TIMESTAMPTZ NOT NULL DEFAULT
NOW(), UNIQUE(workspace_id, slack_channel_id, name) );

CREATE TABLE queue_entries ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE, slack_user_id
VARCHAR(32) NOT NULL, status VARCHAR(16) NOT NULL, -- 'active', 'waiting',
'completed', 'kicked', 'expired' reason_note VARCHAR(255), joined_at TIMESTAMPTZ
NOT NULL DEFAULT NOW(), activated_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
completed_at TIMESTAMPTZ );

CREATE INDEX idx_queue_entries_live ON queue_entries(queue_id, status, joined_at
ASC) WHERE status IN ('active', 'waiting');

# -- ============================================================================ -- 4. TODO APP SCHEMA --

CREATE TABLE todos ( id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id
UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, creator_slack_user_id
VARCHAR(32) NOT NULL, assignee_slack_user_id VARCHAR(32) NOT NULL,
slack_channel_id VARCHAR(32), -- Populated if part of a shared channel list
title TEXT NOT NULL, source_permalink TEXT, -- Deep link to original Slack
thread/message status VARCHAR(16) NOT NULL DEFAULT 'open', -- 'open',
'completed', 'archived' due_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
completed_by_slack_user_id VARCHAR(32), created_at TIMESTAMPTZ NOT NULL DEFAULT
NOW() );

CREATE INDEX idx_todos_assignee_open ON todos(workspace_id,
assignee_slack_user_id, due_at ASC) WHERE status = 'open';

7. Phased Go-To-Market & Execution Roadmap

Phase 1: Core Multi-Tenant Engine + Secret MVP (Weeks 1–3)

⚬ Goal: Ship the first app to the Slack Marketplace, validate the OAuth +
Flat-Rate Billing engine, and start generating B2B viral loops. ⚬ Key
Milestones:

1. Build the shared Slack OAuth v2 installer, workspace token encryption, and
   active-user bucket counter (5 / 10 / 30 / 50+).
2. Implement /secret, Creation Modal, AES-256-GCM Redis engine (GETDEL), and
   Reveal Modal.
3. Build the $99/mo Audit Log & CSV Export tab inside the Slack App Home for
   security-conscious buyers.
4. Submit Secret to the Slack Marketplace (minimal OAuth scopes required:
   commands, chat:write — makes approval very fast).

Phase 2: Queue Launch & Cross-Promotion (Weeks 4–6)

⚬ Goal: Capture daily engineering channel visibility. Unlike Secret (which is
used episodically), Queue stays pinned in #deploys and #engineering all day. ⚬
Key Milestones:

1. Build /queue commands, FIFO/Semaphore state machine, and in-place chat.update
   Live Card rendering.
2. Build the 1-minute tick background worker in Go/Node for 5-minute grace
   warnings and automatic AFK lock releases.
3. Add the cross-sell hook: [🔐 Attach Ephemeral Secret] button directly inside
   Queue handoffs.

Phase 3: Todo Launch & Suite Bundle Monetization (Weeks 7–10)

⚬ Goal: Expand from the engineering team to the entire company (Product, Ops,
CS, Leadership) and introduce the Suite Bundle ($19 / $39 / $59). ⚬ Key
Milestones:

1. Implement :todo: reaction listener (reaction_added), Message Shortcut, and
   /todo with NLP date parsing.
2. Build the full interactive App Home personal & delegated task center plus the
   9:00 AM local timezone Morning Digest.
3. Enable 1-click Suite Bundle Upgrades via Stripe Checkout links directly
   inside the App Home billing section of all three apps.

4. Key Success Metrics (North Star & KPIs)

5. Activation Rate (D1): % of newly installed workspaces that complete at least
   3 core interactions (3 secrets shared, 3 queue locks, or 5 todos created)
   within 24 hours of installation. (Target: >60%)
6. Bucket Upgrade Conversion: % of workspaces hitting 80% of their Free Tier
   limit (4/5 active users or 40/50 monthly interactions) that convert to the $9
   Starter Tier. (Target: 8%–12% due to impulse-buy $9 price point)
7. Suite Bundle Attach Rate: % of paying customers on one app who upgrade to the
   Suite Bundle within 60 days. (Target: >25%)
8. Enterprise Audit Add-On Attach Rate: % of Growth ($20) and Scale ($30) Secret
   customers who add the $99/mo Audit & DLP Pack to satisfy SOC2/ISO compliance.
   (Target: 10%–15%, driving massive ARPU expansion) """

with open("Slack_Micro_Utility_Suite_PRD_v2.md", "w", encoding="utf-8") as f:
f.write(md_content)

print("File generated successfully.")

```text?code_stdout&code_event_index=1
File generated successfully.



Essa estratégia de Flat-Rate por Faixas (Buckets de Usuários Ativos ou Interações) em vez de cobrar "por cabeça" (per-seat tax) é um diferencial competitivo enorme no ecossistema do Slack.

A maioria dos gestores odeia instalar apps no Slack porque uma empresa de 80 pessoas acaba pagando US$ 400/mês mesmo que apenas 8 engenheiros usem a ferramenta no dia a dia. Com os seus valores ($9 até 10 usuários, $20 até 30 usuários e $30 para +50/ilimitado), o app entra na faixa de "compra por impulso" no cartão corporativo (sem precisar de aprovação de diretoria ou compras), enquanto o Add-on de Auditoria e DLP de $99/mês no Secret captura o orçamento de Segurança/Compliance (SOC2/ISO) de empresas maiores sem penalizar os times pequenos.

O que foi atualizado e detalhado no arquivo .MD (PRD v2.0):

1. Nova Estrutura de Pricing em Faixas (Flat-Tier Buckets):
  ⚬ Free Forever ($0): Até 5 usuários ativos/mês (ou 50 interações).
  ⚬ Starter Tier ($9/mês flat): Até 10 usuários ativos/mês (ou 500 interações).
  ⚬ Growth Tier ($20/mês flat): Até 30 usuários ativos/mês (ou 2.500 interações).
  ⚬ Scale Tier ($30/mês flat): 50+ usuários ativos (uso ilimitado no workspace).
  ⚬ Suite Bundle (Os 3 Apps juntos com desconto): $19/mês (até 10), $39/mês (até 30) e $59/mês (50+ ilimitado).
  ⚬ Secret Security & Audit Pack (+$99/mês flat): Pacote focado em compliance (SOC2, ISO27001) com logs imutáveis de metadados, exportação CSV/SIEM, detecção automática de chaves coladas em texto puro nos canais (DLP via Regex/Entropia) e suporte a KMS próprio.
2. Regras de Contagem "Fair-Play" (Zero Bloqueio Brusco):
  ⚬ Apenas usuários que interagem ativamente no mês contam no limite da faixa (quem apenas lê o canal não consome vaga).
  ⚬ Se o 11º usuário de um time no plano de $9 entrar em uma fila durante um incidente, o sistema não bloqueia a operação — ele permite o uso e envia um aviso amigável para o admin sugerindo o upgrade de 1 clique para a faixa de $20.
3. Wireframes em ASCII (Slack Block Kit) e Arquitetura Técnica Completa:
  ⚬ Fluxos visuais das Modais e dos Cards interativos para Secret, Queue e Todo.
  ⚬ Arquitetura de criptografia Envelope + Split-Key (AES-256-GCM) em memória com Redis (GETDEL atômico) para garantir que nem o seu próprio banco de dados consiga ler o segredo sem o clique vindo do Slack.
  ⚬ Schema SQL completo (PostgreSQL) já desenhado para suportar os 3 apps no mesmo banco, incluindo a tabela de controle de Monthly Active Users (MAU) por bucket e a tabela de auditoria de $99 do Secret.

Se quiser, o próximo passo pode ser criar o repositório base (boilerplate) da arquitetura ou os JSONs reais do Slack Block Kit Builder prontos para você colar e testar no painel de desenvolvedor do Slack!
```
