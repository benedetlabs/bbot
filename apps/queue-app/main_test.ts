import { assertEquals } from "@std/assert";
import { app, extractSlackUserId, getSigningSecret } from "./main.ts";
import {
  type JoinQueueResult,
  mauRepo,
  type QueueRow,
  queuesRepo,
  workspacesRepo,
} from "@suite/db";
import { slackApi } from "@suite/slack-kit";

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

Deno.test("queue-app: extractSlackUserId helper", () => {
  assertEquals(extractSlackUserId("<@U12345|leonardo>"), "U12345");
  assertEquals(extractSlackUserId("<@U99999>"), "U99999");
  assertEquals(extractSlackUserId("<@U12345|john> AFK in meeting"), "U12345");
  assertEquals(extractSlackUserId("@U55555"), "U55555");
  assertEquals(extractSlackUserId("@U55555 went to lunch"), "U55555");
  assertEquals(extractSlackUserId("U77777"), "U77777");
  assertEquals(extractSlackUserId("U77777 AFK"), "U77777");
  assertEquals(extractSlackUserId(""), null);
});

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

Deno.test("queue-app: /queue help returns command guidance", async () => {
  const body =
    "command=%2Fqueue&text=help&channel_id=C100&user_id=U10&team_id=T1";
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
  assertEquals(json.text.includes("Queue Commands:"), true);
  assertEquals(json.text.includes("/queue join"), true);
});

Deno.test("queue-app: /queue status returns live queue card and triggers MAU", async () => {
  let mauTracked = false;
  const origMau = mauRepo.recordUserInteraction;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetQueueState = queuesRepo.getQueueState;

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

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    slack_channel_id: "C888",
    name: "staging-deploy",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: null,
    admin_user_ids: [],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve(mockQueue);
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: mockQueue,
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    const body =
      "command=%2Fqueue&text=status&channel_id=C888&channel_name=staging-deploy&user_id=U555&team_id=T999";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);

    const json = await res.json();
    assertEquals(json.response_type, "in_channel");
    assertEquals(json.blocks.length >= 2, true);

    await new Promise((r) => setTimeout(r, 10));
    assertEquals(mauTracked, true);
  } finally {
    mauRepo.recordUserInteraction = origMau;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
  }
});

Deno.test("queue-app: /queue join acquired vs waiting vs duplicate", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetQueueState = queuesRepo.getQueueState;
  const origJoin = queuesRepo.joinQueue;

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    slack_channel_id: "C888",
    name: "staging-deploy",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: [],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve(mockQueue);
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: mockQueue,
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    // 1. Join and acquire
    queuesRepo.joinQueue = (() => {
      return Promise.resolve({
        status: "acquired",
        entry: {
          id: "entry-1",
          queue_id: "queue-1",
          slack_user_id: "U1",
          status: "active",
          reason_note: "Fix bug",
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(),
          completed_at: null,
        },
        isPromoted: true,
      } as JoinQueueResult);
    }) as typeof queuesRepo.joinQueue;

    const bodyAcquired =
      "command=%2Fqueue&text=join%20Fix%20bug&channel_id=C888&user_id=U1&team_id=T1";
    const headersAcquired = await createSignedHeaders(bodyAcquired);

    const req1 = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers: headersAcquired,
      body: bodyAcquired,
    });

    const res1 = await app.fetch(req1);
    const json1 = await res1.json();
    assertEquals(json1.response_type, "ephemeral");
    assertEquals(json1.text.includes("You acquired the active lock"), true);

    // 2. Join and wait in line
    queuesRepo.joinQueue = (() => {
      return Promise.resolve({
        status: "waiting",
        entry: {
          id: "entry-2",
          queue_id: "queue-1",
          slack_user_id: "U2",
          status: "waiting",
          reason_note: null,
          joined_at: new Date(),
          activated_at: null,
          expires_at: null,
          completed_at: null,
        },
        position: 2,
      } as JoinQueueResult);
    }) as typeof queuesRepo.joinQueue;

    const bodyWait =
      "command=%2Fqueue&text=join&channel_id=C888&user_id=U2&team_id=T1";
    const headersWait = await createSignedHeaders(bodyWait);

    const req2 = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers: headersWait,
      body: bodyWait,
    });

    const res2 = await app.fetch(req2);
    const json2 = await res2.json();
    assertEquals(json2.response_type, "ephemeral");
    assertEquals(json2.text.includes("You are #2 in line"), true);

    // 3. Already in queue
    queuesRepo.joinQueue = (() => {
      return Promise.resolve({
        status: "already_in_queue",
        entry: {
          id: "entry-1",
          queue_id: "queue-1",
          slack_user_id: "U1",
          status: "active",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(),
          completed_at: null,
        },
      } as JoinQueueResult);
    }) as typeof queuesRepo.joinQueue;

    const bodyDup =
      "command=%2Fqueue&text=join&channel_id=C888&user_id=U1&team_id=T1";
    const headersDup = await createSignedHeaders(bodyDup);

    const req3 = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers: headersDup,
      body: bodyDup,
    });

    const res3 = await app.fetch(req3);
    const json3 = await res3.json();
    assertEquals(json3.response_type, "ephemeral");
    assertEquals(json3.text.includes("already in the queue"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.joinQueue = origJoin;
  }
});

Deno.test("queue-app: /queue done releases lock and promotes next waiter", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetQueueState = queuesRepo.getQueueState;
  const origRelease = queuesRepo.releaseLock;

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    slack_channel_id: "C888",
    name: "staging-deploy",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: [],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve(mockQueue);
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: mockQueue,
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    queuesRepo.releaseLock = (() => {
      return Promise.resolve({
        status: "released",
        releasedEntry: {
          id: "entry-1",
          queue_id: "queue-1",
          slack_user_id: "U1",
          status: "released",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(),
          completed_at: new Date(),
        },
        promotedEntry: {
          id: "entry-2",
          queue_id: "queue-1",
          slack_user_id: "U2",
          status: "active",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(),
          completed_at: null,
        },
      });
    }) as typeof queuesRepo.releaseLock;

    const body =
      "command=%2Fqueue&text=done&channel_id=C888&user_id=U1&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("You released your lock"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.releaseLock = origRelease;
  }
});

Deno.test("queue-app: /queue extend extends hold time", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetQueueState = queuesRepo.getQueueState;
  const origExtend = queuesRepo.extendLock;

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    slack_channel_id: "C888",
    name: "staging-deploy",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: [],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve(mockQueue);
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: mockQueue,
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    queuesRepo.extendLock = (() => {
      return Promise.resolve({
        status: "extended",
        addedMinutes: 15,
        newExpiresAt: new Date(Date.now() + 60 * 60000),
      });
    }) as typeof queuesRepo.extendLock;

    const body =
      "command=%2Fqueue&text=extend%2015&channel_id=C888&channel_name=staging-deploy&user_id=U1&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("Extended your active hold on #staging-deploy by +15m"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.extendLock = origExtend;
  }
});

Deno.test("queue-app: /queue kick target user", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetQueueState = queuesRepo.getQueueState;
  const origKick = queuesRepo.kickUser;

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "00000000-0000-0000-0000-000000000001",
    slack_channel_id: "C888",
    name: "staging-deploy",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: ["U_ADMIN"],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve(mockQueue);
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: mockQueue,
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  try {
    queuesRepo.kickUser = ((params) => {
      assertEquals(params.targetSlackUserId, "U_BAD");
      return Promise.resolve({
        status: "kicked_active",
        kickedEntry: {
          id: "entry-bad",
          queue_id: "queue-1",
          slack_user_id: "U_BAD",
          status: "kicked",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(),
          completed_at: new Date(),
        },
        promotedEntry: null,
      });
    }) as typeof queuesRepo.kickUser;

    const body =
      "command=%2Fqueue&text=kick%20%3C%40U_BAD%7Cbaduser%3E&channel_id=C888&channel_name=staging-deploy&user_id=U_ADMIN&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("<@U_BAD> was removed from active slot in #staging-deploy"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.kickUser = origKick;
  }
});

Deno.test("queue-app: interactions block action queue_attach_secret_click opens modal", async () => {
  let viewOpenCalled = false;
  const origOpenView = slackApi.openView;
  const origGetQueueById = queuesRepo.getQueueById;
  slackApi.openView = (_token, triggerId, view) => {
    viewOpenCalled = true;
    assertEquals(triggerId, "trig-999");
    assertEquals(view.callback_id, "secret_create_modal");
    return Promise.resolve({ ok: true });
  };

  queuesRepo.getQueueById = ((id) => {
    return Promise.resolve({
      id,
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: [],
      allow_secret: true,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  const origFindWs = workspacesRepo.findBySlackTeamId;
  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
      slack_enterprise_id: null,
      team_name: "benedet",
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
    const payload = {
      type: "block_actions",
      trigger_id: "trig-999",
      team: { id: "T1", domain: "benedet" },
      user: { id: "U1" },
      channel: { id: "C100" },
      actions: [
        {
          action_id: "queue_attach_secret_click",
          value: "queue-1",
        },
      ],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);

    const json = await res.json();
    assertEquals(json.response_action, "open");
    assertEquals(json.view.callback_id, "secret_create_modal");
    assertEquals(viewOpenCalled, true);
  } finally {
    slackApi.openView = origOpenView;
    queuesRepo.getQueueById = origGetQueueById;
    workspacesRepo.findBySlackTeamId = origFindWs;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: in-place chat.update vs chat.postMessage sticky card sync", async () => {
  let updateCalled = false;
  let postCalled = false;
  let savedTs = "";

  const origUpdate = slackApi.updateMessage;
  const origPost = slackApi.postMessage;
  const origUpdateTs = queuesRepo.updateStickyMessageTs;
  const origGetQueueState = queuesRepo.getQueueState;
  const origGetQueueById = queuesRepo.getQueueById;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origJoin = queuesRepo.joinQueue;

  slackApi.updateMessage = (_token, channelId, ts) => {
    updateCalled = true;
    assertEquals(channelId, "C100");
    assertEquals(ts, "1700000000.999");
    return Promise.resolve({ ok: true });
  };

  slackApi.postMessage = (_token, recipient) => {
    if (recipient === "C100") {
      postCalled = true;
      return Promise.resolve({ ok: true, ts: "1700000000.888" });
    }
    return Promise.resolve({ ok: true });
  };

  queuesRepo.updateStickyMessageTs = (_queueId, ts) => {
    savedTs = ts ?? "";
    return Promise.resolve();
  };

  queuesRepo.getQueueById = ((id) => {
    return Promise.resolve({
      id,
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: [],
      allow_secret: false,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
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

  queuesRepo.joinQueue = (() => {
    return Promise.resolve({
      status: "acquired",
      entry: {
        id: "entry-1",
        queue_id: "queue-1",
        slack_user_id: "U1",
        status: "active",
        reason_note: null,
        joined_at: new Date(),
        activated_at: new Date(),
        expires_at: new Date(),
        completed_at: null,
      },
    } as JoinQueueResult);
  }) as typeof queuesRepo.joinQueue;

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    // 1. Existing sticky ts -> updateMessage called in place!
    queuesRepo.getQueueState = (() => {
      return Promise.resolve({
        queue: {
          id: "queue-1",
          workspace_id: "ws-1",
          slack_channel_id: "C100",
          name: "staging",
          max_concurrency: 1,
          max_hold_minutes: 45,
          sticky_message_ts: "1700000000.999",
          admin_user_ids: [],
          allow_secret: false,
          created_at: new Date(),
        },
        activeHolders: [],
        waitingLine: [],
      });
    }) as typeof queuesRepo.getQueueState;

    const payloadUpdate = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C100" },
      actions: [{ action_id: "queue_join_click", value: "queue-1" }],
    };

    const bodyUpdate = `payload=${
      encodeURIComponent(JSON.stringify(payloadUpdate))
    }`;
    const headersUpdate = await createSignedHeaders(bodyUpdate);

    const req1 = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headersUpdate,
      body: bodyUpdate,
    });

    const res1 = await app.fetch(req1);
    assertEquals(res1.status, 200);
    assertEquals(updateCalled, true);
    assertEquals(postCalled, false);

    // 2. Missing sticky ts -> postMessage called and ts stored!
    queuesRepo.getQueueState = (() => {
      return Promise.resolve({
        queue: {
          id: "queue-1",
          workspace_id: "ws-1",
          slack_channel_id: "C100",
          name: "staging",
          max_concurrency: 1,
          max_hold_minutes: 45,
          sticky_message_ts: null,
          admin_user_ids: [],
          allow_secret: false,
          created_at: new Date(),
        },
        activeHolders: [],
        waitingLine: [],
      });
    }) as typeof queuesRepo.getQueueState;

    const payloadPost = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C100" },
      actions: [{ action_id: "queue_join_click", value: "queue-1" }],
    };

    const bodyPost = `payload=${
      encodeURIComponent(JSON.stringify(payloadPost))
    }`;
    const headersPost = await createSignedHeaders(bodyPost);

    const req2 = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headersPost,
      body: bodyPost,
    });

    const res2 = await app.fetch(req2);
    assertEquals(res2.status, 200);
    assertEquals(postCalled, true);
    assertEquals(savedTs, "1700000000.888");
  } finally {
    slackApi.updateMessage = origUpdate;
    slackApi.postMessage = origPost;
    queuesRepo.updateStickyMessageTs = origUpdateTs;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.getQueueById = origGetQueueById;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    queuesRepo.joinQueue = origJoin;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: /queue unknown subcommand returns ephemeral warning", async () => {
  const body =
    "command=%2Fqueue&text=invalidcmd&channel_id=C100&user_id=U10&team_id=T1";
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
  assertEquals(json.text.includes("Unknown subcommand `invalidcmd`"), true);
});

Deno.test("queue-app: interactions block action resolves queue by UUID", async () => {
  let doneCalledWithQueueId = "";
  const origRelease = queuesRepo.releaseLock;
  const origGetQueueById = queuesRepo.getQueueById;
  const origGetQueueState = queuesRepo.getQueueState;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;

  const testUuid = "a4387d81-8178-43f1-b9fa-f27318db9e01";

  queuesRepo.getQueueById = ((id) => {
    if (id === testUuid) {
      return Promise.resolve({
        id: testUuid,
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging-deploy",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: [],
        allow_secret: false,
        created_at: new Date(),
      });
    }
    return Promise.resolve(null);
  }) as typeof queuesRepo.getQueueById;

  queuesRepo.getQueueState = ((queueId) => {
    return Promise.resolve({
      queue: {
        id: queueId,
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging-deploy",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: [],
        allow_secret: false,
        created_at: new Date(),
      },
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
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

  queuesRepo.releaseLock = ((params) => {
    doneCalledWithQueueId = params.queueId;
    return Promise.resolve({ status: "released", promotedEntry: null });
  }) as typeof queuesRepo.releaseLock;

  try {
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C100" },
      actions: [{ action_id: "queue_done_click", value: testUuid }],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(doneCalledWithQueueId, testUuid);
  } finally {
    queuesRepo.releaseLock = origRelease;
    queuesRepo.getQueueById = origGetQueueById;
    queuesRepo.getQueueState = origGetQueueState;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
  }
});

Deno.test("queue-app: non-admin is forbidden from running /queue kick", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "ws-1",
    slack_channel_id: "C888",
    name: "staging",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: ["U_ADMIN_ONLY"],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => Promise.resolve(mockQueue)) as typeof queuesRepo.findOrCreateQueue;

  try {
    const body =
      "command=%2Fqueue&text=kick%20%3C%40U_VICTIM%3E&channel_id=C888&user_id=U_REGULAR_USER&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("Only queue administrators are allowed to kick users"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
  }
});

Deno.test("queue-app: non-admin is forbidden from running /queue config", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "ws-1",
    slack_channel_id: "C888",
    name: "staging",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: ["U_ADMIN_ONLY"],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => Promise.resolve(mockQueue)) as typeof queuesRepo.findOrCreateQueue;

  try {
    const body =
      "command=%2Fqueue&text=config&channel_id=C888&user_id=U_REGULAR_USER&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(json.text.includes("Only queue administrators are allowed to configure queue settings"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
  }
});

Deno.test("queue-app: admin can open config modal via /queue config", async () => {
  let openViewCalled = false;
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origOpenView = slackApi.openView;

  const mockQueue: QueueRow = {
    id: "queue-1",
    workspace_id: "ws-1",
    slack_channel_id: "C888",
    name: "staging",
    max_concurrency: 1,
    max_hold_minutes: 45,
    sticky_message_ts: "1700000000.000100",
    admin_user_ids: ["U_ADMIN"],
    allow_secret: false,
    created_at: new Date(),
  };

  queuesRepo.findOrCreateQueue = (() => Promise.resolve(mockQueue)) as typeof queuesRepo.findOrCreateQueue;
  slackApi.openView = (_token, triggerId, view) => {
    openViewCalled = true;
    assertEquals(triggerId, "trig-config");
    assertEquals(view.callback_id, "queue_config_modal");
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const body =
      "command=%2Fqueue&text=config&channel_id=C888&user_id=U_ADMIN&team_id=T1&trigger_id=trig-config";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "ephemeral");
    assertEquals(openViewCalled, true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    slackApi.openView = origOpenView;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: queue_config_modal submission updates queue configuration", async () => {
  let updatedConfig: Record<string, unknown> | null = null;
  const origUpdateConfig = queuesRepo.updateQueueConfig;
  const origGetQueueState = queuesRepo.getQueueState;
  const origUpdateMsg = slackApi.updateMessage;

  queuesRepo.updateQueueConfig = (params) => {
    updatedConfig = params as unknown as Record<string, unknown>;
    return Promise.resolve({
      id: params.queueId,
      workspace_id: "ws-1",
      slack_channel_id: "C888",
      name: params.name ?? "staging",
      max_concurrency: params.maxConcurrency ?? 2,
      max_hold_minutes: params.maxHoldMinutes ?? 60,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: params.adminUserIds ?? ["U_ADMIN"],
      allow_secret: params.allowSecret ?? true,
      created_at: new Date(),
    });
  };

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C888",
        name: "staging-renamed",
        max_concurrency: 2,
        max_hold_minutes: 60,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U_ADMIN", "U_LEO"],
        allow_secret: true,
        created_at: new Date(),
      },
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  slackApi.updateMessage = () => Promise.resolve({ ok: true });

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U_ADMIN" },
      view: {
        callback_id: "queue_config_modal",
        private_metadata: JSON.stringify({ queueId: "queue-1", channelId: "C888" }),
        state: {
          values: {
            queue_name_block: { queue_name_input: { value: "staging-renamed" } },
            max_concurrency_block: {
              max_concurrency_input: { selected_option: { value: "3" } },
            },
            max_hold_minutes_block: {
              max_hold_minutes_input: { selected_option: { value: "60" } },
            },
            allow_secret_block: {
              allow_secret_input: { selected_options: [{ value: "allow_secret" }] },
            },
            admin_users_block: {
              admin_users_input: { selected_users: ["U_ADMIN", "U_LEO"] },
            },
          },
        },
      },
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.response_action, "clear");

    const cfg = updatedConfig as unknown as Record<string, unknown>;
    assertEquals(cfg?.name, "staging-renamed");
    assertEquals(cfg?.maxConcurrency, 3);
    assertEquals(cfg?.maxHoldMinutes, 60);
    assertEquals(cfg?.allowSecret, true);
  } finally {
    queuesRepo.updateQueueConfig = origUpdateConfig;
    queuesRepo.getQueueState = origGetQueueState;
    slackApi.updateMessage = origUpdateMsg;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: queue_attach_secret_click blocked when allow_secret is false", async () => {
  let ephemeralPosted = false;
  const origGetQueueById = queuesRepo.getQueueById;
  const origPostEphemeral = slackApi.postEphemeral;

  queuesRepo.getQueueById = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: [],
      allow_secret: false, // Disallowed
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  slackApi.postEphemeral = (_token, _channel, _user, msg) => {
    ephemeralPosted = true;
    assertEquals(msg.text?.includes("disabled"), true);
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "block_actions",
      trigger_id: "trig-secret",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C100" },
      actions: [{ action_id: "queue_attach_secret_click", value: "queue-1" }],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(ephemeralPosted, true);
  } finally {
    queuesRepo.getQueueById = origGetQueueById;
    slackApi.postEphemeral = origPostEphemeral;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: /queue remove by non-admin is forbidden", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U_ADMIN"], // Non-admin user cannot delete
      allow_secret: false,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.findOrCreateQueue;

  try {
    const body =
      "command=%2Fqueue&text=remove&channel_id=C100&user_id=U_REGULAR&team_id=T1";
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
    assertEquals(json.text.includes("Only queue administrators are allowed to remove or terminate the queue"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
  }
});

Deno.test("queue-app: /queue remove by admin deletes sticky message and queue from db", async () => {
  let stickyDeleted = false;
  let queueDeleted = false;
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origDeleteQueue = queuesRepo.deleteQueue;
  const origDeleteMsg = slackApi.deleteMessage;

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U_ADMIN"],
      allow_secret: false,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.deleteQueue = ((params) => {
    queueDeleted = true;
    assertEquals(params.queueId, "queue-1");
    return Promise.resolve({} as QueueRow);
  }) as typeof queuesRepo.deleteQueue;

  slackApi.deleteMessage = ((_token, channelId, ts) => {
    stickyDeleted = true;
    assertEquals(channelId, "C100");
    assertEquals(ts, "1700000000.999");
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.deleteMessage;

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const body =
      "command=%2Fqueue&text=delete&channel_id=C100&channel_name=staging&user_id=U_ADMIN&team_id=T1";
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
    assertEquals(json.text.includes("Queue for #staging has been removed"), true);
    assertEquals(stickyDeleted, true);
    assertEquals(queueDeleted, true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.deleteQueue = origDeleteQueue;
    slackApi.deleteMessage = origDeleteMsg;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: queue_delete_confirm_modal view_submission deletes queue and posts announcement", async () => {
  let queueDeleted = false;
  let announcementPosted = false;
  const origGetQueueById = queuesRepo.getQueueById;
  const origDeleteQueue = queuesRepo.deleteQueue;
  const origDeleteMsg = slackApi.deleteMessage;
  const origPostMsg = slackApi.postMessage;

  queuesRepo.getQueueById = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U_ADMIN"],
      allow_secret: false,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  queuesRepo.deleteQueue = ((params) => {
    queueDeleted = true;
    assertEquals(params.queueId, "queue-1");
    return Promise.resolve({} as QueueRow);
  }) as typeof queuesRepo.deleteQueue;

  slackApi.deleteMessage = () => Promise.resolve({ ok: true });
  slackApi.postMessage = (_token, channelId, msg) => {
    announcementPosted = true;
    assertEquals(channelId, "C100");
    assertEquals(msg.text?.includes("removed the queue for #staging"), true);
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U_ADMIN" },
      view: {
        callback_id: "queue_delete_confirm_modal",
        private_metadata: JSON.stringify({
          queueId: "queue-1",
          channelId: "C100",
          channelName: "staging",
        }),
      },
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.response_action, "clear");
    assertEquals(queueDeleted, true);
    assertEquals(announcementPosted, true);
  } finally {
    queuesRepo.getQueueById = origGetQueueById;
    queuesRepo.deleteQueue = origDeleteQueue;
    slackApi.deleteMessage = origDeleteMsg;
    slackApi.postMessage = origPostMsg;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: /queue stats returns ephemeral analytics summary", async () => {
  const origFindQueue = queuesRepo.findOrCreateQueue;
  const origGetStats = queuesRepo.getQueueStats;

  queuesRepo.findOrCreateQueue = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U_ADMIN"],
      allow_secret: false,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.findOrCreateQueue;

  queuesRepo.getQueueStats = (() => {
    return Promise.resolve({
      totalEntries: 25,
      completedHolds: 20,
      autoExpiredHolds: 2,
      kickedHolds: 1,
      avgHoldMinutes: 28,
      avgWaitMinutes: 8,
      activeHoldersCount: 1,
      waitingLineCount: 2,
      topUsers: [{ userId: "U10", holdCount: 12 }],
    });
  }) as typeof queuesRepo.getQueueStats;

  try {
    const body =
      "command=%2Fqueue&text=stats&channel_id=C100&channel_name=staging&user_id=U_ADMIN&team_id=T1";
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
    assertEquals(json.text.includes("Queue Analytics for #staging"), true);
    assertEquals(json.text.includes("Active Holds: *1*"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueStats = origGetStats;
  }
});

Deno.test("queue-app: queue_my_actions_click posts ephemeral private controls", async () => {
  let ephemeralPosted = false;
  let ephemeralPayload: unknown = null;
  const origGetQueueById = queuesRepo.getQueueById;
  const origGetQueueState = queuesRepo.getQueueState;
  const origPostEphemeral = slackApi.postEphemeral;

  queuesRepo.getQueueById = (() => {
    return Promise.resolve({
      id: "queue-1",
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U_ADMIN"],
      allow_secret: true,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U_ADMIN"],
        allow_secret: true,
        created_at: new Date(),
      },
      activeHolders: [
        {
          id: "e-1",
          queue_id: "queue-1",
          slack_user_id: "U_ADMIN",
          status: "active",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(Date.now() + 30 * 60000),
          completed_at: null,
        },
      ],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  slackApi.postEphemeral = (_token, channelId, userId, msg) => {
    ephemeralPosted = true;
    ephemeralPayload = msg;
    assertEquals(channelId, "C100");
    assertEquals(userId, "U_ADMIN");
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U_ADMIN" },
      channel: { id: "C100" },
      actions: [{ action_id: "queue_my_actions_click", value: "queue-1" }],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(ephemeralPosted, true);
    const p = ephemeralPayload as { text?: string; blocks?: unknown[] };
    assertEquals(p.text?.includes("Queue controls for #staging"), true);
  } finally {
    queuesRepo.getQueueById = origGetQueueById;
    queuesRepo.getQueueState = origGetQueueState;
    slackApi.postEphemeral = origPostEphemeral;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: queue_actions_select dropdown routes extend and updates card silently", async () => {
  let extendCalled = false;
  let updateCalled = false;

  const origGetQueueById = queuesRepo.getQueueById;
  const origExtendLock = queuesRepo.extendLock;
  const origGetQueueState = queuesRepo.getQueueState;
  const origUpdateMessage = slackApi.updateMessage;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
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

  queuesRepo.getQueueById = ((id) => {
    return Promise.resolve({
      id,
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U10"],
      allow_secret: true,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U10"],
        allow_secret: true,
        created_at: new Date(),
      },
      activeHolders: [
        {
          id: "e-1",
          queue_id: "queue-1",
          slack_user_id: "U10",
          status: "active",
          reason_note: null,
          joined_at: new Date(),
          activated_at: new Date(),
          expires_at: new Date(Date.now() + 45 * 60000),
          completed_at: null,
        },
      ],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  queuesRepo.extendLock = ((params) => {
    extendCalled = true;
    assertEquals(params.queueId, "queue-1");
    assertEquals(params.slackUserId, "U10");
    assertEquals(params.extraMinutes, 15);
    return Promise.resolve({ status: "extended" });
  }) as typeof queuesRepo.extendLock;

  slackApi.updateMessage = (_token, channelId, ts) => {
    updateCalled = true;
    assertEquals(channelId, "C100");
    assertEquals(ts, "1700000000.999");
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U10" },
      channel: { id: "C100" },
      actions: [
        {
          action_id: "queue_actions_select",
          selected_option: {
            value: "extend:queue-1",
            text: { type: "plain_text", text: "⏱️ Extend +15m" },
          },
        },
      ],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "OK");
    assertEquals(extendCalled, true);
    assertEquals(updateCalled, true);
  } finally {
    queuesRepo.getQueueById = origGetQueueById;
    queuesRepo.extendLock = origExtendLock;
    queuesRepo.getQueueState = origGetQueueState;
    slackApi.updateMessage = origUpdateMessage;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: queue_done_click releases active slot and notifies next in line via DM", async () => {
  let releaseCalled = false;
  let updateCalled = false;
  let promoDmSent = false;
  let promoRecipient = "";

  const origGetQueueById = queuesRepo.getQueueById;
  const origReleaseLock = queuesRepo.releaseLock;
  const origGetQueueState = queuesRepo.getQueueState;
  const origUpdateMessage = slackApi.updateMessage;
  const origPostMessage = slackApi.postMessage;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
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

  queuesRepo.getQueueById = ((id) => {
    return Promise.resolve({
      id,
      workspace_id: "ws-1",
      slack_channel_id: "C100",
      name: "staging",
      max_concurrency: 1,
      max_hold_minutes: 45,
      sticky_message_ts: "1700000000.999",
      admin_user_ids: ["U10"],
      allow_secret: true,
      created_at: new Date(),
    });
  }) as typeof queuesRepo.getQueueById;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U10"],
        allow_secret: true,
        created_at: new Date(),
      },
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  queuesRepo.releaseLock = ((params) => {
    releaseCalled = true;
    assertEquals(params.queueId, "queue-1");
    assertEquals(params.slackUserId, "U10");
    return Promise.resolve({
      status: "released",
      releasedEntry: {
        id: "e-1",
        queue_id: "queue-1",
        slack_user_id: "U10",
        status: "released",
        reason_note: null,
        joined_at: new Date(),
        activated_at: new Date(),
        expires_at: new Date(),
        completed_at: new Date(),
      },
      promotedEntry: {
        id: "e-2",
        queue_id: "queue-1",
        slack_user_id: "U20",
        status: "active",
        reason_note: null,
        joined_at: new Date(),
        activated_at: new Date(),
        expires_at: new Date(Date.now() + 45 * 60000),
        completed_at: null,
      },
    });
  }) as typeof queuesRepo.releaseLock;

  slackApi.updateMessage = (_token, channelId, ts) => {
    updateCalled = true;
    assertEquals(channelId, "C100");
    assertEquals(ts, "1700000000.999");
    return Promise.resolve({ ok: true });
  };

  slackApi.postMessage = (_token, recipient) => {
    promoDmSent = true;
    promoRecipient = recipient;
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U10" },
      channel: { id: "C100" },
      actions: [
        {
          action_id: "queue_done_click",
          value: "queue-1",
        },
      ],
    };

    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "OK");
    assertEquals(releaseCalled, true);
    assertEquals(updateCalled, true);
    assertEquals(promoDmSent, true);
    assertEquals(promoRecipient, "U20");
  } finally {
    queuesRepo.getQueueById = origGetQueueById;
    queuesRepo.releaseLock = origReleaseLock;
    queuesRepo.getQueueState = origGetQueueState;
    slackApi.updateMessage = origUpdateMessage;
    slackApi.postMessage = origPostMessage;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

Deno.test("queue-app: events /slack/events handles url_verification and app_home_opened", async () => {
  let homePublished = false;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origListQueues = queuesRepo.listQueuesByWorkspace;
  const origGetQueueState = queuesRepo.getQueueState;
  const origPublishView = slackApi.publishView;

  workspacesRepo.findBySlackTeamId = (() => {
    return Promise.resolve({
      id: "ws-1",
      slack_team_id: "T1",
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

  queuesRepo.listQueuesByWorkspace = (() => {
    return Promise.resolve([
      {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U10"],
        allow_secret: false,
        created_at: new Date(),
      },
    ]);
  }) as typeof queuesRepo.listQueuesByWorkspace;

  queuesRepo.getQueueState = (() => {
    return Promise.resolve({
      queue: {
        id: "queue-1",
        workspace_id: "ws-1",
        slack_channel_id: "C100",
        name: "staging",
        max_concurrency: 1,
        max_hold_minutes: 45,
        sticky_message_ts: "1700000000.999",
        admin_user_ids: ["U10"],
        allow_secret: false,
        created_at: new Date(),
      },
      activeHolders: [],
      waitingLine: [],
    });
  }) as typeof queuesRepo.getQueueState;

  slackApi.publishView = (_token, userId, view) => {
    homePublished = true;
    assertEquals(userId, "U10");
    assertEquals(view.type, "home");
    return Promise.resolve({ ok: true });
  };

  const origEnv = Deno.env.get("QUEUE_APP_BOT_TOKEN");
  Deno.env.set("QUEUE_APP_BOT_TOKEN", "xoxb-queue-token");

  try {
    // 1. URL Verification challenge
    const challengeBody = JSON.stringify({
      type: "url_verification",
      challenge: "test-challenge-123",
    });
    const challengeHeaders = await createSignedHeaders(challengeBody);
    challengeHeaders["content-type"] = "application/json";

    const req1 = new Request("http://localhost:8080/slack/events", {
      method: "POST",
      headers: challengeHeaders,
      body: challengeBody,
    });
    const res1 = await app.fetch(req1);
    assertEquals(res1.status, 200);
    const json1 = await res1.json();
    assertEquals(json1.challenge, "test-challenge-123");

    // 2. app_home_opened event
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event: {
        type: "app_home_opened",
        user: "U10",
      },
    });
    const eventHeaders = await createSignedHeaders(eventBody);
    eventHeaders["content-type"] = "application/json";

    const req2 = new Request("http://localhost:8080/slack/events", {
      method: "POST",
      headers: eventHeaders,
      body: eventBody,
    });
    const res2 = await app.fetch(req2);
    assertEquals(res2.status, 200);
    assertEquals(homePublished, true);
  } finally {
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    queuesRepo.listQueuesByWorkspace = origListQueues;
    queuesRepo.getQueueState = origGetQueueState;
    slackApi.publishView = origPublishView;
    if (origEnv !== undefined) Deno.env.set("QUEUE_APP_BOT_TOKEN", origEnv);
    else Deno.env.delete("QUEUE_APP_BOT_TOKEN");
  }
});

