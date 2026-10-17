-- ============================================================================
-- 003_gatekeep.sql — Gatekeep: Human Approval Layer for AI Agents
-- Unified control plane for agent governance, RFC 8785 canonical hash binding,
-- atomic CAS state machine, single-use approval tokens, and immutable audit trail.
-- ============================================================================

-- 1. Agentes (identidades + API keys)
CREATE TABLE IF NOT EXISTS gatekeep_agents (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    key_id VARCHAR(24) NOT NULL UNIQUE,              -- parte pública de gk_live_<key_id>_<secret>
    key_hash BYTEA NOT NULL,                          -- SHA-256(secret)
    environment VARCHAR(8) NOT NULL DEFAULT 'live',   -- 'live' | 'test'
    allowed_actions TEXT[] NOT NULL DEFAULT '{*}',
    default_on_behalf_of VARCHAR(32),                 -- Slack user id
    created_by_slack_user_id VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',     -- 'active' | 'suspended' | 'revoked'
    rate_limit_per_hour INT NOT NULL DEFAULT 60,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, name)
);

-- 2. Políticas versionadas (imutáveis por versão)
CREATE TABLE IF NOT EXISTS gatekeep_policies (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    version INT NOT NULL,
    document JSONB NOT NULL,                          -- YAML/JSON validado
    document_hash BYTEA NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_by_slack_user_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gk_policy_active
  ON gatekeep_policies(workspace_id) WHERE is_active;

-- 3. Requests (cabeçalho + estado)
CREATE TABLE IF NOT EXISTS gatekeep_requests (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    public_id VARCHAR(64) NOT NULL UNIQUE,            -- gk_req_<ulid/uuid>
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES gatekeep_agents(id),
    idempotency_key VARCHAR(128),
    action VARCHAR(128) NOT NULL,
    target VARCHAR(256),
    status VARCHAR(16) NOT NULL,  -- pending|needs_info|approved|edited|waiting_lock|approved_ready|rejected|expired|cancelled|executing|executed|failed
    current_revision INT NOT NULL DEFAULT 1,
    risk VARCHAR(8) NOT NULL,                         -- low|medium|high|critical
    gate VARCHAR(8) NOT NULL DEFAULT 'soft',          -- 'soft' | 'hard'
    policy_version INT NOT NULL DEFAULT 1,
    matched_rule_ids TEXT[] NOT NULL DEFAULT '{}',
    evaluation JSONB NOT NULL,                        -- stages, quorum, requirements (snapshot)
    on_behalf_of_slack_user_id VARCHAR(32),
    justification TEXT,
    callback_url TEXT,
    slack_channel_id VARCHAR(32),
    slack_message_ts VARCHAR(32),
    card_version INT NOT NULL DEFAULT 0,
    queue_id UUID REFERENCES queues(id) ON DELETE SET NULL,
    queue_entry_id UUID REFERENCES queue_entries(id) ON DELETE SET NULL,
    todo_id UUID REFERENCES todos(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gk_req_idem
  ON gatekeep_requests(workspace_id, agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gk_req_open
  ON gatekeep_requests(workspace_id, status, expires_at)
  WHERE status IN ('pending','needs_info','approved','edited','waiting_lock','approved_ready','executing');

-- 4. Revisões (params imutáveis por revisão; edit = nova revisão)
CREATE TABLE IF NOT EXISTS gatekeep_request_revisions (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    request_id UUID NOT NULL REFERENCES gatekeep_requests(id) ON DELETE CASCADE,
    revision INT NOT NULL,
    params_enc BYTEA NOT NULL,                        -- AES-256-GCM (iv||ct||tag) com master key
    params_hash VARCHAR(64) NOT NULL,                 -- base64url SHA-256 do payload canônico
    params_schema JSONB,
    editable TEXT[] NOT NULL DEFAULT '{}',
    display JSONB,
    preview_enc BYTEA,
    preview_hash VARCHAR(64),
    secret_refs TEXT[] NOT NULL DEFAULT '{}',
    created_by VARCHAR(128) NOT NULL,                 -- 'agent:<id>' | 'slack:<user_id>'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, revision)
);

-- 5. Decisões humanas (1 por aprovador por estágio por revisão)
CREATE TABLE IF NOT EXISTS gatekeep_decisions (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    request_id UUID NOT NULL REFERENCES gatekeep_requests(id) ON DELETE CASCADE,
    revision INT NOT NULL,
    stage INT NOT NULL DEFAULT 0,
    decision VARCHAR(16) NOT NULL,                    -- approve|reject|edit_approve|ask_context|auto_approve|policy_deny
    slack_user_id VARCHAR(32),                        -- NULL para auto/policy
    slack_team_id VARCHAR(32),
    note TEXT,
    params_hash VARCHAR(64) NOT NULL,                 -- o que ESTE humano viu/aprovou
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (request_id, revision, stage, slack_user_id)
);

-- 6. Tokens de aprovação (single-use)
CREATE TABLE IF NOT EXISTS gatekeep_approval_tokens (
    jti UUID PRIMARY KEY DEFAULT uuidv7(),
    request_id UUID NOT NULL REFERENCES gatekeep_requests(id) ON DELETE CASCADE,
    revision INT NOT NULL,
    params_hash VARCHAR(64) NOT NULL,
    token_hash BYTEA NOT NULL UNIQUE,                 -- SHA-256(gkt_…)
    expires_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,                         -- entregue ao agente (1x)
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- 7. Execuções / receipts
CREATE TABLE IF NOT EXISTS gatekeep_executions (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    request_id UUID NOT NULL UNIQUE REFERENCES gatekeep_requests(id) ON DELETE CASCADE,
    jti UUID NOT NULL REFERENCES gatekeep_approval_tokens(jti),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reported_status VARCHAR(16),                      -- succeeded|failed|skipped|no_receipt
    summary TEXT,
    output_url TEXT,
    duration_ms INT,
    reported_at TIMESTAMPTZ
);

-- 8. Liberações JIT de credenciais (metadados; payload no kv_store UNLOGGED)
CREATE TABLE IF NOT EXISTS gatekeep_secret_releases (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    request_id UUID NOT NULL REFERENCES gatekeep_requests(id) ON DELETE CASCADE,
    revision INT NOT NULL,
    params_hash VARCHAR(64) NOT NULL,
    secret_ref VARCHAR(64) NOT NULL,
    kv_key TEXT NOT NULL,                             -- chave no kv_store (ciphertext + server half)
    client_key_enc BYTEA NOT NULL,                    -- metade cliente cifrada com master (nunca no Slack)
    attached_by_slack_user_id VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'armed',      -- armed|released|expired|revoked
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Endpoints de webhook
CREATE TABLE IF NOT EXISTS gatekeep_webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES gatekeep_agents(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret_enc BYTEA NOT NULL,                        -- whsec_… cifrado
    events TEXT[] NOT NULL DEFAULT '{*}',
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Audit append-only com hash chain
CREATE TABLE IF NOT EXISTS gatekeep_audit_events (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    request_id UUID,
    actor VARCHAR(128) NOT NULL,                      -- 'agent:<id>' | 'slack:<user>' | 'policy' | 'system'
    event_type VARCHAR(48) NOT NULL,                  -- request.created, decision.approve, token.consumed…
    data JSONB NOT NULL,                              -- só metadados + hashes (sem params em claro)
    prev_hash BYTEA,
    row_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Integração com Queue e Secret Audit
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS gatekeep_request_id UUID;
ALTER TABLE secret_audit_logs ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'secret';

-- 12. Billing: contador de requests/mês
CREATE TABLE IF NOT EXISTS gatekeep_monthly_usage (
    id VARCHAR(64) PRIMARY KEY,                       -- workspace_id || ':' || 'YYYY-MM'
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    billing_month CHAR(7) NOT NULL,
    requests_count INT NOT NULL DEFAULT 0,
    auto_approved_count INT NOT NULL DEFAULT 0
);
