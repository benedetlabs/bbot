import { assertEquals, assertRejects } from "@std/assert";
import { GATEKEEP_MCP_TOOLS, GatekeepMcpHandler } from "./mod.ts";

Deno.test("gatekeep-mcp: tools definition includes required PRD tools", () => {
  const toolNames = GATEKEEP_MCP_TOOLS.map((t) => t.name);
  assertEquals(toolNames.includes("request_approval"), true);
  assertEquals(toolNames.includes("get_approval_status"), true);
  assertEquals(toolNames.includes("provide_context"), true);
  assertEquals(toolNames.includes("start_execution"), true);
  assertEquals(toolNames.includes("report_execution"), true);
  assertEquals(toolNames.includes("cancel_request"), true);
});

Deno.test("gatekeep-mcp: handleMessage handles initialize, ping, and tools/list", async () => {
  const handler = new GatekeepMcpHandler({
    baseUrl: "https://mock.gatekeep.local",
    apiKey: "gk_live_test_key",
  });

  // 1. initialize
  const initRes = await handler.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  assertEquals(initRes?.id, 1);
  const initResult = initRes?.result as { serverInfo: { name: string } };
  assertEquals(initResult.serverInfo.name, "gatekeep-mcp");

  // 2. ping
  const pingRes = await handler.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "ping",
  });
  assertEquals(pingRes?.id, 2);
  assertEquals(pingRes?.result, {});

  // 3. tools/list
  const toolsRes = await handler.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
  });
  const toolsResult = toolsRes?.result as { tools: unknown[] };
  assertEquals(toolsResult.tools.length, 6);

  // 4. prompts/list
  const promptsRes = await handler.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "prompts/list",
  });
  const promptsResult = promptsRes?.result as { prompts: { name: string }[] };
  assertEquals(promptsResult.prompts[0].name, "gatekeep_usage");
});

Deno.test("gatekeep-mcp: tools/call executes request_approval and start_execution with hash validation", async () => {
  // Mock global fetch for Gatekeep API
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/v1/requests/gk_req_mcp_01/consume")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              status: "executing",
              jti: "jti-mcp-consumed",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (url.includes("/v1/requests/gk_req_mcp_01/receipt")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              status: "executed",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (url.includes("/v1/requests/gk_req_mcp_01")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "gk_req_mcp_01",
              status: "approved",
              action: "deploy.k8s.rollout",
              target: "env:prod",
              current_revision: 1,
              params_hash: "mock_params_hash",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (url.includes("/v1/requests")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "gk_req_mcp_01",
              status: "pending",
              risk: "high",
              gate: "soft",
              params_hash: "mock_params_hash",
              expires_at: new Date(Date.now() + 1800000).toISOString(),
              poll_url: "https://gatekeep.local/v1/requests/gk_req_mcp_01",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    }) as typeof fetch;

    const handler = new GatekeepMcpHandler({
      baseUrl: "https://mock.gatekeep.local",
      apiKey: "gk_live_test_key",
    });

    // 1. request_approval tool call
    const reqRes = await handler.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "request_approval",
        arguments: {
          action: "deploy.k8s.rollout",
          target: "env:prod",
          params: { replicas: "3", image: "ghcr.io/app:v1" },
          justification: "Production rollout",
        },
      },
    });

    assertEquals(reqRes?.id, 10);
    const content = (reqRes?.result as { content: { text: string }[] }).content[0].text;
    const parsed = JSON.parse(content);
    assertEquals(parsed.request_id, "gk_req_mcp_01");
    assertEquals(parsed.status, "pending");

    // 2. get_approval_status tool call
    const statusRes = await handler.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "get_approval_status",
        arguments: {
          request_id: "gk_req_mcp_01",
          wait_seconds: 0,
        },
      },
    });

    const statusContent = (statusRes?.result as { content: { text: string }[] }).content[0].text;
    const statusParsed = JSON.parse(statusContent);
    assertEquals(statusParsed.status, "approved");
    assertEquals(statusParsed.is_terminal, true);

    // 3. report_execution tool call
    const reportRes = await handler.handleMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "report_execution",
        arguments: {
          request_id: "gk_req_mcp_01",
          status: "succeeded",
          summary: "Deployed 3/3 pods",
        },
      },
    });

    const reportContent = (reportRes?.result as { content: { text: string }[] }).content[0].text;
    const reportParsed = JSON.parse(reportContent);
    assertEquals(reportParsed.status, "executed");
    assertEquals(reportParsed.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
