-- ============================================================================
-- 001_init.sql - Unified Database Schema for Slack Micro-Utility Suite
-- Target: PostgreSQL 18 with Logical Replication (PgCache CDC Compatible)
-- ============================================================================

-- Polyfill uuidv7() if running on PostgreSQL < 18 or if extension not loaded
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
    CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $func$
    DECLARE
      unix_ts_ms bytea;
      uuid_bytes bytea;
    BEGIN
      unix_ts_ms = substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3 for 6);
      uuid_bytes = unix_ts_ms || gen_random_bytes(10);
      uuid_bytes = set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112); -- version 7
      uuid_bytes = set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128); -- variant 1
      RETURN encode(uuid_bytes, 'hex')::uuid;
    END
    $func$ LANGUAGE plpgsql VOLATILE;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. WORKSPACES & MULTI-APP INSTALLATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    slack_team_id VARCHAR(32) UNIQUE NOT NULL,
    slack_enterprise_id VARCHAR(32),
    team_name VARCHAR(255) NOT NULL,
    plan_tier VARCHAR(32) NOT NULL DEFAULT 'free',
    has_secret_audit_addon BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id VARCHAR(64),
    stripe_subscription_id VARCHAR(64),
    billing_status VARCHAR(24) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_installations (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_slug VARCHAR(16) NOT NULL, -- 'secret', 'queue', 'todo'
    bot_user_id VARCHAR(32) NOT NULL,
    bot_access_token_enc BYTEA NOT NULL,
    installed_by_user_id VARCHAR(32) NOT NULL,
    scopes TEXT[] NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, app_slug)
);

CREATE INDEX IF NOT EXISTS idx_installations_workspace_app 
ON workspace_installations(workspace_id, app_slug);

-- ----------------------------------------------------------------------------
-- 2. FAIR-PLAY BILLING (MAU TRACKING)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_monthly_active_users (
    id VARCHAR(96) PRIMARY KEY, -- workspace_id || ':' || billing_month || ':' || slack_user_id
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    billing_month CHAR(7) NOT NULL, -- 'YYYY-MM'
    slack_user_id VARCHAR(32) NOT NULL,
    first_interaction_app VARCHAR(16) NOT NULL,
    interaction_count INT NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mau_workspace_month 
ON workspace_monthly_active_users(workspace_id, billing_month);

-- ----------------------------------------------------------------------------
-- 3. NATIVE POSTGRESQL KEY-VALUE STORE (UNLOGGED, IN-MEMORY SPEED)
-- ----------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) WITH (
    fillfactor = 70,
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_cost_limit = 2000
);

CREATE INDEX IF NOT EXISTS idx_kv_store_expires_at 
ON kv_store(expires_at);

-- ----------------------------------------------------------------------------
-- 4. TRANSACTIONAL OUTBOX
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_source VARCHAR(16) NOT NULL,      -- 'secret', 'queue', 'todo', 'billing'
    event_type VARCHAR(64) NOT NULL,      -- e.g. 'secret.burned_card_update'
    payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'dead_letter', 'cancelled'
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by VARCHAR(64),
    locked_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
) WITH (
    fillfactor = 80,
    autovacuum_vacuum_scale_factor = 0.02
);

CREATE INDEX IF NOT EXISTS idx_outbox_poll 
ON outbox_events (next_attempt_at ASC, id ASC) 
WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- 5. IMMUTABLE AUDIT LOG (SECRET ENTERPRISE ADD-ON)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS secret_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    secret_ephemeral_id VARCHAR(64) NOT NULL,
    creator_slack_user_id VARCHAR(32) NOT NULL,
    target_channel_id VARCHAR(32),
    allowed_recipient_ids TEXT[],
    public_context_label VARCHAR(255),
    max_views INT NOT NULL DEFAULT 1,
    current_views INT NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'active', -- 'active', 'viewed', 'revoked', 'expired'
    viewed_by_slack_user_id VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    destroyed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_secret_audit_workspace 
ON secret_audit_logs(workspace_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 6. APP QUEUE (SLACK CHANNEL RESOURCE LOCKS & CONCURRENCY)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queues (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slack_channel_id VARCHAR(32) NOT NULL,
    name VARCHAR(64) NOT NULL,
    max_concurrency INT NOT NULL DEFAULT 1,
    max_hold_minutes INT NOT NULL DEFAULT 45,
    sticky_message_ts VARCHAR(32),
    admin_user_ids TEXT[] NOT NULL DEFAULT '{}',
    allow_secret BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, slack_channel_id, name)
);

CREATE TABLE IF NOT EXISTS queue_entries (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    slack_user_id VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL, -- 'active', 'waiting', 'released', 'expired', 'kicked'
    reason_note VARCHAR(255),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_active 
ON queue_entries(queue_id, status, joined_at ASC)
WHERE status IN ('active', 'waiting');

-- ----------------------------------------------------------------------------
-- 7. APP TODO (GTD MICRO-TASKS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    creator_slack_user_id VARCHAR(32) NOT NULL,
    assignee_slack_user_id VARCHAR(32) NOT NULL,
    slack_channel_id VARCHAR(32),
    title TEXT NOT NULL,
    source_permalink TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'open', -- 'open', 'completed', 'cancelled'
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    completed_by_slack_user_id VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_assignee 
ON todos(workspace_id, assignee_slack_user_id, due_at ASC)
WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- 8. PGCACHE LOGICAL REPLICATION PUBLICATION
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'pgcache_suite_pub') THEN
    CREATE PUBLICATION pgcache_suite_pub FOR ALL TABLES;
  END IF;
END $$;

