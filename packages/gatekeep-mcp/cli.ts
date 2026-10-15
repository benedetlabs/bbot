#!/usr/bin/env -S deno run -A
/**
 * @module @suite/gatekeep-mcp/cli
 * Standard I/O (stdio) MCP runner for local clients (Cursor, Claude Desktop, etc.).
 * Reads JSON-RPC from stdin, writes responses to stdout.
 */

import { TextLineStream } from "@std/streams";
import { GatekeepMcpHandler, type McpJsonRpcRequest } from "./mod.ts";

const apiKey = Deno.env.get("GATEKEEP_API_KEY")?.trim();
if (!apiKey) {
  console.error("Error: GATEKEEP_API_KEY environment variable is required.");
  Deno.exit(1);
}

const baseUrl = Deno.env.get("GATEKEEP_BASE_URL")?.trim() ?? "https://gatekeep.bsuit.app";
const handler = new GatekeepMcpHandler({ baseUrl, apiKey });

const lineStream = Deno.stdin.readable
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new TextLineStream());

for await (const line of lineStream) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let request: McpJsonRpcRequest;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    const errorResponse = {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
    await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(errorResponse) + "\n"));
    continue;
  }

  const response = await handler.handleMessage(request);
  if (response !== null) {
    await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(response) + "\n"));
  }
}
