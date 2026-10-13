# Slack App Manifests (`bsuit.app`)

This directory contains official **Slack App Manifests** (YAML) pre-configured with the production Cloudflare Tunnel endpoints (`*.bsuit.app`) and optimized for minimum required OAuth scopes.

## Available Manifests

1. [`manifest-secret.yaml`](./manifest-secret.yaml) — Production manifest for **Secret App** (`https://secret.bsuit.app`, `/secret` command, `chat:write`, `chat:write.public`).
2. [`manifest-queue.yaml`](./manifest-queue.yaml) — Production manifest for **Queue App** (`https://queue.bsuit.app`, `/queue` command, `chat:write`, `chat:write.public`, `users:read`).
3. [`manifest-todo.yaml`](./manifest-todo.yaml) — Production manifest for **Todo App** (`https://todo.bsuit.app`, `/todo` command, message shortcut, App Home).
4. [`manifest-dev-suite.yaml`](./manifest-dev-suite.yaml) — All-in-one test bot combining `/secret`, `/queue`, and `/todo` into a single Slack App.

## Production Endpoints (`bsuit.app`)

| App | Slash Commands URL | Interactivity URL | Events URL |
| :--- | :--- | :--- | :--- |
| **Secret** | `https://secret.bsuit.app/slack/commands` | `https://secret.bsuit.app/slack/interactions` | — |
| **Queue** | `https://queue.bsuit.app/slack/commands` | `https://queue.bsuit.app/slack/interactions` | — |
| **Todo** | `https://todo.bsuit.app/slack/commands` | `https://todo.bsuit.app/slack/interactions` | `https://todo.bsuit.app/slack/events` |

## How to Import into Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** > **From an app manifest** (or select your existing app > **App Manifest** in the sidebar).
3. Copy the contents of the chosen manifest file (e.g., [`manifest-secret.yaml`](./manifest-secret.yaml)) and paste it into the **YAML** tab.
4. Click **Save Changes** (or **Next** > **Create**).
5. Navigate to **Install App** in the left sidebar and click **Install to Workspace**.
6. Copy the **Signing Secret** (from **Basic Information**) into your `infra/02-releases/terraform.tfvars` under `projects["<app>"].signing_secret`.
