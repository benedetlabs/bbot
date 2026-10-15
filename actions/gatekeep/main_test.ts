import { assertEquals, assertRejects } from "@std/assert";
import {
  parseConfigFromEnv,
  runGatekeepAction,
  setGithubOutput,
} from "./main.ts";

Deno.test("actions/gatekeep: parseConfigFromEnv validates required environment variables", () => {
  Deno.env.delete("GATEKEEP_API_KEY");
  Deno.env.delete("GATEKEEP_ACTION");

  // Missing api_key
  assertRejects(async () => {
    parseConfigFromEnv();
  });

  // Missing action
  Deno.env.set("GATEKEEP_API_KEY", "gk_live_123_456");
  assertRejects(async () => {
    parseConfigFromEnv();
  });

  // Valid inputs
  Deno.env.set("GATEKEEP_ACTION", "deploy.production");
  Deno.env.set("GATEKEEP_PARAMS", JSON.stringify({ image: "v1.2.3" }));
  Deno.env.set("GATEKEEP_TARGET", "civo:k8s");
  Deno.env.set("GATEKEEP_TIMEOUT_MINUTES", "10");

  const config = parseConfigFromEnv();
  assertEquals(config.apiKey, "gk_live_123_456");
  assertEquals(config.action, "deploy.production");
  assertEquals(config.target, "civo:k8s");
  assertEquals(config.params, { image: "v1.2.3" });
  assertEquals(config.timeoutMinutes, 10);
});

Deno.test("actions/gatekeep: setGithubOutput appends to output file if set", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    Deno.env.set("GITHUB_OUTPUT", tempFile);
    await setGithubOutput("status", "approved");
    await setGithubOutput("approval_token", "gkt_token_123");

    const content = await Deno.readTextFile(tempFile);
    assertEquals(content.includes("status=approved\n"), true);
    assertEquals(content.includes("approval_token=gkt_token_123\n"), true);
  } finally {
    await Deno.remove(tempFile);
    Deno.env.delete("GITHUB_OUTPUT");
  }
});

Deno.test("actions/gatekeep: runGatekeepAction handles auto-approved actions", async () => {
  const originalFetch = globalThis.fetch;
  const tempFile = await Deno.makeTempFile();
  Deno.env.set("GITHUB_OUTPUT", tempFile);

  globalThis.fetch = ((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/v1/requests")) {
      return Promise.resolve(new Response(JSON.stringify({
        id: "req-auto-1",
        public_id: "gk_req_AUTO1",
        status: "approved",
        approval_token: "gkt_auto_approved_123",
        params_hash: "hash_xyz_789",
      }), { status: 201 }));
    }
    return Promise.reject(new Error(`Unexpected url: ${urlStr}`));
  }) as typeof fetch;

  try {
    await runGatekeepAction({
      apiKey: "gk_live_test_key",
      action: "ci.test",
      params: {},
      serverUrl: "https://gatekeep.test",
      timeoutMinutes: 1,
    });

    const output = await Deno.readTextFile(tempFile);
    assertEquals(output.includes("status=approved\n"), true);
    assertEquals(output.includes("approval_token=gkt_auto_approved_123\n"), true);
    assertEquals(output.includes("request_id=gk_req_AUTO1\n"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(tempFile);
    Deno.env.delete("GITHUB_OUTPUT");
  }
});

Deno.test("actions/gatekeep: runGatekeepAction polls until human approval is received", async () => {
  const originalFetch = globalThis.fetch;
  const tempFile = await Deno.makeTempFile();
  Deno.env.set("GITHUB_OUTPUT", tempFile);

  let pollCount = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith("/v1/requests")) {
      return Promise.resolve(new Response(JSON.stringify({
        id: "req-pending-1",
        public_id: "gk_req_PENDING1",
        status: "pending",
      }), { status: 201 }));
    }
    if (urlStr.includes("/v1/requests/req-pending-1")) {
      pollCount++;
      if (pollCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          status: "pending",
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        status: "approved",
        approval_token: "gkt_human_approved_456",
        params_hash: "hash_canonical_abc",
        decided_by_user_id: "U_LEONARDO",
      }), { status: 200 }));
    }
    return Promise.reject(new Error(`Unexpected url: ${urlStr}`));
  }) as typeof fetch;

  try {
    await runGatekeepAction({
      apiKey: "gk_live_test_key",
      action: "deploy.k3s",
      params: { tag: "sha-123" },
      serverUrl: "https://gatekeep.test",
      timeoutMinutes: 1,
    });

    const output = await Deno.readTextFile(tempFile);
    assertEquals(output.includes("status=approved\n"), true);
    assertEquals(output.includes("approval_token=gkt_human_approved_456\n"), true);
    assertEquals(output.includes("decided_by=U_LEONARDO\n"), true);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(tempFile);
    Deno.env.delete("GITHUB_OUTPUT");
  }
});
