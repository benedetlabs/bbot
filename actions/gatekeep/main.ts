/**
 * @module actions/gatekeep/main
 * GitHub Action runner for Gatekeep: pauses CI/CD pipeline until human Slack approval.
 */

export interface GatekeepActionConfig {
  apiKey: string;
  action: string;
  target?: string;
  params: Record<string, unknown>;
  justification?: string;
  onBehalfOf?: string;
  serverUrl: string;
  timeoutMinutes: number;
}

export function parseConfigFromEnv(): GatekeepActionConfig {
  const apiKey = Deno.env.get("GATEKEEP_API_KEY")?.trim() ?? "";
  if (!apiKey) {
    throw new Error("Missing required input: api_key");
  }

  const action = Deno.env.get("GATEKEEP_ACTION")?.trim() ?? "";
  if (!action) {
    throw new Error("Missing required input: action");
  }

  const target = Deno.env.get("GATEKEEP_TARGET")?.trim() || undefined;
  const rawParams = Deno.env.get("GATEKEEP_PARAMS")?.trim() ?? "{}";
  let params: Record<string, unknown> = {};
  if (rawParams) {
    try {
      params = JSON.parse(rawParams);
    } catch {
      throw new Error(`Invalid JSON in 'params' input: ${rawParams}`);
    }
  }

  const justification = Deno.env.get("GATEKEEP_JUSTIFICATION")?.trim() || undefined;
  const onBehalfOf = Deno.env.get("GATEKEEP_ON_BEHALF_OF")?.trim() || undefined;
  const serverUrl = (Deno.env.get("GATEKEEP_SERVER_URL")?.trim() || "https://gatekeep.bsuit.app")
    .replace(/\/$/, "");
  const timeoutMinutes = parseInt(Deno.env.get("GATEKEEP_TIMEOUT_MINUTES") ?? "15", 10);

  return {
    apiKey,
    action,
    target,
    params,
    justification,
    onBehalfOf,
    serverUrl,
    timeoutMinutes: isNaN(timeoutMinutes) || timeoutMinutes <= 0 ? 15 : timeoutMinutes,
  };
}

export async function setGithubOutput(key: string, value: string): Promise<void> {
  const outputFile = Deno.env.get("GITHUB_OUTPUT");
  if (outputFile) {
    await Deno.writeTextFile(outputFile, `${key}=${value}\n`, { append: true });
  }
}

export async function runGatekeepAction(config: GatekeepActionConfig): Promise<void> {
  console.log(`🛡️ Gatekeep Action: Requesting human approval for '${config.action}'...`);

  // Compute idempotency key from GitHub Actions context
  const runId = Deno.env.get("GITHUB_RUN_ID") ?? "local-run";
  const runAttempt = Deno.env.get("GITHUB_RUN_ATTEMPT") ?? "1";
  const job = Deno.env.get("GITHUB_JOB") ?? "job";
  const idempotencyKey = `gha-${runId}-${runAttempt}-${job}`;

  // 1. Submit Request
  const createRes = await fetch(`${config.serverUrl}/v1/requests`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      action: config.action,
      target: config.target,
      params: config.params,
      justification: config.justification,
      on_behalf_of_slack_user_id: config.onBehalfOf,
    }),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    throw new Error(`Gatekeep API rejected request (${createRes.status}): ${errorText}`);
  }

  const created = await createRes.json();
  const requestId = created.id as string;
  const publicId = created.public_id as string;
  const initialStatus = created.status as string;

  console.log(`📋 Request registered: ${publicId} (status: ${initialStatus})`);
  console.log(`⏳ Waiting for Slack approval (timeout: ${config.timeoutMinutes}m)...`);

  await setGithubOutput("request_id", publicId);

  if (initialStatus === "approved") {
    console.log("⚡ Action was automatically approved by policy!");
    await setGithubOutput("status", "approved");
    await setGithubOutput("approval_token", created.approval_token ?? "");
    await setGithubOutput("params_hash", created.params_hash ?? "");
    return;
  }

  // 2. Poll until decided or deadline
  const deadline = Date.now() + config.timeoutMinutes * 60 * 1000;

  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
    const pollRes = await fetch(
      `${config.serverUrl}/v1/requests/${requestId}?wait=${remainingSeconds}`,
      {
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
        },
      },
    );

    if (!pollRes.ok) {
      console.warn(`Warning: poll returned status ${pollRes.status}, retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const current = await pollRes.json();
    const status = current.status as string;

    if (status === "approved" || status === "edited") {
      const approver = current.decided_by_user_id ?? "authorized reviewer";
      console.log(`✅ Gatekeep Approval Granted by @${approver} (status: ${status})!`);
      await setGithubOutput("status", status);
      await setGithubOutput("approval_token", current.approval_token ?? "");
      await setGithubOutput("params_hash", current.params_hash ?? "");
      await setGithubOutput("decided_by", current.decided_by_user_id ?? "");
      return;
    }

    if (status === "rejected") {
      const rejecter = current.decided_by_user_id ?? "reviewer";
      const note = current.decision_note ? ` Reason: "${current.decision_note}"` : "";
      console.error(`❌ Gatekeep Approval REJECTED by @${rejecter}.${note}`);
      await setGithubOutput("status", "rejected");
      await setGithubOutput("decided_by", current.decided_by_user_id ?? "");
      Deno.exit(1);
    }

    if (status === "expired") {
      console.error("⏱️ Gatekeep Approval Expired (default-deny).");
      await setGithubOutput("status", "expired");
      Deno.exit(1);
    }

    if (status === "cancelled") {
      console.error("🚫 Gatekeep Approval was cancelled.");
      await setGithubOutput("status", "cancelled");
      Deno.exit(1);
    }
  }

  console.error(`⏱️ Timed out waiting for human approval after ${config.timeoutMinutes} minutes (default-deny).`);
  await setGithubOutput("status", "expired");
  Deno.exit(1);
}

if (import.meta.main) {
  try {
    const config = parseConfigFromEnv();
    await runGatekeepAction(config);
  } catch (err) {
    console.error("Gatekeep Action Failed:", err);
    Deno.exit(1);
  }
}
