# Gatekeep GitHub Action

> Pause GitHub Actions workflows until an authorized human approves the action in Slack with cryptographic parameter binding (RFC 8785).

## Usage

```yaml
name: Deploy Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Request Slack Approval
        id: gatekeep
        uses: benedetlabs/gatekeep-action@v1
        with:
          api_key: ${{ secrets.GATEKEEP_API_KEY }}
          action: "deploy.k8s.production"
          target: "civo:production-cluster"
          params: |
            {
              "commit": "${{ github.sha }}",
              "branch": "${{ github.ref_name }}",
              "actor": "${{ github.actor }}"
            }
          justification: "Production release triggered on push to main"
          server_url: "https://gatekeep.bsuit.app"
          timeout_minutes: 15

      - name: Run Production Release
        run: |
          echo "Approved by: ${{ steps.gatekeep.outputs.decided_by }}"
          echo "Verified hash: ${{ steps.gatekeep.outputs.params_hash }}"
          echo "Execution token: ${{ steps.gatekeep.outputs.approval_token }}"
          # Deploy commands...
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api_key` | **Yes** | | Gatekeep Agent API key (`gk_live_...`). |
| `action` | **Yes** | | Identifier for the action (e.g. `deploy.k8s`, `stripe.refund`). |
| `target` | No | `""` | Target resource or environment (e.g. `civo:k8s`). |
| `params` | No | `{}` | JSON string of parameters to be reviewed and cryptographically bound. |
| `justification` | No | `""` | Optional rationale shown on the Slack card. |
| `on_behalf_of` | No | `""` | Slack user ID of the initiator. |
| `server_url` | No | `https://gatekeep.bsuit.app` | URL of the Gatekeep instance. |
| `timeout_minutes` | No | `15` | Timeout before default-deny rejection. |

## Outputs

| Output | Description |
|---|---|
| `status` | Approval status (`approved` or `edited`). |
| `approval_token` | Single-use token to consume at `/v1/requests/:id/consume`. |
| `params_hash` | Canonical RFC 8785 SHA-256 hash of approved parameters. |
| `decided_by` | Slack user ID of the reviewer who approved the action. |
| `request_id` | Public ID of the request (e.g. `gk_req_...`). |
