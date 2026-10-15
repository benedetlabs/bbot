/**
 * Public HTML for the Secret one-time link app.
 * Marketplace review reads / , /privacy, and /support.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 2.5rem auto; padding: 0 1.25rem; line-height: 1.5; }
    a { color: inherit; }
    nav a { margin-right: 1rem; }
    code { font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Secret</a>
    <a href="/privacy">Privacy</a>
    <a href="/support">Support</a>
  </nav>
  ${body}
</body>
</html>`;
}

function linkShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f1ea;
      --card: #fffdf8;
      --ink: #1c1915;
      --muted: #5e584e;
      --line: #e4ddd0;
      --button: #1c1915;
      --button-ink: #fffdf8;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #12110f;
        --card: #1c1b18;
        --ink: #f5f1e8;
        --muted: #b7b0a4;
        --line: #34312b;
        --button: #f5f1e8;
        --button-ink: #1c1915;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 1.5rem;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, sans-serif;
      line-height: 1.45;
    }
    main {
      width: min(100%, 32rem);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 1.75rem 1.5rem 1.4rem;
    }
    .mark { margin: 0 0 1.25rem; font-size: 0.85rem; letter-spacing: 0.04em; }
    .mark a { color: inherit; text-decoration: none; }
    h1 { margin: 0 0 0.6rem; font-size: 1.65rem; letter-spacing: -0.03em; }
    p { margin: 0.4rem 0 0; color: var(--muted); }
    [hidden] { display: none !important; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-top: 1.25rem; }
    button {
      font: inherit;
      border: 0;
      border-radius: 999px;
      padding: 0.7rem 1rem;
      background: var(--button);
      color: var(--button-ink);
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--line);
    }
    button:disabled { opacity: 0.45; cursor: default; }
    pre {
      margin: 1.1rem 0 0;
      padding: 0.9rem 1rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--bg);
      font-family: ui-monospace, monospace;
      font-size: 0.95rem;
      color: var(--ink);
    }
  </style>
</head>
<body>
  <main>
    <p class="mark"><a href="/">Secret</a></p>
    ${body}
  </main>
</body>
</html>`;
}

export function landingPage(): string {
  return layout(
    "Secret — one-time links",
    `<h1>One-time secret links for Slack</h1>
    <p>Secret creates a link for a password or API key. In a direct message, that link is sent as a message. In a channel, Secret does not post it: you copy the link and send it privately.</p>
    <p>Opening the link shows the secret in the browser, then the link stops working. Secret does not delete Slack messages.</p>
    <p><a href="/slack/install">Add to Slack</a></p>
    <h2>How it works</h2>
    <ol>
      <li>Run <code>/secret</code> and submit the credential.</li>
      <li>Copy the link from the confirmation view. The part after <code>#</code> is the key.</li>
      <li>The recipient opens the link and chooses “Open once”.</li>
    </ol>`,
  );
}

export function privacyPage(): string {
  return layout(
    "Secret privacy policy",
    `<h1>Privacy policy</h1>
    <p>Secret is a Slack app from Benedet Labs that creates one-time links for credentials. This page describes what the app stores. Contact <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>.</p>
    <h2>Data we collect</h2>
    <ul>
      <li>Slack workspace id, workspace name, and the user id of the person who installs the app and of the person who creates a link.</li>
      <li>The public label, expiry, and view limit you choose. The label is not encrypted.</li>
      <li>The secret text, only long enough to encrypt it. We store ciphertext. The other half of the key stays in the link fragment and is not stored in the database.</li>
      <li>The bot token for your workspace, encrypted at rest.</li>
    </ul>
    <h2>How it is used</h2>
    <p>We use this data to create the link, open it when someone chooses “Open once”, and post nothing secret back into Slack. We do not sell data and we do not use secret contents to train models.</p>
    <h2>Retention and deletion</h2>
    <p>Ciphertext is deleted when the link is opened for the last time, when you destroy the link, or when it expires. Uninstalling the app, or Slack revoking the token, deletes the stored bot token and any unopened secrets for that workspace. Workspace install records other than the token may remain so we can recognize a later reinstall.</p>
    <p>The secret text passes through our server when you submit the Slack form and again when the link is opened, because that is how the ciphertext is created and then decrypted. After the last open, we do not keep the plaintext.</p>
    <h2>Contact</h2>
    <p>Email <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a> to ask for deletion or a copy of installation data. We reply within two business days.</p>`,
  );
}

export function supportPage(): string {
  return layout(
    "Secret support",
    `    <h1>Support</h1>
    <p>Secret creates one-time links for credentials. Email <a href="mailto:benedetlabs@gmail.com">benedetlabs@gmail.com</a>. You do not need an account. We reply within two business days.</p>
    <p>Include your Slack workspace name and what you expected the link to do. Do not include the secret or the full link in the email.</p>
    <p><a href="/slack/install">Add to Slack</a></p>`,
  );
}

export type LinkUnavailableReason = "expired" | "used" | "destroyed" | "missing";

const linkUnavailableCopy: Record<
  LinkUnavailableReason,
  { title: string; message: string }
> = {
  expired: {
    title: "This link expired",
    message: "The time limit passed before it was opened. Ask for a new link.",
  },
  used: {
    title: "This link was already opened",
    message: "A one-time link works only for the number of opens that were left. This one has none.",
  },
  destroyed: {
    title: "This link was destroyed",
    message: "The person who created it destroyed it before it was opened.",
  },
  missing: {
    title: "This link does not exist",
    message: "Check that you copied the full address. Nothing is stored for this link.",
  },
};

export function linkUnavailablePage(reason: LinkUnavailableReason): string {
  const copy = linkUnavailableCopy[reason];
  return linkShell(
    copy.title,
    `<h1>${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.message)}</p>`,
  );
}

export function revealPage(secretId: string): string {
  const idJson = JSON.stringify(secretId);
  return linkShell(
    "Open one-time link",
    `<h1>One-time secret link</h1>
    <p id="status">The secret stays in this browser. It is not sent back to Slack.</p>
    <div class="actions" id="actions">
      <button id="open" type="button">Open once</button>
      <button id="copy-link" class="secondary" type="button">Copy link</button>
    </div>
    <pre id="secret" hidden></pre>
    <div class="actions" id="secret-actions" hidden>
      <button id="copy-secret" class="secondary" type="button">Copy secret</button>
    </div>
    <script>
      const id = ${idJson};
      const key = location.hash.startsWith("#") ? location.hash.slice(1) : "";
      const status = document.getElementById("status");
      const openBtn = document.getElementById("open");
      const copyLinkBtn = document.getElementById("copy-link");
      const output = document.getElementById("secret");
      const secretActions = document.getElementById("secret-actions");
      const copySecretBtn = document.getElementById("copy-secret");
      const unavailable = {
        expired: ${JSON.stringify(linkUnavailableCopy.expired.message)},
        used: ${JSON.stringify(linkUnavailableCopy.used.message)},
        destroyed: ${JSON.stringify(linkUnavailableCopy.destroyed.message)},
        missing: ${JSON.stringify(linkUnavailableCopy.missing.message)},
      };

      async function copyText(value, button, doneLabel) {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const area = document.createElement("textarea");
          area.value = value;
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
        const previous = button.textContent;
        button.textContent = doneLabel;
        setTimeout(() => { button.textContent = previous; }, 1600);
      }

      copyLinkBtn.addEventListener("click", () => {
        copyText(location.href, copyLinkBtn, "Copied");
      });
      copySecretBtn.addEventListener("click", () => {
        copyText(output.textContent || "", copySecretBtn, "Copied");
      });

      if (!key) {
        status.textContent = "This link is missing its key. Copy the full link, including the part after #.";
        openBtn.hidden = true;
      }

      openBtn.addEventListener("click", async () => {
        openBtn.disabled = true;
        status.textContent = "Opening once…";
        const res = await fetch("/s/" + encodeURIComponent(id) + "/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientKeyHex: key }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const reason = data.reason;
          status.textContent = unavailable[reason] || "This link could not be opened.";
          openBtn.hidden = true;
          output.hidden = true;
          secretActions.hidden = true;
          return;
        }
        output.hidden = false;
        output.textContent = typeof data.plaintext === "string" ? data.plaintext : "";
        secretActions.hidden = false;
        openBtn.hidden = true;
        status.textContent = data.remainingViews > 0
          ? "Opened. You can open it " + data.remainingViews + " more " + (data.remainingViews === 1 ? "time." : "times.")
          : "Opened. This link no longer works.";
      });
    </script>`,
  );
}

export function installedPage(teamName: string): string {
  return layout(
    "Secret installed",
    `<h1>Secret is installed</h1>
    <p>${
      escapeHtml(teamName)
    } can use <code>/secret</code> to create a one-time link.</p>
    <p><a href="/support">Support</a></p>`,
  );
}

export function oauthErrorPage(message: string): string {
  return layout(
    "Install failed",
    `<h1>Secret was not installed</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/slack/install">Try again</a></p>`,
  );
}
