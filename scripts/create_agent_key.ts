/**
 * @module scripts/create_agent_key
 * CLI utility to generate a Gatekeep Agent API key without manual SQL.
 *
 * Usage:
 *   deno run -A scripts/create_agent_key.ts [agent_name] [--team=T123]
 */

import { bytesToHex, generateRandomBytes } from "@suite/crypto";
import { gatekeepRepo, getSqlRead, workspacesRepo, type WorkspaceRow } from "@suite/db";

async function main() {
  const args = Deno.args;
  const nameArg = args.find((a) => !a.startsWith("--")) ?? "cursor-agent";
  const teamArg = args.find((a) => a.startsWith("--team="))?.replace("--team=", "").trim();

  let workspace: WorkspaceRow | null = null;
  const sql = getSqlRead();

  if (teamArg) {
    workspace = await workspacesRepo.findBySlackTeamId(teamArg);
    if (!workspace) {
      console.error(`Error: Workspace with Slack team ID "${teamArg}" not found.`);
      Deno.exit(1);
    }
  } else {
    // Pick the most recently installed workspace
    const rows = await sql<WorkspaceRow[]>`
      SELECT * FROM workspaces ORDER BY installed_at DESC LIMIT 1
    `;
    if (rows.length === 0) {
      console.error("Error: No workspaces found in database. Please install Gatekeep in Slack first.");
      Deno.exit(1);
    }
    workspace = rows[0];
  }

  const agentName = nameArg.replace(/[^a-zA-Z0-9_\-\.]/g, "-").slice(0, 50);
  const keyId = bytesToHex(generateRandomBytes(6));
  const secret = bytesToHex(generateRandomBytes(16));
  const secretBytes = new TextEncoder().encode(secret);
  const keyHash = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes));
  const apiKey = `gk_live_${keyId}_${secret}`;

  const agent = await gatekeepRepo.createAgent({
    workspaceId: workspace.id,
    name: agentName,
    keyId,
    keyHash,
    environment: "live",
    allowedActions: ["*"],
    createdBySlackUserId: "CLI_ADMIN",
  });

  const baseUrl = Deno.env.get("GATEKEEP_PUBLIC_BASE_URL") ?? "https://gatekeep.bsuit.app";
  const mcpUrl = `${baseUrl.replace(/\/$/, "")}/mcp`;

  const mcpConfig = {
    mcpServers: {
      gatekeep: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    },
  };

  console.log("================================================================================");
  console.log("🛡️  GATEKEEP AGENT API KEY GENERATED");
  console.log("================================================================================");
  console.log(`Agent Name : ${agent.name}`);
  console.log(`Agent ID   : ${agent.id}`);
  console.log(`Key ID     : ${agent.key_id}`);
  console.log(`Workspace  : ${workspace.team_name} (${workspace.slack_team_id})`);
  console.log(`API Key    : ${apiKey}`);
  console.log("================================================================================");
  console.log("⚠️  SAVE THIS API KEY NOW. The secret cannot be retrieved from the database!");
  console.log("================================================================================");
  console.log("\n📁 Add to your project's .cursor/mcp.json (Cursor / Windsurf):");
  console.log(JSON.stringify(mcpConfig, null, 2));
  console.log("\n💻 Or add via Claude Code CLI:");
  console.log(`claude mcp add gatekeep ${mcpUrl} --header "Authorization: Bearer ${apiKey}"`);
  console.log("================================================================================");
}

if (import.meta.main) {
  await main();
  Deno.exit(0);
}
