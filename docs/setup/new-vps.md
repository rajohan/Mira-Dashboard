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

- `OPENCLAW_GATEWAY_TOKEN` or a bootstrap-entered token stored encrypted in SQLite;
- `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY` for the encrypted Gateway-token
  envelope and TOTP factors;
- one stable HTTPS hostname configured through
  `MIRA_DASHBOARD_WEBAUTHN_RP_ID` and
  `MIRA_DASHBOARD_WEBAUTHN_ORIGINS` for security keys;
- separate minimum-scope `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS` entries for
  heartbeat, task tracking, and report producers;
- `MIRA_GITHUB_TOKEN` for Dashboard PR operations;
- optional provider keys for Moltbook, ElevenLabs, OpenRouter, and Synthetic
  health checks depending on enabled Dashboard features.

## Provision Local OpenClaw API Callers

The Dashboard does not trust localhost as an identity. From the Dashboard
checkout, provision four independent caller credentials:

```bash
cd /home/ubuntu/projects/mira-dashboard
install -d -m 0700 /home/ubuntu/.config/mira-dashboard/automation
bun scripts/provisionDashboardAutomationCredential.ts heartbeat
bun scripts/provisionDashboardAutomationCredential.ts daily-summary
bun scripts/provisionDashboardAutomationCredential.ts daily-brief
bun scripts/provisionDashboardAutomationCredential.ts task-tracking
```

The provisioner writes the full tokens directly to four owner-only `0600`
files under `/home/ubuntu/.config/mira-dashboard/automation/`. It prints only
the corresponding ids, SHA-256 validator hashes, and minimum scopes. Combine
those four printed objects into the JSON array supplied through the Doppler
secret `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS`.

Do not copy the full token files into Doppler, SQLite, shell history, prompts,
cron payloads, reports, or host backups. A replacement host gets newly
generated tokens and an updated hash-only Doppler array. See
[Scoped automation credentials](../security/auth-and-trust-boundaries.md#scoped-automation-credentials)
for the exact file names, scopes, wrapper behavior, rotation, and denied-route
tests.

## Create The Systemd User Services

Run this section from an interactive shell as the `ubuntu` user. Use `sudo` only
for the explicit `loginctl` command; the install and `systemctl --user` commands
must target `ubuntu`'s user manager.

Install the tracked web and worker units:

```bash
cd /home/ubuntu/projects/mira-dashboard
install -d -m 0755 /home/ubuntu/.config/systemd/user
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
install -m 0644 systemd/mira-dashboard-worker.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
```

The web role owns HTTP, WebSocket, and the Gateway bridge. The worker role owns
scheduled-job registration, queue claims, cache startup seeds, and action
execution. Both units have explicit CPU, IO, memory, and task guardrails. Heavy
worker children are additionally placed in transient resource-class scopes.

Enable and start both:

```bash
sudo loginctl enable-linger ubuntu
loginctl show-user ubuntu -p Linger
systemctl --user daemon-reload
systemctl --user enable --now mira-dashboard.service mira-dashboard-worker.service
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
```

Lingering keeps the user manager and both services running after the SSH/login
session ends and across reboots.

## Bootstrap The First User

If the database has no users, the UI shows first-user setup. The bootstrap flow:

1. accepts username and password;
2. validates the submitted OpenClaw Gateway token by waiting for a real Gateway
   auth/hello;
3. persists the Gateway token only if validation succeeds;
4. creates the first Dashboard user and auth session.

Bootstrap itself remains password-based and does not require a physical key.
After it succeeds, open **Settings → Dashboard**, enroll two named security
keys (or another deliberate factor combination), and store the one-time
recovery codes offline. Privileged actions remain blocked until MFA is
enrolled.

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
journalctl --user -u mira-dashboard-worker.service -n 100 --no-pager
```

Healthy response shape:

```json
{
    "status": "isOk",
    "gatewayConnected": true,
    "sessionCount": 9,
    "backendCommit": "abc1234",
    "workerOnline": true
}
```

If `gatewayConnected` is false, check the Gateway token, OpenClaw Gateway
service, and `/api/auth/bootstrap` state before debugging the frontend.
If `workerOnline` is false, inspect both Dashboard and
`mira-dashboard-worker.service`; the worker heartbeat may be stale or queue
telemetry may be unavailable.
