# @suite/gatekeep-mcp

> Model Context Protocol (MCP) server for Gatekeep — Human approval layer for AI agents in Slack.

Enables AI agents in Cursor, Claude Code, Windsurf, and custom MCP clients to request human approvals before performing sensitive actions.

## Tools Provided

1. `request_approval`: Pauses agent execution and posts an interactive Block Kit approval card to Slack.
2. `get_approval_status`: Checks current decision status (`pending`, `approved`, `edited`, `rejected`, `expired`, `needs_info`). Supports long-polling.
3. `provide_context`: Allows the agent to answer questions or provide clarifications when an approver asks for context.
4. `start_execution`: Enforces parameter integrity (recalculating RFC 8785 canonical hash) and consumes the single-use approval token.
5. `report_execution`: Closes the loop by updating the Slack card with the final execution receipt (duration, status, log link).
6. `cancel_request`: Cancels a pending request if superseded.

## Configuration

### Cursor

Add to `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gatekeep": {
      "command": "deno",
      "args": [
        "run",
        "-A",
        "jsr:@suite/gatekeep-mcp",
        "--api-key",
        "gk_live_your_key_id_secret",
        "--server",
        "https://gatekeep.bsuit.app"
      ]
    }
  }
}
```

### Claude Desktop / Claude Code

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gatekeep": {
      "command": "deno",
      "args": [
        "run",
        "-A",
        "jsr:@suite/gatekeep-mcp",
        "--api-key",
        "gk_live_your_key_id_secret"
      ]
    }
  }
}
```

### Remote MCP Endpoint

Gatekeep also serves a remote Streamable HTTP MCP endpoint directly at:

```
POST https://gatekeep.bsuit.app/mcp
Authorization: Bearer gk_live_your_key_id_secret
```
