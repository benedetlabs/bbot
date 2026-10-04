import { assertEquals } from "@std/assert";
import { app, getSigningSecret } from "./main.ts";
import { mauRepo, workspacesRepo } from "@suite/db";

async function createSignedHeaders(
  body: string,
  secret = getSigningSecret(),
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = `v0:${timestamp}:${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base) as unknown as BufferSource,
  );

  const hex = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    "x-slack-signature": `v0=${hex}`,
    "x-slack-request-timestamp": String(timestamp),
    "content-type": "application/x-www-form-urlencoded",
  };
}

Deno.test("queue-app: GET /healthz returns ok status", async () => {
  const req = new Request("http://localhost:8080/healthz");
  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.app, "queue-app");
});

Deno.test("queue-app: POST /slack/commands rejects unsigned requests", async () => {
  const req = new Request("http://localhost:8080/slack/commands", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "command=%2Fqueue&text=join",
  });
  const res = await app.fetch(req);
  assertEquals(res.status, 401);
});

Deno.test("queue-app: POST /slack/commands processes /queue command and triggers MAU tracking", async () => {
  let mauTracked = false;
  const origMau = mauRepo.recordUserInteraction;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;

  mauRepo.recordUserInteraction = ((params) => {
    if (params.appSlug === "queue" && params.slackUserId === "U555") {
      mauTracked = true;
    }
    return Promise.resolve({
      isFirstSeenThisMonth: true,
      totalActiveUsersInMonth: 1,
    });
  }) as typeof mauRepo.recordUserInteraction;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000001",
      slack_team_id: "T999",
      slack_enterprise_id: null,
      team_name: "testteam",
      plan_tier: "free",
      has_secret_audit_addon: false,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_status: "active",
      created_at: new Date(),
      updated_at: new Date(),
    });
  }) as typeof workspacesRepo.findBySlackTeamId;

  try {
    const body =
      "command=%2Fqueue&text=join%20staging-deploy&channel_id=C888&user_id=U555&team_id=T999";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);

    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("Queue Engine"), true);
    assertEquals(json.text.includes("staging-deploy"), true);
    // Allow promise tick
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(mauTracked, true);
  } finally {
    mauRepo.recordUserInteraction = origMau;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
  }
});
