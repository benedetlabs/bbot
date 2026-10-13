/**
 * @module @apps/secret-app
 * Production Hono server for Secret - The Zero-Knowledge Ephemeral Secret Sharing Slack App.
 */

import { Hono } from "hono";
import {
  createSplitSecret,
  decryptOAuthToken,
  importMasterKey,
  revealSplitSecret,
} from "@suite/crypto";
import {
  buildSecretActiveCard,
  buildSecretBurnedCard,
  buildSecretModal,
  buildSecretRevealedEphemeral,
  buildSecretRevealedModal,
  slackApi,
  slackModalClear,
  slackModalErrors,
  slackSignatureMiddleware,
} from "@suite/slack-kit";
import {
  installationsRepo,
  kv,
  mauRepo,
  secretAuditRepo,
  type SecretKVPayload,
  sqlWrite,
  workspacesRepo,
} from "@suite/db";
import { enqueueOutboxEvent } from "@suite/outbox";

export const app = new Hono();

export function getSigningSecret(): string {
  return Deno.env.get("SECRET_APP_SIGNING_SECRET") ??
    Deno.env.get("SLACK_SIGNING_SECRET") ??
    "dev_secret_signing_secret";
}

export function getMasterKeyHex(): string {
  return Deno.env.get("MASTER_ENCRYPTION_KEY_HEX") ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

// ----------------------------------------------------------------------------
// Health Check
// ----------------------------------------------------------------------------
app.get("/healthz", (c) => {
  return c.json({
    status: "ok",
    app: "secret-app",
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// Slack Slash Command: /secret
// ----------------------------------------------------------------------------
app.post(
  "/slack/commands",
  slackSignatureMiddleware(getSigningSecret),
  async (c) => {
    const formData = await c.req.parseBody();
    const command = String(formData["command"] ?? "");
    const triggerId = String(formData["trigger_id"] ?? "");
    const channelId = String(formData["channel_id"] ?? "");
    const text = String(formData["text"] ?? "").trim();
    const teamId = String(formData["team_id"] ?? "");
    const userId = String(formData["user_id"] ?? "");

    if (command !== "/secret") {
      return c.text("Unknown command", 400);
    }

    // Modal view specification
    const modalView = buildSecretModal({
      defaultChannelId: channelId,
      initialContext: text,
    });

    // Record MAU tracking asynchronously
    if (teamId && userId) {
      workspacesRepo.findBySlackTeamId(teamId).then(async (ws) => {
        const workspace = ws ?? await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: String(formData["team_domain"] ?? "Default Workspace"),
        });
        await mauRepo.recordUserInteraction({
          workspaceId: workspace.id,
          slackUserId: userId,
          appSlug: "secret",
        });
      }).catch((err) =>
        console.error("MAU tracking failed for /secret command:", err)
      );
    }

    // If trigger_id is present, open modal via Slack API asynchronously and return 200 immediately
    if (triggerId) {
      const botTokenPromise = (async () => {
        let token = Deno.env.get("SECRET_APP_BOT_TOKEN") ??
          Deno.env.get("SLACK_BOT_TOKEN");
        if (!token && teamId) {
          try {
            const install = await installationsRepo.findInstallation(
              teamId,
              "secret",
            );
            if (install?.installation.bot_access_token_enc) {
              const masterKey = await importMasterKey(getMasterKeyHex());
              token = await decryptOAuthToken(
                install.installation.bot_access_token_enc,
                masterKey,
              );
            }
          } catch (err) {
            console.error("Failed to query installation for views.open:", err);
          }
        }
        return token;
      })();

      // Fire modal open in background so Slack command responds well under 3000ms SLA
      (async () => {
        try {
          const token = await botTokenPromise;
          if (token) {
            const res = await slackApi.openView(token, triggerId, modalView);
            if (!res.ok) {
              console.error("Slack views.open returned error:", res.error);
            }
          } else {
            console.warn("No bot token available to open modal for /secret command");
          }
        } catch (err) {
          console.error("Failed to open modal via views.open in background:", err);
        }
      })();

      return c.body(null, 200);
    }

    // Return modal view for unit tests or clients when trigger_id is not provided
    return c.json({
      response_action: "open",
      view: modalView,
    });
  },
);

// ----------------------------------------------------------------------------
// Slack Interactive Components (Modals & Buttons)
// ----------------------------------------------------------------------------
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

    if (!payloadStr) {
      return c.text("Missing payload", 400);
    }

    const payload = JSON.parse(payloadStr);
    const type = payload.type;

    // 1. MODAL SUBMISSION: User submits secret in modal
    if (type === "view_submission") {
      const view = payload.view;
      const values = view.state?.values ?? {};
      const user = payload.user;
      const teamId = payload.team?.id ?? "T_DEFAULT";

      const secretContent =
        values["secret_content_block"]?.["secret_content_input"]?.value
          ?.trim() ?? "";
      const contextLabel =
        values["context_label_block"]?.["context_label_input"]?.value?.trim() ||
        undefined;
      const recipient =
        values["recipient_block"]?.["recipient_select"]?.selected_user || null;
      const rawTtl =
        values["ttl_block"]?.["ttl_select"]?.selected_option?.value ?? "3600";
      const parsedTtl = parseInt(rawTtl, 10);
      const ttlSeconds = isNaN(parsedTtl) || parsedTtl <= 0 ? 3600 : parsedTtl;

      const rawViews =
        values["views_block"]?.["views_select"]?.selected_option?.value ?? "1";
      const parsedViews = parseInt(rawViews, 10);
      const viewsLimit = isNaN(parsedViews) || parsedViews <= 0
        ? 1
        : parsedViews;

      // Validation
      if (!secretContent) {
        return c.json(
          slackModalErrors({
            secret_content_block: "Secret content cannot be empty.",
          }),
        );
      }
      if (secretContent.length > 100000) {
        return c.json(
          slackModalErrors({
            secret_content_block:
              "Secret content exceeds the maximum limit (100KB).",
          }),
        );
      }

      // Metadata from modal
      let channelId: string | null = null;
      try {
        if (view.private_metadata) {
          const meta = JSON.parse(view.private_metadata);
          channelId = meta.channelId ?? null;
        }
      } catch {
        // Ignore malformed metadata
      }

      // Find or upsert workspace
      let workspace = await workspacesRepo.findBySlackTeamId(teamId);
      if (!workspace) {
        workspace = await workspacesRepo.upsert({
          slackTeamId: teamId,
          teamName: payload.team?.domain ?? "Default Workspace",
        });
      }

      // Track MAU
      mauRepo.recordUserInteraction({
        workspaceId: workspace.id,
        slackUserId: user.id,
        appSlug: "secret",
      }).catch((err) => console.error("MAU record failed on submission:", err));

      // Cryptographic Split-Key Generation (Zero-Knowledge)
      const masterKey = await importMasterKey(getMasterKeyHex());
      const split = await createSplitSecret(secretContent, masterKey);

      // If workspace has audit add-on, record creation
      let auditLogId: string | undefined;
      if (workspace.has_secret_audit_addon) {
        try {
          const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
          auditLogId = await secretAuditRepo.recordCreated({
            workspaceId: workspace.id,
            secretEphemeralId: split.secretId,
            creatorSlackUserId: user.id,
            targetChannelId: channelId,
            allowedRecipientIds: recipient ? [recipient] : null,
            publicContextLabel: contextLabel,
            maxViews: viewsLimit,
            expiresAt,
          });
        } catch (auditErr) {
          console.error(
            "Failed to record audit log on secret creation:",
            auditErr,
          );
        }
      }

      // Store encrypted secret in UNLOGGED kv_store
      const kvPayload: SecretKVPayload = {
        ciphertextBase64: split.ciphertextBase64,
        ivBase64: split.ivBase64,
        encryptedServerKeyBase64: split.encryptedServerKeyBase64,
        serverKeyIvBase64: split.serverKeyIvBase64,
        creatorSlackId: user.id,
        allowedRecipients: recipient ? [recipient] : null,
        remainingViews: viewsLimit,
        contextLabel,
        channelId,
        workspaceId: workspace.id,
        auditLogId,
      };

      await kv.set(
        split.secretId,
        kvPayload as unknown as Record<string, unknown>,
        ttlSeconds,
      );

      // Build in-channel card
      const cardPayload = buildSecretActiveCard({
        creatorSlackId: user.id,
        secretId: split.secretId,
        clientKeyHex: split.clientKeyHex,
        contextLabel,
        allowedRecipientSlackId: recipient,
        ttlMinutes: Math.floor(ttlSeconds / 60),
        remainingViews: viewsLimit,
      });

      // If channel is known, enqueue outbox event to post the active card into the channel
      if (channelId) {
        await sqlWrite.begin(async (tx) => {
          await enqueueOutboxEvent(tx, {
            workspaceId: workspace!.id,
            appSource: "secret",
            eventType: "secret.post_active_card",
            payload: {
              channelId,
              secretId: split.secretId,
              messagePayload: cardPayload,
            },
          });
        }).catch((err) =>
          console.error("Failed to enqueue active card post:", err)
        );
      }

      // Close the modal
      return c.json(slackModalClear());
    }

    // 2. BLOCK ACTIONS: Reveal Secret or Revoke & Destroy
    if (type === "block_actions") {
      const actions = payload.actions ?? [];
      const action = actions[0];
      const user = payload.user;

      if (!action) return c.text("OK");

      // REVEAL SECRET
      if (action.action_id === "secret_reveal_click") {
        const rawValue = String(action.value ?? "");
        const [secretId, clientKeyHex] = rawValue.split(":");

        if (!secretId || !clientKeyHex) {
          return c.text("Invalid action payload", 400);
        }

        // Atomically burn or decrement view WITH PRE-AUTHORIZATION VALIDATION!
        // Prevents unauthorized users from consuming/burning someone else's secret.
        const stored = await kv.consumeMultiViewSecret<SecretKVPayload>(
          secretId,
          undefined,
          (payloadData) => {
            if (
              payloadData.allowedRecipients &&
              payloadData.allowedRecipients.length > 0 &&
              !payloadData.allowedRecipients.includes(user.id) &&
              payloadData.creatorSlackId !== user.id
            ) {
              return false; // Unauthorized! Do NOT burn or decrement views!
            }
            return true;
          },
        );

        if (!stored) {
          // Already burned, revoked, or expired!
          return c.json({
            response_type: "ephemeral",
            text:
              "🔒 *This secret has already been burned, revoked, or has expired.*",
          });
        }

        if (stored.notAllowed) {
          // Access denied without consuming secret
          return c.json({
            response_type: "ephemeral",
            text:
              "🚫 *Access Denied:* You are not the authorized recipient of this secret.",
          });
        }

        const payloadData = stored.value;

        // Track MAU for reader
        if (payloadData.workspaceId) {
          mauRepo.recordUserInteraction({
            workspaceId: payloadData.workspaceId,
            slackUserId: user.id,
            appSlug: "secret",
          }).catch((err) => console.error("MAU record failed on reveal:", err));
        }

        // Decrypt secret using Split-Key recombined in RAM
        const masterKey = await importMasterKey(getMasterKeyHex());
        let plaintext: string;
        try {
          plaintext = await revealSplitSecret(
            {
              ciphertextBase64: payloadData.ciphertextBase64,
              ivBase64: payloadData.ivBase64,
              encryptedServerKeyBase64: payloadData.encryptedServerKeyBase64,
              serverKeyIvBase64: payloadData.serverKeyIvBase64,
            },
            clientKeyHex,
            masterKey,
          );
        } catch (decryptErr) {
          console.error("Decryption failed:", decryptErr);
          return c.json({
            response_type: "ephemeral",
            text: "❌ *Failed to decrypt secret.* Integrity check failed.",
          });
        }

        const destroyedAtIso = new Date().toISOString();

        // If audit logging enabled, record viewed
        if (payloadData.auditLogId || payloadData.workspaceId) {
          secretAuditRepo.recordBurned({
            secretEphemeralId: secretId,
            viewerSlackUserId: user.id,
            status: "viewed",
          }).catch((err) =>
            console.error("Failed to record audit log on reveal:", err)
          );
        }

        // Determine messageTs and channelId from interaction container/message or payloadData
        const messageTs = payload.container?.message_ts ??
          payload.message?.ts ?? payloadData.messageTs;
        const channelId = payload.channel?.id ??
          payload.container?.channel_id ?? payloadData.channelId;

        // If completely burned (last view), trigger card update to State 3
        if (stored.burned) {
          const burnedCard = buildSecretBurnedCard({
            contextLabel: payloadData.contextLabel,
            viewerSlackId: user.id,
            burnedAtIso: destroyedAtIso,
            wasRevoked: false,
          });

          if (channelId && messageTs && payloadData.workspaceId) {
            await sqlWrite.begin(async (tx) => {
              await enqueueOutboxEvent(tx, {
                workspaceId: payloadData.workspaceId,
                appSource: "secret",
                eventType: "secret.burned_card_update",
                payload: {
                  channelId,
                  messageTs,
                  cardPayload: burnedCard,
                },
              });
            }).catch((err) =>
              console.error("Failed to enqueue burned card update:", err)
            );
          }
        }

        // Build decrypted modal view for the reader
        const revealedModal = buildSecretRevealedModal({
          plaintext,
          creatorSlackId: payloadData.creatorSlackId,
          destroyedAtIso,
          remainingViews: stored.remainingViews,
        });

        // Resolve Bot Token
        let botToken = Deno.env.get("SECRET_APP_BOT_TOKEN") ??
          Deno.env.get("SLACK_BOT_TOKEN");
        if (!botToken && payloadData.workspaceId) {
          try {
            const install = await installationsRepo.findByWorkspaceId(
              payloadData.workspaceId,
              "secret",
            );
            if (install?.installation.bot_access_token_enc) {
              botToken = await decryptOAuthToken(
                install.installation.bot_access_token_enc,
                masterKey,
              );
            }
          } catch (err) {
            console.error("Failed to resolve bot token for reveal modal:", err);
          }
        }

        let modalOpened = false;
        // 1. If trigger_id is present, attempt to open the modal
        if (payload.trigger_id && botToken) {
          try {
            const res = await slackApi.openView(
              botToken,
              payload.trigger_id,
              revealedModal,
            );
            if (res.ok) {
              modalOpened = true;
            } else {
              console.error("Slack views.open failed on reveal:", res.error);
            }
          } catch (err) {
            console.error("Failed to call views.open on reveal:", err);
          }
        }

        // 2. Fallback: If modal could not be opened (e.g. trigger_id expired or missing),
        // send the secret as an ephemeral message directly to the viewer in the channel so they NEVER lose the secret!
        if (!modalOpened) {
          const ephemeralPayload = buildSecretRevealedEphemeral({
            plaintext,
            creatorSlackId: payloadData.creatorSlackId,
            destroyedAtIso,
            remainingViews: stored.remainingViews,
          });

          if (botToken && channelId) {
            try {
              await slackApi.postEphemeral(
                botToken,
                channelId,
                user.id,
                ephemeralPayload,
              );
              return c.body(null, 200);
            } catch (err) {
              console.error("Failed to send ephemeral fallback on reveal:", err);
            }
          }

          // Return fallback response
          return c.json({
            response_action: "open",
            view: revealedModal,
            ...ephemeralPayload,
          });
        }

        return c.body(null, 200);
      }

      // REVOKE & DESTROY
      if (action.action_id === "secret_revoke_click") {
        const secretId = String(action.value ?? "");
        if (!secretId) {
          return c.text("Invalid secret ID", 400);
        }

        // Fetch secret to verify creator authorization
        const stored = await kv.get<SecretKVPayload>(secretId);
        if (!stored) {
          return c.json({
            response_type: "ephemeral",
            text: "🔒 *This secret has already been destroyed or has expired.*",
          });
        }

        // SECURITY CHECK: Only creator can revoke!
        if (stored.creatorSlackId !== user.id) {
          return c.json({
            response_type: "ephemeral",
            text:
              `🚫 *Access Denied:* Only the creator (<@${stored.creatorSlackId}>) can revoke this secret.`,
          });
        }

        // Atomically delete from kv_store
        await kv.delete(secretId);

        const burnedAtIso = new Date().toISOString();

        // Audit log
        if (stored.auditLogId || stored.workspaceId) {
          secretAuditRepo.recordBurned({
            secretEphemeralId: secretId,
            viewerSlackUserId: user.id,
            status: "revoked",
          }).catch((err) =>
            console.error("Failed to record audit log on revoke:", err)
          );
        }

        const burnedCard = buildSecretBurnedCard({
          contextLabel: stored.contextLabel,
          burnedAtIso,
          wasRevoked: true,
        });

        // Enqueue outbox update for the in-channel card
        const messageTs = payload.container?.message_ts ??
          payload.message?.ts ?? stored.messageTs;
        const channelId = payload.channel?.id ??
          payload.container?.channel_id ?? stored.channelId;
        if (channelId && messageTs && stored.workspaceId) {
          await sqlWrite.begin(async (tx) => {
            await enqueueOutboxEvent(tx, {
              workspaceId: stored.workspaceId,
              appSource: "secret",
              eventType: "secret.burned_card_update",
              payload: {
                channelId,
                messageTs,
                cardPayload: burnedCard,
              },
            });
          }).catch((err) =>
            console.error("Failed to enqueue revoke card update:", err)
          );
        }

        return c.json(burnedCard);
      }
    }

    return c.text("OK");
  },
);

export default app;

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") ?? "8080", 10);
  console.log(`Starting Secret App on port ${port}...`);
  Deno.serve({ port }, app.fetch);
}
