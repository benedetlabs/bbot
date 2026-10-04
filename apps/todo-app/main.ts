/**
 * @module @apps/todo-app
 * Production Hono server for Todo - GTD Micro-Task Manager for Slack.
 */

import { Hono } from "hono";
import { slackSignatureMiddleware } from "@suite/slack-kit";
import { mauRepo, workspacesRepo } from "@suite/db";

export const app = new Hono();

export function getSigningSecret(): string {
  return Deno.env.get("TODO_APP_SIGNING_SECRET") ??
    Deno.env.get("SLACK_SIGNING_SECRET") ??
    "dev_todo_signing_secret";
}

app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "todo-app",
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const formData = await c.req.parseBody();
    const command = String(formData["command"] ?? "");
    const text = String(formData["text"] ?? "").trim();
    const channelId = String(formData["channel_id"] ?? "");
    const userId = String(formData["user_id"] ?? "");
    const teamId = String(formData["team_id"] ?? "");

    if (command !== "/todo") {
      return c.text("Unknown command", 400);
    }

    if (teamId && userId) {
      workspacesRepo.findBySlackTeamId(teamId).then(async (ws) => {
        const workspace = ws ?? await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: String(formData["team_domain"] ?? "Default Workspace"),
        });
        await mauRepo.recordUserInteraction({
          workspaceId: workspace.id,
          slackUserId: userId,
          appSlug: "todo",
        });
      }).catch((err) =>
        console.error("MAU tracking failed for /todo command:", err)
      );
    }

    return c.json({
      response_type: "ephemeral",
      text:
        `📋 *Todo Engine* received /todo ${text} in <#${channelId}> for <@${userId}>.`,
    });
  },
);

app.post(
  "/slack/interactions",
  slackSignatureMiddleware(getSigningSecret),
  (c) => {
    return c.text("OK");
  },
);

export default app;

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`Starting Todo App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
