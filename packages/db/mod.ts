/**
 * @module @suite/db
 * Dual-Pool Database Client (PostgreSQL 18 Origin + PgCache CDC Wire Proxy Fallback)
 * with unified Multi-Tenant Repositories and Native KV Store.
 */

import postgres, { type Sql } from "postgres";
import {
  createKVStore,
  type MultiViewResult,
  type SecretKVPayload,
} from "./kv.ts";

export type { MultiViewResult, SecretKVPayload };
export { createKVStore };

// Default environment URLs
const DEFAULT_ORIGIN_URL =
  "postgres://suite_user:suite_local_password@localhost:5432/slack_suite";

let sqlWriteInstance: Sql | null = null;
let sqlReadInstance: Sql | null = null;

export function setCustomSql(write?: Sql | null, read?: Sql | null): void {
  sqlWriteInstance = write ?? null;
  sqlReadInstance = read ?? null;
}

export function getDatabaseOriginUrl(): string {
  return Deno.env.get("DATABASE_ORIGIN_URL") ??
    Deno.env.get("DATABASE_URL") ??
    DEFAULT_ORIGIN_URL;
}

export function getPgCacheUrl(): string | null {
  const enabled = Deno.env.get("PGCACHE_ENABLED");
  if (enabled === "false" || enabled === "0") return null;
  return Deno.env.get("PGCACHE_URL") ?? null;
}

/**
 * Origin Database connection (PostgreSQL 18) for writes, transactions, outbox, and KV operations.
 */
export function getSqlWrite(): Sql {
  if (!sqlWriteInstance) {
    const originUrl = getDatabaseOriginUrl();
    sqlWriteInstance = postgres(originUrl, {
      max: 20,
      idle_timeout: 30,
      prepare: true,
      onnotice: () => {}, // Suppress noisy PG notices
    });
  }
  return sqlWriteInstance;
}

/**
 * Read-optimized connection.
 * Connects to PgCache (:5433) if available, with transparent fallback to Origin (:5432).
 */
export function getSqlRead(): Sql {
  const pgcacheUrl = getPgCacheUrl();
  if (pgcacheUrl) {
    if (!sqlReadInstance) {
      sqlReadInstance = postgres(pgcacheUrl, {
        max: 30,
        idle_timeout: 30,
        prepare: true,
        onnotice: () => {},
      });
    }
    return sqlReadInstance;
  }
  // Transparent fallback to Origin DB when PgCache is not configured
  return getSqlWrite();
}

/**
 * Proxy objects that delegate dynamically to the active pools.
 */
type CallableSql =
  & ((...args: unknown[]) => unknown)
  & Record<string | symbol, unknown>;

export const sqlWrite: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply(_target, _thisArg, argArray) {
    const fn = getSqlWrite() as unknown as CallableSql;
    return fn(...argArray);
  },
  get(_target, prop) {
    const instance = getSqlWrite() as unknown as CallableSql;
    const value = instance[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
});

export const sqlRead: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply(_target, _thisArg, argArray) {
    const fn = getSqlRead() as unknown as CallableSql;
    const writeFn = getSqlWrite() as unknown as CallableSql;
    if (fn === writeFn) {
      return fn(...argArray);
    }
    try {
      const result = fn(...argArray);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        return (result as Promise<unknown>).catch((err: unknown) => {
          console.warn(
            "PgCache read failed, falling back transparently to Origin DB:",
            err,
          );
          return writeFn(...argArray);
        });
      }
      return result;
    } catch (err) {
      console.warn(
        "PgCache read failed synchronously, falling back to Origin DB:",
        err,
      );
      return writeFn(...argArray);
    }
  },
  get(_target, prop) {
    const instance = getSqlRead() as unknown as CallableSql;
    const value = instance[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
});

/**
 * Default native KV store bound to the Origin DB pool.
 */
export const kv = createKVStore(getSqlWrite);

/**
 * Gracefully close database connection pools.
 */
export async function closeDb(): Promise<void> {
  if (sqlWriteInstance) {
    await sqlWriteInstance.end({ timeout: 5 });
    sqlWriteInstance = null;
  }
  if (sqlReadInstance) {
    await sqlReadInstance.end({ timeout: 5 });
    sqlReadInstance = null;
  }
}

// ============================================================================
// REPOSITORIES
// ============================================================================

export interface WorkspaceRow {
  id: string;
  slack_team_id: string;
  slack_enterprise_id: string | null;
  team_name: string;
  plan_tier: string;
  has_secret_audit_addon: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_status: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceInstallationRow {
  id: string;
  workspace_id: string;
  app_slug: string;
  bot_user_id: string;
  bot_access_token_enc: Uint8Array;
  installed_by_user_id: string;
  scopes: string[];
  installed_at: Date;
}

export const workspacesRepo = {
  async findBySlackTeamId(
    slackTeamId: string,
    sql: Sql = getSqlRead(),
  ): Promise<WorkspaceRow | null> {
    const rows = await sql<WorkspaceRow[]>`
      SELECT * FROM workspaces
      WHERE slack_team_id = ${slackTeamId}
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  },

  async upsert(
    data: {
      slackTeamId: string;
      teamName: string;
      slackEnterpriseId?: string | null;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<WorkspaceRow> {
    const rows = await sql<WorkspaceRow[]>`
      INSERT INTO workspaces (slack_team_id, team_name, slack_enterprise_id, updated_at)
      VALUES (${data.slackTeamId}, ${data.teamName}, ${
      data.slackEnterpriseId ?? null
    }, NOW())
      ON CONFLICT (slack_team_id) DO UPDATE
      SET team_name = EXCLUDED.team_name,
          slack_enterprise_id = COALESCE(EXCLUDED.slack_enterprise_id, workspaces.slack_enterprise_id),
          updated_at = NOW()
      RETURNING *
    `;
    return rows[0];
  },
};

export const installationsRepo = {
  async findInstallation(
    slackTeamId: string,
    appSlug: "secret" | "queue" | "todo" | string,
    sql: Sql = getSqlRead(),
  ): Promise<
    {
      workspace: WorkspaceRow;
      installation: WorkspaceInstallationRow;
    } | null
  > {
    const rows = await sql<
      (WorkspaceRow & {
        inst_id: string;
        inst_workspace_id: string;
        app_slug: string;
        bot_user_id: string;
        bot_access_token_enc: Uint8Array;
        installed_by_user_id: string;
        scopes: string[];
        installed_at: Date;
      })[]
    >`
      SELECT 
        w.*,
        wi.id AS inst_id,
        wi.workspace_id AS inst_workspace_id,
        wi.app_slug,
        wi.bot_user_id,
        wi.bot_access_token_enc,
        wi.installed_by_user_id,
        wi.scopes,
        wi.installed_at
      FROM workspaces w
      JOIN workspace_installations wi ON wi.workspace_id = w.id
      WHERE w.slack_team_id = ${slackTeamId}
        AND wi.app_slug = ${appSlug}
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      workspace: {
        id: r.id,
        slack_team_id: r.slack_team_id,
        slack_enterprise_id: r.slack_enterprise_id,
        team_name: r.team_name,
        plan_tier: r.plan_tier,
        has_secret_audit_addon: r.has_secret_audit_addon,
        stripe_customer_id: r.stripe_customer_id,
        stripe_subscription_id: r.stripe_subscription_id,
        billing_status: r.billing_status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
      installation: {
        id: r.inst_id,
        workspace_id: r.inst_workspace_id,
        app_slug: r.app_slug,
        bot_user_id: r.bot_user_id,
        bot_access_token_enc: r.bot_access_token_enc,
        installed_by_user_id: r.installed_by_user_id,
        scopes: r.scopes,
        installed_at: r.installed_at,
      },
    };
  },

  async findByWorkspaceId(
    workspaceId: string,
    appSlug: "secret" | "queue" | "todo" | string,
    sql: Sql = getSqlRead(),
  ): Promise<
    {
      workspace: WorkspaceRow;
      installation: WorkspaceInstallationRow;
    } | null
  > {
    const rows = await sql<
      (WorkspaceRow & {
        inst_id: string;
        inst_workspace_id: string;
        app_slug: string;
        bot_user_id: string;
        bot_access_token_enc: Uint8Array;
        installed_by_user_id: string;
        scopes: string[];
        installed_at: Date;
      })[]
    >`
      SELECT 
        w.*,
        wi.id AS inst_id,
        wi.workspace_id AS inst_workspace_id,
        wi.app_slug,
        wi.bot_user_id,
        wi.bot_access_token_enc,
        wi.installed_by_user_id,
        wi.scopes,
        wi.installed_at
      FROM workspaces w
      JOIN workspace_installations wi ON wi.workspace_id = w.id
      WHERE w.id = ${workspaceId}::uuid
        AND wi.app_slug = ${appSlug}
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      workspace: {
        id: r.id,
        slack_team_id: r.slack_team_id,
        slack_enterprise_id: r.slack_enterprise_id,
        team_name: r.team_name,
        plan_tier: r.plan_tier,
        has_secret_audit_addon: r.has_secret_audit_addon,
        stripe_customer_id: r.stripe_customer_id,
        stripe_subscription_id: r.stripe_subscription_id,
        billing_status: r.billing_status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
      installation: {
        id: r.inst_id,
        workspace_id: r.inst_workspace_id,
        app_slug: r.app_slug,
        bot_user_id: r.bot_user_id,
        bot_access_token_enc: r.bot_access_token_enc,
        installed_by_user_id: r.installed_by_user_id,
        scopes: r.scopes,
        installed_at: r.installed_at,
      },
    };
  },

  async upsert(
    data: {
      workspaceId: string;
      appSlug: string;
      botUserId: string;
      botAccessTokenEnc: Uint8Array;
      installedByUserId: string;
      scopes: string[];
    },
    sql: Sql = getSqlWrite(),
  ): Promise<WorkspaceInstallationRow> {
    const rows = await sql<WorkspaceInstallationRow[]>`
      INSERT INTO workspace_installations (
        workspace_id, app_slug, bot_user_id, bot_access_token_enc, installed_by_user_id, scopes, installed_at
      ) VALUES (
        ${data.workspaceId}::uuid,
        ${data.appSlug},
        ${data.botUserId},
        ${data.botAccessTokenEnc},
        ${data.installedByUserId},
        ${data.scopes},
        NOW()
      )
      ON CONFLICT (workspace_id, app_slug) DO UPDATE
      SET bot_user_id = EXCLUDED.bot_user_id,
          bot_access_token_enc = EXCLUDED.bot_access_token_enc,
          installed_by_user_id = EXCLUDED.installed_by_user_id,
          scopes = EXCLUDED.scopes,
          installed_at = NOW()
      RETURNING *
    `;
    return rows[0];
  },

  async deleteBySlackTeam(
    slackTeamId: string,
    appSlug: string,
    sql: Sql = getSqlWrite(),
  ): Promise<number> {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM workspace_installations
      WHERE app_slug = ${appSlug}
        AND workspace_id IN (
          SELECT id FROM workspaces WHERE slack_team_id = ${slackTeamId}
        )
      RETURNING id
    `;
    return rows.length;
  },
};

/**
 * Fair-Play Monthly Active Users (MAU) Tracking.
 * Uses deterministic synthetic PK: workspace_id || ':' || billing_month || ':' || slack_user_id.
 */
export const mauRepo = {
  formatMonth(date: Date = new Date()): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  },

  buildId(workspaceId: string, month: string, slackUserId: string): string {
    return `${workspaceId}:${month}:${slackUserId}`;
  },

  async recordUserInteraction(
    params: {
      workspaceId: string;
      slackUserId: string;
      appSlug: string;
      date?: Date;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<
    { isFirstSeenThisMonth: boolean; totalActiveUsersInMonth: number }
  > {
    const month = this.formatMonth(params.date);
    const id = this.buildId(params.workspaceId, month, params.slackUserId);

    const rows = await sql<{ is_first: boolean }[]>`
      INSERT INTO workspace_monthly_active_users (
        id, workspace_id, billing_month, slack_user_id, first_interaction_app, interaction_count, first_seen_at, last_seen_at
      ) VALUES (
        ${id},
        ${params.workspaceId}::uuid,
        ${month},
        ${params.slackUserId},
        ${params.appSlug},
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET interaction_count = workspace_monthly_active_users.interaction_count + 1,
          last_seen_at = NOW()
      RETURNING (xmax = 0) AS is_first
    `;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM workspace_monthly_active_users
      WHERE workspace_id = ${params.workspaceId}::uuid
        AND billing_month = ${month}
    `;

    return {
      isFirstSeenThisMonth: rows[0]?.is_first ?? false,
      totalActiveUsersInMonth: parseInt(countRows[0]?.count ?? "0", 10),
    };
  },
};

/**
 * Immutable Secret Audit Logging (Enterprise Add-on).
 */
export const secretAuditRepo = {
  async recordCreated(
    params: {
      workspaceId: string;
      secretEphemeralId: string;
      creatorSlackUserId: string;
      targetChannelId?: string | null;
      allowedRecipientIds?: string[] | null;
      publicContextLabel?: string | null;
      maxViews: number;
      expiresAt: Date;
    },
    sql: Sql = getSqlWrite(),
  ): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO secret_audit_logs (
        workspace_id,
        secret_ephemeral_id,
        creator_slack_user_id,
        target_channel_id,
        allowed_recipient_ids,
        public_context_label,
        max_views,
        current_views,
        status,
        expires_at
      ) VALUES (
        ${params.workspaceId}::uuid,
        ${params.secretEphemeralId},
        ${params.creatorSlackUserId},
        ${params.targetChannelId ?? null},
        ${params.allowedRecipientIds ?? null},
        ${params.publicContextLabel ?? null},
        ${params.maxViews},
        0,
        'active',
        ${params.expiresAt}
      )
      RETURNING id
    `;
    return rows[0].id;
  },

  async recordBurned(
    params: {
      secretEphemeralId: string;
      viewerSlackUserId: string;
      status?: "viewed" | "revoked";
    },
    sql: Sql = getSqlWrite(),
  ): Promise<void> {
    await sql`
      UPDATE secret_audit_logs
      SET current_views = current_views + 1,
          status = ${params.status ?? "viewed"},
          viewed_by_slack_user_id = ${params.viewerSlackUserId},
          destroyed_at = NOW()
      WHERE secret_ephemeral_id = ${params.secretEphemeralId}
        AND destroyed_at IS NULL
    `;
  },
};

/**
 * Database migration runner.
 */
export async function runMigrations(
  sql: Sql = getSqlWrite(),
  migrationSqlPath = "./packages/db/migrations/001_init.sql",
): Promise<void> {
  const ddl = await Deno.readTextFile(migrationSqlPath);
  await sql.unsafe(ddl);
}

export * from "./queue.ts";
export * from "./todo.ts";
