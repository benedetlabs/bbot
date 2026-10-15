/**
 * @module @apps/secret-app
 * Slack app that creates one-time secret links. The secret is not posted
 * back into Slack, and Slack messages are not deleted.
 */

import { Hono } from "hono";
import {
  bytesToHex,
  createSplitSecret,
  decryptOAuthToken,
  encryptOAuthToken,
  generateRandomBytes,
  importMasterKey,
  requireMasterKeyHex,
  revealSplitSecret,
} from "@suite/crypto";
import {
  buildSecretDirectMessage,
  buildSecretLinkReadyModal,
  buildSecretModal,
  requireNonEmptyEnv,
  slackApi,
  slackModalClear,
  slackModalErrors,
  slackModalUpdate,
  slackSignatureMiddleware,
} from "@suite/slack-kit";
import {
  installationsRepo,
  kv,
  mauRepo,
  secretAuditRepo,
  type SecretKVPayload,
  workspacesRepo,
} from "@suite/db";
import {
  installedPage,
  landingPage,
  linkUnavailablePage,
  oauthErrorPage,
  privacyPage,
  revealPage,
  supportPage,
  type LinkUnavailableReason,
} from "./pages.ts";

export const app = new Hono();

const BOT_SCOPES = "commands,chat:write,chat:write.public";

export function getSigningSecret(): string {
  return requireNonEmptyEnv("SECRET_APP_SIGNING_SECRET", [
    "SLACK_SIGNING_SECRET",
  ]);
}

export function getMasterKeyHex(): string {
  return requireMasterKeyHex();
}

export function publicBaseUrl(): string {
  const raw = Deno.env.get("SECRET_PUBLIC_BASE_URL")?.trim() ||
    "https://secret.bsuit.app";
  return raw.replace(/\/$/, "");
}

function secretLink(secretId: string, clientKeyHex: string): string {
  return `${publicBaseUrl()}/s/${secretId}#${clientKeyHex}`;
}

function linkStatusKey(secretId: string): string {
  return `link-status:${secretId}`;
}

function isDirectMessage(channelId: string, channelName: string): boolean {
  return channelId.startsWith("D") || channelName === "directmessage";
}

function directMessageResponseUrl(metadata: string | undefined): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as {
      directMessage?: boolean;
      responseUrl?: string | null;
    };
    const responseUrl = parsed.responseUrl ?? "";
    if (
      parsed.directMessage === true &&
      responseUrl.startsWith("https://hooks.slack.com/")
    ) {
      return responseUrl;
    }
  } catch {
    return null;
  }
  return null;
}

async function rememberLinkOutcome(
  secretId: string,
  status: "used" | "revoked",
): Promise<void> {
  await kv.set(linkStatusKey(secretId), { status }, 60 * 60 * 24 * 30);
}

async function linkVisitState(
  secretId: string,
): Promise<"active" | LinkUnavailableReason> {
  const row = await kv.lookup(secretId);
  if (row?.status === "active") return "active";
  if (row?.status === "expired") return "expired";
  const tombstone = await kv.get<{ status?: string }>(linkStatusKey(secretId));
  if (tombstone?.status === "used") return "used";
  if (tombstone?.status === "revoked") return "destroyed";
  return "missing";
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

async function resolveBotToken(teamId: string): Promise<string | null> {
  const envToken = Deno.env.get("SECRET_APP_BOT_TOKEN") ??
    Deno.env.get("SLACK_BOT_TOKEN");
  if (envToken) return envToken;
  if (!teamId) return null;
  const install = await installationsRepo.findInstallation(teamId, "secret");
  if (!install?.installation.bot_access_token_enc) return null;
  const masterKey = await importMasterKey(getMasterKeyHex());
  return await decryptOAuthToken(
    install.installation.bot_access_token_enc,
    masterKey,
  );
}

async function revokeInstallation(teamId: string): Promise<void> {
  const workspace = await workspacesRepo.findBySlackTeamId(teamId);
  await installationsRepo.deleteBySlackTeam(teamId, "secret");
  if (workspace) {
    await kv.deleteByWorkspaceId(workspace.id);
  }
}

app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "secret-app",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", () => html(landingPage()));
app.get("/privacy", () => html(privacyPage()));
app.get("/support", () => html(supportPage()));

app.get("/s/:id", async (c) => {
  const secretId = c.req.param("id");
  if (!/^[0-9a-fA-F-]{36}$/.test(secretId)) {
    return html(linkUnavailablePage("missing"), 404);
  }
  const state = await linkVisitState(secretId);
  if (state !== "active") {
    return html(linkUnavailablePage(state), state === "missing" ? 404 : 410);
  }
  return html(revealPage(secretId));
});

app.post("/s/:id/open", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const secretId = c.req.param("id");
  if (!/^[0-9a-fA-F-]{36}$/.test(secretId)) {
    return c.json({ error: "gone" }, 410);
  }

  let body: { clientKeyHex?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid" }, 400);
  }
  const clientKeyHex = String(body.clientKeyHex ?? "");
  if (!/^[0-9a-fA-F]{32}$/.test(clientKeyHex)) {
    return c.json({ error: "invalid" }, 400);
  }

  const peeked = await kv.get<SecretKVPayload>(secretId);
  if (!peeked) {
    const state = await linkVisitState(secretId);
    const reason: LinkUnavailableReason = state === "active"
      ? "missing"
      : state;
    return c.json({ error: "gone", reason }, 410);
  }

  let plaintext: string;
  try {
    const masterKey = await importMasterKey(getMasterKeyHex());
    plaintext = await revealSplitSecret(
      {
        ciphertextBase64: peeked.ciphertextBase64,
        ivBase64: peeked.ivBase64,
        encryptedServerKeyBase64: peeked.encryptedServerKeyBase64,
        serverKeyIvBase64: peeked.serverKeyIvBase64,
      },
      clientKeyHex,
      masterKey,
    );
  } catch {
    console.error("Link open failed integrity check");
    return c.json({ error: "invalid" }, 400);
  }

  const stored = await kv.consumeMultiViewSecret<SecretKVPayload>(secretId);
  if (!stored) {
    const state = await linkVisitState(secretId);
    const reason: LinkUnavailableReason = state === "active" ? "used" : state;
    return c.json({ error: "gone", reason }, 410);
  }
  if (stored.burned) {
    await rememberLinkOutcome(secretId, "used");
  }

  if (stored.value.auditLogId || stored.value.workspaceId) {
    secretAuditRepo.recordBurned({
      secretEphemeralId: secretId,
      viewerSlackUserId: "link",
      status: "viewed",
    }).catch((err) => console.error("Failed to record link open:", err));
  }
  return c.json({
    plaintext,
    remainingViews: stored.remainingViews,
    burned: stored.burned,
  });
});

app.get("/slack/install", async (c) => {
  const clientId = Deno.env.get("SECRET_APP_CLIENT_ID")?.trim() ?? "";
  if (!clientId) {
    return html(oauthErrorPage("OAuth client id is not configured."), 503);
  }
  const state = bytesToHex(generateRandomBytes(16));
  await kv.set(`oauth_state:${state}`, { purpose: "secret_install" }, 600);
  const redirectUri = `${publicBaseUrl()}/slack/oauth/callback`;
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", BOT_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/slack/oauth/callback", async (c) => {
  if (c.req.query("error")) {
    return html(oauthErrorPage("Slack did not authorize the install."), 400);
  }
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) {
    return html(oauthErrorPage("Missing OAuth code or state."), 400);
  }

  const stateKey = `oauth_state:${state}`;
  const saved = await kv.get<{ purpose?: string }>(stateKey);
  await kv.delete(stateKey);
  if (!saved || saved.purpose !== "secret_install") {
    return html(
      oauthErrorPage(
        "This install link expired. Start again from Add to Slack.",
      ),
      400,
    );
  }

  const clientId = Deno.env.get("SECRET_APP_CLIENT_ID")?.trim() ?? "";
  const clientSecret = Deno.env.get("SECRET_APP_CLIENT_SECRET")?.trim() ?? "";
  if (!clientId || !clientSecret) {
    return html(oauthErrorPage("OAuth client is not configured."), 503);
  }

  const redirectUri = `${publicBaseUrl()}/slack/oauth/callback`;
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await tokenResponse.json();
  if (!data.ok || !data.access_token || !data.team?.id || !data.bot_user_id) {
    return html(oauthErrorPage("Slack rejected the authorization code."), 400);
  }

  const masterKey = await importMasterKey(getMasterKeyHex());
  const tokenEnc = await encryptOAuthToken(
    String(data.access_token),
    masterKey,
  );
  const workspace = await workspacesRepo.upsert({
    slackTeamId: String(data.team.id),
    teamName: String(data.team.name ?? data.team.id),
    slackEnterpriseId: data.enterprise?.id ? String(data.enterprise.id) : null,
  });
  const scopes = String(data.scope ?? "")
    .split(",")
    .map((scope: string) => scope.trim())
    .filter(Boolean);
  await installationsRepo.upsert({
    workspaceId: workspace.id,
    appSlug: "secret",
    botUserId: String(data.bot_user_id),
    botAccessTokenEnc: tokenEnc,
    installedByUserId: String(data.authed_user?.id ?? data.bot_user_id),
    scopes,
  });
  return html(installedPage(String(data.team.name ?? data.team.id)));
});

app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const formData = await c.req.parseBody();
    const command = String(formData["command"] ?? "");
    const triggerId = String(formData["trigger_id"] ?? "");
    const channelId = String(formData["channel_id"] ?? "");
    const channelName = String(formData["channel_name"] ?? "");
    const text = String(formData["text"] ?? "").trim();
    const teamId = String(formData["team_id"] ?? "");
    const userId = String(formData["user_id"] ?? "");

    if (command !== "/secret") {
      return c.text("Unknown command", 400);
    }

    const directMessage = isDirectMessage(channelId, channelName);
    const modalView = buildSecretModal({
      defaultChannelId: channelId,
      directMessage,
      responseUrl: directMessage ? String(formData["response_url"] ?? "") : null,
      initialContent: text,
    });

    if (teamId && userId) {
      workspacesRepo.findBySlackTeamId(teamId).then(async (ws) => {
        const workspace = ws ?? await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: String(formData["team_domain"] ?? teamId),
        });
        await mauRepo.recordUserInteraction({
          workspaceId: workspace.id,
          slackUserId: userId,
          appSlug: "secret",
        });
      }).catch((err) => console.error("MAU tracking failed for /secret:", err));
    }

    if (triggerId) {
      const openModal = (async () => {
        try {
          const token = await resolveBotToken(teamId);
          if (!token) {
            console.warn("No bot token available to open /secret modal");
            return;
          }
          const res = await slackApi.openView(token, triggerId, modalView);
          if (!res.ok) {
            console.error("Slack views.open returned error:", res.error);
          }
        } catch (err) {
          console.error("Failed to open /secret modal:", err);
        }
      })();
      void openModal;
      return c.body(null, 200);
    }

    return c.json({
      response_action: "open",
      view: modalView,
    });
  },
);

app.post(
  "/slack/interactions",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    let payloadStr = "";
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const jsonBody = await c.req.json();
      payloadStr = typeof jsonBody.payload === "string"
        ? jsonBody.payload
        : JSON.stringify(jsonBody);
    } else {
      const body = await c.req.parseBody();
      payloadStr = String(body["payload"] ?? "");
    }
    if (!payloadStr) return c.text("Missing payload", 400);

    const payload = JSON.parse(payloadStr);
    const type = payload.type;

    if (type === "view_submission") {
      const view = payload.view;
      const values = view.state?.values ?? {};
      const user = payload.user;
      const teamId = payload.team?.id;
      if (!teamId) {
        return c.json(slackModalErrors({
          secret_content_block: "Missing Slack workspace.",
        }));
      }

      const secretContent =
        values["secret_content_block"]?.["secret_content_input"]?.value
          ?.trim() ?? "";
      const contextLabel =
        values["context_label_block"]?.["context_label_input"]?.value?.trim() ||
        undefined;
      const rawTtl =
        values["ttl_block"]?.["ttl_select"]?.selected_option?.value ?? "3600";
      const parsedTtl = parseInt(rawTtl, 10);
      const ttlSeconds = Number.isNaN(parsedTtl) || parsedTtl <= 0
        ? 3600
        : parsedTtl;
      const rawViews =
        values["views_block"]?.["views_select"]?.selected_option?.value ?? "1";
      const parsedViews = parseInt(rawViews, 10);
      const viewsLimit = Number.isNaN(parsedViews) || parsedViews <= 0
        ? 1
        : parsedViews;

      if (!secretContent) {
        return c.json(slackModalErrors({
          secret_content_block: "Secret content cannot be empty.",
        }));
      }
      if (secretContent.length > 100000) {
        return c.json(slackModalErrors({
          secret_content_block:
            "Secret content exceeds the maximum limit (100KB).",
        }));
      }

      let workspace = await workspacesRepo.findBySlackTeamId(teamId);
      if (!workspace) {
        workspace = await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: payload.team?.domain ?? teamId,
        });
      }

      mauRepo.recordUserInteraction({
        workspaceId: workspace.id,
        slackUserId: user.id,
        appSlug: "secret",
      }).catch((err) => console.error("MAU record failed on submission:", err));

      const masterKey = await importMasterKey(getMasterKeyHex());
      const split = await createSplitSecret(secretContent, masterKey);

      let auditLogId: string | undefined;
      if (workspace.has_secret_audit_addon) {
        try {
          auditLogId = await secretAuditRepo.recordCreated({
            workspaceId: workspace.id,
            secretEphemeralId: split.secretId,
            creatorSlackUserId: user.id,
            targetChannelId: null,
            allowedRecipientIds: null,
            publicContextLabel: contextLabel,
            maxViews: viewsLimit,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
          });
        } catch (auditErr) {
          console.error(
            "Failed to record audit log on link creation:",
            auditErr,
          );
        }
      }

      const kvPayload: SecretKVPayload = {
        ciphertextBase64: split.ciphertextBase64,
        ivBase64: split.ivBase64,
        encryptedServerKeyBase64: split.encryptedServerKeyBase64,
        serverKeyIvBase64: split.serverKeyIvBase64,
        creatorSlackId: user.id,
        allowedRecipients: null,
        remainingViews: viewsLimit,
        contextLabel,
        channelId: null,
        workspaceId: workspace.id,
        auditLogId,
      };
      await kv.set(
        split.secretId,
        kvPayload as unknown as Record<string, unknown>,
        ttlSeconds,
      );

      const linkUrl = secretLink(split.secretId, split.clientKeyHex);
      const responseUrl = directMessageResponseUrl(view.private_metadata);
      if (responseUrl) {
        const message = buildSecretDirectMessage({
          linkUrl,
          ttlMinutes: Math.floor(ttlSeconds / 60),
          remainingViews: viewsLimit,
          contextLabel,
        });
        // Slack gives this request 3 seconds. Waiting for the message to post
        // makes the modal show a connection error and stay open, so the next
        // click creates another link.
        fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            response_type: "in_channel",
            text: message.text,
            blocks: message.blocks,
          }),
        }).catch((err) =>
          console.error("Failed to send secret link in direct message:", err)
        );
        return c.json(slackModalClear());
      }

      return c.json(slackModalUpdate(buildSecretLinkReadyModal({
        linkUrl,
        secretId: split.secretId,
        ttlMinutes: Math.floor(ttlSeconds / 60),
        remainingViews: viewsLimit,
        contextLabel,
        postedInDirectMessage: false,
      })));
    }

    if (type === "block_actions") {
      const action = payload.actions?.[0];
      const user = payload.user;
      if (!action) return c.text("OK");

      if (action.action_id === "secret_reveal_click") {
        return c.json({
          response_type: "ephemeral",
          replace_original: false,
          text:
            "Open the one-time link in your browser. Secret does not reveal secrets inside Slack, and this message does not contain the secret.",
        });
      }

      if (action.action_id === "secret_revoke_click") {
        const secretId = String(action.value ?? "");
        if (!secretId) return c.text("Invalid secret ID", 400);

        const stored = await kv.get<SecretKVPayload>(secretId);
        if (!stored) {
          return c.json({
            response_type: "ephemeral",
            text: "This one-time link was already destroyed or it expired.",
          });
        }
        if (stored.creatorSlackId !== user.id) {
          return c.json({
            response_type: "ephemeral",
            text:
              `Only the creator (<@${stored.creatorSlackId}>) can destroy this link.`,
          });
        }

        await kv.delete(secretId);
        await rememberLinkOutcome(secretId, "revoked");
        if (stored.auditLogId || stored.workspaceId) {
          secretAuditRepo.recordBurned({
            secretEphemeralId: secretId,
            viewerSlackUserId: user.id,
            status: "revoked",
          }).catch((err) =>
            console.error("Failed to record link revoke:", err)
          );
        }
        return c.json({
          response_type: "ephemeral",
          text:
            "This one-time link has been destroyed. It can no longer be opened.",
        });
      }
    }

    return c.text("OK");
  },
);

app.post(
  "/slack/events",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const payload = await c.req.json();
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }
    if (payload.type === "event_callback") {
      const eventType = payload.event?.type;
      const teamId = String(payload.team_id ?? "");
      if (
        teamId &&
        (eventType === "app_uninstalled" || eventType === "tokens_revoked")
      ) {
        await revokeInstallation(teamId);
      }
    }
    return c.body(null, 200);
  },
);

export default app;

if (import.meta.main) {
  getSigningSecret();
  getMasterKeyHex();
  const port = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`Starting Secret App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
