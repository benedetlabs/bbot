# @suite/gatekeep-sdk

> Official TypeScript SDK for Gatekeep — Human approval layer for AI agents in Slack.

## Features

- **`guard()` wrapper**: Automatically checks approval, waits if necessary, verifies cryptographic parameter binding (RFC 8785 canonical hash), executes the callback, and reports execution receipts back to the Slack card.
- **Fail-Safe Parameter Integrity**: Detects parameter drift or hallucination and rejects execution if parameters differ from what the human approved.
- **Idempotency**: Includes automatic idempotency key handling for safe retries after crashes.

## Installation

```bash
# Deno
deno add jsr:@suite/gatekeep-sdk

# npm
npm install @suite/gatekeep-sdk
```

## Quick Start

```typescript
import { GatekeepClient } from "@suite/gatekeep-sdk";

const gk = new GatekeepClient({
  apiKey: "gk_live_your_key_id_secret",
  baseUrl: "https://gatekeep.bsuit.app", // optional, defaults to production
});

// Guard an action: pauses until approved in Slack
const result = await gk.guard(
  {
    action: "stripe.refund.create",
    target: "stripe:acct_live",
    params: {
      charge_id: "ch_123456789",
      amount_cents: 5000,
      reason: "duplicate_charge",
    },
    justification: "Customer reported accidental double click at checkout",
    onBehalfOf: "U_DEVELOPER_123", // Slack user ID
  },
  async (approvedParams) => {
    // This callback ONLY runs after human approval is confirmed in Slack!
    // approvedParams is guaranteed to match what the human reviewed.
    const res = await processStripeRefund(approvedParams);
    return res;
  },
);

console.log("Refund successfully executed:", result);
```

## Low-Level API

For custom execution loops:

```typescript
// 1. Submit approval request
const req = await gk.requestApproval({
  action: "k8s.deployment.restart",
  target: "civo:production-cluster",
  params: { deployment: "api-server" },
  justification: "Memory leak remediation",
});

console.log("Request created:", req.public_id);

// 2. Poll for decision
const status = await gk.getStatus(req.id, { waitSeconds: 25 });
if (status.status === "approved") {
  // 3. Consume token
  const execution = await gk.consumeToken(req.id, {
    approvalToken: status.approval_token!,
    paramsHash: status.params_hash!,
  });

  // 4. Report execution receipt
  await gk.reportExecution(req.id, {
    status: "succeeded",
    summary: "API server restarted successfully in 12s",
    durationMs: 12400,
  });
}
```
