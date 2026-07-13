# New VPS Setup

This guide takes a new host from blank-ish Ubuntu VPS to a running Mira
Dashboard backend/frontend service. It assumes the host is part of Raymond's
trusted environment and has access to the private repositories and Doppler
project.

## Prerequisites

- Ubuntu system user with systemd user services available.
- Git access as `mira-2026`.
- Doppler CLI installed and authenticated for project/config `rajohan/prd`.
- Bun installed at `/home/ubuntu/.bun/bin/bun`.
- OpenClaw installed and running its gateway.
- Tailscale or equivalent private access path for the Dashboard UI.

Useful checks:

```bash
git --version
/usr/local/bin/doppler --version
/home/ubuntu/.bun/bin/bun --version
openclaw status
systemctl --user status openclaw-gateway.service
```

## Clone The Repository

Production checkout path:

```bash
mkdir -p /home/ubuntu/projects
cd /home/ubuntu/projects
git clone https://github.com/rajohan/Mira-Dashboard.git mira-dashboard
cd mira-dashboard
```

Install dependencies:

```bash
bun install --frozen-lockfile
cd backend
bun install --frozen-lockfile
```

## Build Frontend And Backend

From the repo root:

```bash
bun run build
```

From `backend/`:

```bash
bun run build
```

The frontend build writes to `dist/`. The backend build writes to
`backend/dist/`.

## Configure Secrets

Dashboard reads production secrets through Doppler:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
doppler run --config prd --project rajohan -- bun dist/serverStart.js
```

See [Secrets and environment](secrets-and-env.md) for the full list. The
minimum production setup normally needs:

- `OPENCLAW_GATEWAY_TOKEN` or a bootstrap-entered token stored in SQLite;
- `MIRA_GITHUB_TOKEN` for Dashboard PR operations;
- optional provider keys for Moltbook, ElevenLabs, OpenRouter, and Synthetic
  health checks depending on enabled Dashboard features.

## Create The Systemd User Service

Service path:

```text
/home/ubuntu/.config/systemd/user/mira-dashboard.service
```

Current production shape:

```ini
[Unit]
Description=Mira Dashboard
After=network-online.target openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/projects/mira-dashboard/backend
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/doppler run --config prd --project rajohan -- /home/ubuntu/.bun/bin/bun dist/serverStart.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now mira-dashboard.service
systemctl --user status mira-dashboard.service --no-pager
```

## Bootstrap The First User

If the database has no users, the UI shows first-user setup. The bootstrap flow:

1. accepts username and password;
2. validates the submitted OpenClaw Gateway token by waiting for a real Gateway
   auth/hello;
3. persists the Gateway token only if validation succeeds;
4. creates the first Dashboard user and auth session.

Check bootstrap state:

```bash
curl http://127.0.0.1:3100/api/auth/bootstrap
```

Expected before setup:

```json
{ "isBootstrapRequired": true, "hasGatewayToken": false }
```

Expected after setup:

```json
{ "isBootstrapRequired": false, "hasGatewayToken": true }
```

## Verify Runtime

```bash
curl http://127.0.0.1:3100/api/health
systemctl --user status mira-dashboard.service --no-pager
journalctl --user -u mira-dashboard.service -n 100 --no-pager
```

Healthy response shape:

```json
{
    "status": "isOk",
    "gatewayConnected": true,
    "sessionCount": 9,
    "backendCommit": "abc1234"
}
```

If `gatewayConnected` is false, check the Gateway token, OpenClaw Gateway
service, and `/api/auth/bootstrap` state before debugging the frontend.
