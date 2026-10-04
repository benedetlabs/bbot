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
    assertEquals(json1.response_type, "in_channel");
    assertEquals(json1.text.includes("acquired the active lock"), true);

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
    assertEquals(json.response_type, "in_channel");
    assertEquals(json.text.includes("released the lock"), true);
    assertEquals(json.text.includes("<@U2> is now up!"), true);
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
      "command=%2Fqueue&text=extend%2015&channel_id=C888&user_id=U1&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "in_channel");
    assertEquals(json.text.includes("extended active hold by +15m"), true);
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
      "command=%2Fqueue&text=kick%20%3C%40U_BAD%7Cbaduser%3E&channel_id=C888&user_id=U_ADMIN&team_id=T1";
    const headers = await createSignedHeaders(body);

    const req = new Request("http://localhost:8080/slack/commands", {
      method: "POST",
      headers,
      body,
    });

    const res = await app.fetch(req);
    const json = await res.json();
    assertEquals(json.response_type, "in_channel");
    assertEquals(json.text.includes("<@U_BAD> was kicked by <@U_ADMIN>"), true);
  } finally {
    queuesRepo.findOrCreateQueue = origFindQueue;
    queuesRepo.getQueueState = origGetQueueState;
    queuesRepo.kickUser = origKick;
  }
});

Deno.test("queue-app: interactions block action queue_attach_secret_click opens modal", async () => {
  let viewOpenCalled = false;
  const origOpenView = slackApi.openView;
  slackApi.openView = (_token, triggerId, view) => {
    viewOpenCalled = true;
    assertEquals(triggerId, "trig-999");
    assertEquals(view.callback_id, "secret_create_modal");
    return Promise.resolve({ ok: true });
  };

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

  slackApi.postMessage = (_token, channelId) => {
    postCalled = true;
    assertEquals(channelId, "C100");
    return Promise.resolve({ ok: true, ts: "1700000000.888" });
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
