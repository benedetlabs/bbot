import { assertEquals } from "@std/assert";
import { app, getSigningSecret, parseTodoCommandText } from "./main.ts";
import { mauRepo, todosRepo, workspacesRepo } from "@suite/db";
import { slackApi } from "@suite/slack-kit";

async function createSignedHeaders(
  body: string,
  secret = getSigningSecret(),
  contentType = "application/x-www-form-urlencoded",
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
    "content-type": contentType,
  };
}

Deno.test("todo-app: parseTodoCommandText helper", () => {
  const res1 = parseTodoCommandText("Review PR tomorrow at 3pm", "U_DEFAULT");
  assertEquals(res1.title, "Review PR");
  assertEquals(res1.assigneeSlackId, "U_DEFAULT");
  assertEquals(res1.dueAt instanceof Date, true);
  assertEquals(res1.rawDateText, "tomorrow at 3pm");

  const res2 = parseTodoCommandText(
    "<@U999|bob> Update docs by Friday",
    "U_DEFAULT",
  );
  assertEquals(res2.title, "Update docs");
  assertEquals(res2.assigneeSlackId, "U999");
  assertEquals(res2.dueAt instanceof Date, true);

  const res3 = parseTodoCommandText(
    "@alice Deploy staging release",
    "U_DEFAULT",
  );
  assertEquals(res3.title, "Deploy staging release");
  assertEquals(res3.assigneeSlackId, "alice");
  assertEquals(res3.dueAt, null);

  const res4 = parseTodoCommandText("by tomorrow", "U_DEFAULT");
  assertEquals(res4.title, "Untitled Task");
  assertEquals(res4.dueAt instanceof Date, true);
});

Deno.test("todo-app: GET /healthz returns ok status", async () => {
  const req = new Request("http://localhost:8080/healthz");
  const res = await app.fetch(req);
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.status, "ok");
  assertEquals(body.app, "todo-app");
});

Deno.test("todo-app: POST /slack/commands rejects unsigned requests", async () => {
  const req = new Request("http://localhost:8080/slack/commands", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "command=%2Ftodo&text=buy%20milk",
  });
  const res = await app.fetch(req);
  assertEquals(res.status, 401);
});

Deno.test("todo-app: /todo help returns guidance", async () => {
  const body =
    "command=%2Ftodo&text=help&channel_id=C777&user_id=U777&team_id=T888";
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
  assertEquals(json.text.includes("GTD Micro-Task Manager Commands:"), true);
});

Deno.test("todo-app: /todo list returns empty state or tasks", async () => {
  const origList = todosRepo.list;
  todosRepo.list = (() => Promise.resolve([])) as typeof todosRepo.list;

  try {
    const body =
      "command=%2Ftodo&text=list&channel_id=C777&user_id=U777&team_id=T888";
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
    assertEquals(json.text.includes("You have no open tasks"), true);
  } finally {
    todosRepo.list = origList;
  }
});

Deno.test("todo-app: POST /slack/commands creates personal task and tracks MAU", async () => {
  let mauTracked = false;
  const origMau = mauRepo.recordUserInteraction;
  const origFindWorkspace = workspacesRepo.findBySlackTeamId;
  const origCreate = todosRepo.create;

  mauRepo.recordUserInteraction = ((params) => {
    if (params.appSlug === "todo" && params.slackUserId === "U777") {
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
      slack_team_id: "T888",
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

  todosRepo.create = ((params) => {
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000099",
      workspace_id: params.workspaceId,
      creator_slack_user_id: params.creatorSlackUserId,
      assignee_slack_user_id: params.assigneeSlackUserId ??
        params.creatorSlackUserId,
      slack_channel_id: params.slackChannelId ?? null,
      title: params.title,
      source_permalink: params.sourcePermalink ?? null,
      status: "open",
      due_at: params.dueAt ?? null,
      completed_at: null,
      completed_by_slack_user_id: null,
      created_at: new Date(),
    });
  }) as typeof todosRepo.create;

  try {
    const body =
      "command=%2Ftodo&text=Review%20PR%20tomorrow%20at%203pm&channel_id=C777&user_id=U777&team_id=T888";
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
    assertEquals(json.text.includes("Review PR"), true);
    assertEquals(json.blocks.length, 1);

    await new Promise((r) => setTimeout(r, 10));
    assertEquals(mauTracked, true);
  } finally {
    mauRepo.recordUserInteraction = origMau;
    workspacesRepo.findBySlackTeamId = origFindWorkspace;
    todosRepo.create = origCreate;
  }
});

Deno.test("todo-app: POST /slack/commands creates delegated task with in_channel card", async () => {
  const origCreate = todosRepo.create;
  todosRepo.create = ((params) => {
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000099",
      workspace_id: params.workspaceId,
      creator_slack_user_id: params.creatorSlackUserId,
      assignee_slack_user_id: params.assigneeSlackUserId ?? "U_BOB",
      slack_channel_id: params.slackChannelId ?? null,
      title: params.title,
      source_permalink: null,
      status: "open",
      due_at: params.dueAt ?? null,
      completed_at: null,
      completed_by_slack_user_id: null,
      created_at: new Date(),
    });
  }) as typeof todosRepo.create;

  try {
    const body =
      "command=%2Ftodo&text=%3C%40U_BOB%7Cbob%3E%20Deploy%20v2%20by%20Friday&channel_id=C777&user_id=U777&team_id=T888";
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
    assertEquals(json.text.includes("Deploy v2"), true);
  } finally {
    todosRepo.create = origCreate;
  }
});

Deno.test("todo-app: message shortcut todo_create_from_message opens modal", async () => {
  let openViewCalled = false;
  let passedModal: Record<string, unknown> | null = null;
  const origOpenView = slackApi.openView;

  slackApi.openView = ((token, triggerId, view) => {
    if (token && triggerId === "trig-999") {
      openViewCalled = true;
      passedModal = view as unknown as Record<string, unknown>;
    }
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.openView;

  // Set mock env bot token
  Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-mock-token");

  try {
    const payload = {
      type: "message_action",
      callback_id: "todo_create_from_message",
      trigger_id: "trig-999",
      team: { id: "T888", domain: "testteam" },
      user: { id: "U777", name: "alice" },
      channel: { id: "C123", name: "general" },
      message: {
        text: "Could someone review this PR please?",
        ts: "1700000000.000100",
        permalink: "https://slack.com/archives/C123/p1700000000000100",
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
    assertEquals(openViewCalled, true);
    assertEquals(
      (passedModal as Record<string, unknown> | null)?.callback_id,
      "todo_create_modal",
    );
  } finally {
    slackApi.openView = origOpenView;
    Deno.env.delete("TODO_APP_BOT_TOKEN");
  }
});

Deno.test("todo-app: modal submission validates empty title", async () => {
  Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-mock-token");
  try {
    const payload = {
      type: "view_submission",
      user: { id: "U777" },
      team: { id: "T888" },
      view: {
        callback_id: "todo_create_modal",
        state: {
          values: {
            title_block: { title_input: { value: "   " } },
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
    assertEquals(json.response_action, "errors");
    assertEquals(
      json.errors?.title_block,
      "Task title cannot be empty.",
    );
  } finally {
    Deno.env.delete("TODO_APP_BOT_TOKEN");
  }
});

Deno.test("todo-app: modal submission creates todo and clears modal", async () => {
  let createdTitle = "";
  const origCreate = todosRepo.create;
  todosRepo.create = ((params) => {
    createdTitle = params.title;
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000088",
      workspace_id: params.workspaceId,
      creator_slack_user_id: params.creatorSlackUserId,
      assignee_slack_user_id: params.assigneeSlackUserId ??
        params.creatorSlackUserId,
      slack_channel_id: null,
      title: params.title,
      source_permalink: null,
      status: "open",
      due_at: null,
      completed_at: null,
      completed_by_slack_user_id: null,
      created_at: new Date(),
    });
  }) as typeof todosRepo.create;

  Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-mock-token");
  try {
    const payload = {
      type: "view_submission",
      user: { id: "U777" },
      team: { id: "T888" },
      view: {
        callback_id: "todo_create_modal",
        private_metadata: JSON.stringify({ channelId: "C123" }),
        state: {
          values: {
            title_block: { title_input: { value: "Implement new feature" } },
            assignee_block: { assignee_select: { selected_user: "U999" } },
            due_date_block: {
              due_date_picker: { selected_date: "2026-10-20" },
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
    assertEquals(createdTitle, "Implement new feature");
  } finally {
    todosRepo.create = origCreate;
    Deno.env.delete("TODO_APP_BOT_TOKEN");
  }
});

Deno.test("todo-app: block actions complete and reopen todo", async () => {
  let completeCalled = false;
  let reopenCalled = false;
  const origComplete = todosRepo.complete;
  const origReopen = todosRepo.reopen;
  const origGetGTD = todosRepo.getGTDGroups;
  const origPublish = slackApi.publishView;

  todosRepo.complete = (() => {
    completeCalled = true;
    return Promise.resolve({
      todo: {
        id: "00000000-0000-0000-0000-000000000001",
        workspace_id: "ws-1",
        creator_slack_user_id: "U777",
        assignee_slack_user_id: "U777",
        slack_channel_id: null,
        title: "Test",
        source_permalink: null,
        status: "completed",
        due_at: null,
        completed_at: new Date(),
        completed_by_slack_user_id: "U777",
        created_at: new Date(),
      },
      isDelegated: false,
    });
  }) as typeof todosRepo.complete;

  todosRepo.reopen = (() => {
    reopenCalled = true;
    return Promise.resolve({
      id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "ws-1",
      creator_slack_user_id: "U777",
      assignee_slack_user_id: "U777",
      slack_channel_id: null,
      title: "Test",
      source_permalink: null,
      status: "open",
      due_at: null,
      completed_at: null,
      completed_by_slack_user_id: null,
      created_at: new Date(),
    });
  }) as typeof todosRepo.reopen;

  todosRepo.getGTDGroups = (() => {
    return Promise.resolve({
      today: [],
      overdue: [],
      delegatedToMe: [],
      delegatedByMe: [],
      completed: [],
      inbox: [],
    });
  }) as typeof todosRepo.getGTDGroups;

  slackApi.publishView =
    (() => Promise.resolve({ ok: true })) as typeof slackApi.publishView;
  Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-mock-token");

  try {
    // 1. Complete action from home tab
    const payloadComplete = {
      type: "block_actions",
      user: { id: "U777" },
      team: { id: "T888" },
      view: { type: "home" },
      actions: [{
        action_id: "todo_complete_click",
        value: "00000000-0000-0000-0000-000000000001",
      }],
    };
    const body1 = `payload=${
      encodeURIComponent(JSON.stringify(payloadComplete))
    }`;
    const headers1 = await createSignedHeaders(body1);

    const req1 = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headers1,
      body: body1,
    });
    const res1 = await app.fetch(req1);
    assertEquals(res1.status, 200);
    assertEquals(completeCalled, true);

    // 2. Reopen action
    const payloadReopen = {
      type: "block_actions",
      user: { id: "U777" },
      team: { id: "T888" },
      view: { type: "home" },
      actions: [{
        action_id: "todo_reopen_click",
        value: "00000000-0000-0000-0000-000000000001",
      }],
    };
    const body2 = `payload=${
      encodeURIComponent(JSON.stringify(payloadReopen))
    }`;
    const headers2 = await createSignedHeaders(body2);

    const req2 = new Request("http://localhost:8080/slack/interactions", {
      method: "POST",
      headers: headers2,
      body: body2,
    });
    const res2 = await app.fetch(req2);
    assertEquals(res2.status, 200);
    assertEquals(reopenCalled, true);
  } finally {
    todosRepo.complete = origComplete;
    todosRepo.reopen = origReopen;
    todosRepo.getGTDGroups = origGetGTD;
    slackApi.publishView = origPublish;
    Deno.env.delete("TODO_APP_BOT_TOKEN");
  }
});

Deno.test("todo-app: /slack/events handles url_verification challenge", async () => {
  const challengeBody = JSON.stringify({
    type: "url_verification",
    challenge: "3eZbrAqImP3...",
  });
  const headers = await createSignedHeaders(
    challengeBody,
    getSigningSecret(),
    "application/json",
  );

  const req = new Request("http://localhost:8080/slack/events", {
    method: "POST",
    headers,
    body: challengeBody,
  });

  const res = await app.fetch(req);
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.challenge, "3eZbrAqImP3...");
});

Deno.test("todo-app: /slack/events handles app_home_opened and publishes view", async () => {
  let publishCalled = false;
  let targetUser = "";
  const origPublish = slackApi.publishView;
  const origGetGTD = todosRepo.getGTDGroups;

  slackApi.publishView = ((_token, userId, _view) => {
    publishCalled = true;
    targetUser = userId;
    return Promise.resolve({ ok: true });
  }) as typeof slackApi.publishView;

  todosRepo.getGTDGroups = (() => {
    return Promise.resolve({
      today: [],
      overdue: [],
      delegatedToMe: [],
      delegatedByMe: [],
      completed: [],
      inbox: [],
    });
  }) as typeof todosRepo.getGTDGroups;

  Deno.env.set("TODO_APP_BOT_TOKEN", "xoxb-mock-token");

  try {
    const eventBody = JSON.stringify({
      type: "event_callback",
      team_id: "T888",
      event: {
        type: "app_home_opened",
        user: "U777",
        tab: "home",
      },
    });

    const headers = await createSignedHeaders(
      eventBody,
      getSigningSecret(),
      "application/json",
    );

    const req = new Request("http://localhost:8080/slack/events", {
      method: "POST",
      headers,
      body: eventBody,
    });

    const res = await app.fetch(req);
    assertEquals(res.status, 200);
    assertEquals(publishCalled, true);
    assertEquals(targetUser, "U777");
  } finally {
    slackApi.publishView = origPublish;
    todosRepo.getGTDGroups = origGetGTD;
    Deno.env.delete("TODO_APP_BOT_TOKEN");
  }
});
