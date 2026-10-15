import { assertEquals, assertRejects } from "@std/assert";
import { GatekeepClient } from "./mod.ts";

Deno.test("gatekeep-sdk: requestApproval dispatches request with auth header", async () => {
  let requestedUrl = "";
  let requestHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;

  const mockFetch = ((url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body));

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "gk_req_mock_123",
          status: "pending",
          params_hash: "hash_abc",
          risk: "high",
          gate: "soft",
          expires_at: new Date().toISOString(),
          poll_url: "https://gatekeep.bsuit.app/v1/requests/gk_req_mock_123",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const client = new GatekeepClient({
    apiKey: "gk_live_key1_secret2",
    baseUrl: "https://gatekeep.test",
    fetchFn: mockFetch,
  });

  const res = await client.requestApproval({
    action: "deploy.k8s",
    target: "env:production",
    params: { tag: "v1.0.0" },
    justification: "Deploy hotfix",
    idempotencyKey: "idem-1",
  });

  assertEquals(requestedUrl, "https://gatekeep.test/v1/requests");
  assertEquals(requestHeaders?.get("Authorization"), "Bearer gk_live_key1_secret2");
  assertEquals(requestHeaders?.get("Idempotency-Key"), "idem-1");
  assertEquals(requestBody?.action, "deploy.k8s");
  assertEquals(res.id, "gk_req_mock_123");
  assertEquals(res.status, "pending");
});

Deno.test("gatekeep-sdk: guard executes callback when approved and reports receipt", async () => {
  let callCount = 0;
  let receiptReported = false;

  const mockFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    callCount++;

    // 1. POST /v1/requests
    if (init?.method === "POST" && urlStr.endsWith("/v1/requests")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "gk_req_guard_1",
            status: "pending",
            params_hash: "hash_123",
            risk: "medium",
            gate: "soft",
            expires_at: new Date().toISOString(),
            poll_url: "https://gatekeep.test/v1/requests/gk_req_guard_1",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // 2. GET /v1/requests/gk_req_guard_1
    if (init?.method === "GET" && urlStr.includes("/v1/requests/gk_req_guard_1")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "gk_req_guard_1",
            status: "approved",
            action: "stripe.refund",
            risk: "medium",
            gate: "soft",
            current_revision: 1,
            params_hash: "hash_123",
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // 3. POST /v1/requests/gk_req_guard_1/receipt
    if (init?.method === "POST" && urlStr.endsWith("/receipt")) {
      receiptReported = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, status: "executed" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }) as typeof fetch;

  const client = new GatekeepClient({
    apiKey: "gk_live_key1_secret2",
    baseUrl: "https://gatekeep.test",
    fetchFn: mockFetch,
  });

  let businessLogicExecuted = false;
  const result = await client.guard(
    {
      action: "stripe.refund",
      params: { charge_id: "ch_999" },
    },
    async (params) => {
      businessLogicExecuted = true;
      assertEquals(params.charge_id, "ch_999");
      return { refundId: "re_123" };
    },
  );

  assertEquals(businessLogicExecuted, true);
  assertEquals(result.refundId, "re_123");
  assertEquals(receiptReported, true);
});

Deno.test("gatekeep-sdk: guard throws when action is rejected", async () => {
  const mockFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    if (init?.method === "POST" && urlStr.endsWith("/v1/requests")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "gk_req_rej_1",
            status: "pending",
            params_hash: "h1",
            risk: "critical",
            gate: "hard",
            expires_at: new Date().toISOString(),
            poll_url: "https://gatekeep.test/v1/requests/gk_req_rej_1",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (init?.method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "gk_req_rej_1",
            status: "rejected",
            action: "delete.database",
            risk: "critical",
            gate: "hard",
            current_revision: 1,
            params_hash: "h1",
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }) as typeof fetch;

  const client = new GatekeepClient({
    apiKey: "gk_live_key1_secret2",
    baseUrl: "https://gatekeep.test",
    fetchFn: mockFetch,
  });

  let reached = false;
  await assertRejects(
    async () => {
      await client.guard(
        {
          action: "delete.database",
          params: { db: "prod" },
        },
        async () => {
          reached = true;
          return "done";
        },
      );
    },
    Error,
    "Gatekeep rejected action",
  );

  assertEquals(reached, false);
});
