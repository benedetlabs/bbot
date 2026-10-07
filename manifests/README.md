# Slack App Manifests

This directory contains official **Slack App Manifests** (YAML) configured with
English as the primary language and optimized for minimum required OAuth scopes.

## Available Manifests

1. [`manifest-secret.yaml`](./manifest-secret.yaml) — Production manifest for
   **Secret App** (`/secret` command, `chat:write`, `chat:write.public`).
2. [`manifest-queue.yaml`](./manifest-queue.yaml) — Production manifest for
   **Queue App** (`/queue` command, `chat:write`, `chat:write.public`,
   `users:read`).
3. [`manifest-todo.yaml`](./manifest-todo.yaml) — Production manifest for **Todo
   App** (`/todo` command, message shortcut, App Home).
4. [`manifest-dev-suite.yaml`](./manifest-dev-suite.yaml) — All-in-one local
   test bot combining `/secret`, `/queue`, and `/todo` into a single Slack App
   for sandbox testing.

## How to Import into Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** > **From an app manifest**.
3. Select your development workspace.
4. Copy the contents of the chosen manifest file and paste it into the **YAML**
   tab.
5. Replace `your-domain.com` with your active tunnel (e.g., ngrok or cloudflared
   URL — see [`TUNNEL_SETUP.md`](../TUNNEL_SETUP.md)) or production domain.
6. Click **Next** > **Create**.
7. Navigate to **Install App** in the left sidebar and click **Install to
   Workspace**.
8. Copy the **Signing Secret** (from Basic Information) and **Bot User OAuth
   Token** (from OAuth & Permissions) into your `.env` file.
