# New VPS Setup

This guide takes a new host from blank-ish Ubuntu VPS to a running Mira
Dashboard backend/frontend service. It assumes the host is part of Raymond's
trusted environment and has access to the private repositories and Doppler
project.

## Prerequisites

- Ubuntu system user with systemd user services available.
- Git access as `mira-2026`.
- Doppler CLI installed and authenticated for project/config `rajohan/prd`.
- Bun Canary installed at `/home/ubuntu/.bun/bin/bun`, matching the repository
  `.bun-version` channel.
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
install -d -m 0755 \
  /home/ubuntu/projects/mira-dashboard/production \
  /home/ubuntu/projects/mira-dashboard/development
git clone https://github.com/rajohan/Mira-Dashboard.git \
  /home/ubuntu/projects/mira-dashboard/production/checkout
cd /home/ubuntu/projects/mira-dashboard/production/checkout
```

Select the repository runtime channel:

```bash
bun upgrade --canary
bun --revision
```

## Configure Secrets

Dashboard reads production secrets through Doppler project/config
`rajohan/prd`. Configure and verify them before running the production
bootstrap because that command starts both managed services. Do not start
`serverStart.js` manually to test them.

See [Secrets and environment](secrets-and-env.md) for the full list. The
minimum production setup normally needs:

- `OPENCLAW_GATEWAY_TOKEN` or a bootstrap-entered token stored encrypted in SQLite;
- `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY` for the encrypted Gateway-token
  envelope and TOTP factors;
- one stable HTTPS hostname configured through
  `MIRA_DASHBOARD_WEBAUTHN_RP_ID` and
  `MIRA_DASHBOARD_WEBAUTHN_ORIGINS` for security keys;
- `MIRA_GITHUB_TOKEN` for Dashboard PR operations;
- optional provider keys for Moltbook, ElevenLabs, OpenRouter, and Synthetic
  health checks depending on enabled Dashboard features.

The automation credential hashes are intentionally added immediately after the
initial bootstrap by following the provisioning section below. Their temporary
absence does not block service startup; it only leaves those local API callers
unauthorized until both services are restarted with the generated hashes.

## Run The Production Bootstrap

Run one command from the clean production checkout as the `ubuntu` user:

```bash
cd /home/ubuntu/projects/mira-dashboard/production/checkout
bun run deploy:bootstrap
```

The command performs the complete first managed activation:

1. enables systemd linger through `sudo loginctl` if it is not already enabled;
2. installs frozen control-checkout dependencies;
3. creates the production release, runtime, state, and development-worktree
   directories with their required modes;
4. verifies that the production checkout is clean and resolves its exact full SHA;
5. initializes SQLite in WAL mode, applies every immutable migration, and runs
   `PRAGMA quick_check`;
6. stages and preflights the SHA from an isolated worktree, then caches its
   exact revision-qualified Bun executable;
7. activates the release, atomically installs and verifies both tracked
   systemd unit files, and reloads the user manager;
8. enables and restarts both services, then polls within a bounded startup window
   until both become enabled and running.

Run the command as the managed user, not with `sudo`; only its one
`loginctl enable-linger` child needs root. A normal sudo prompt may appear on a
host without passwordless sudo. Re-running the same checked-out SHA is safe and
repairs missing unit/runtime state. The command refuses to replace a different
existing current release; use the normal Dashboard deployment path for that.

The control checkout is not a production runtime directory. See
[Production deploy](production-deploy.md) for the release/state layout,
automatic rollback, retention, and recovery contract.

## Provision Local OpenClaw API Callers

The Dashboard does not trust localhost as an identity. From the Dashboard
checkout, provision four independent caller credentials:

```bash
cd /home/ubuntu/projects/mira-dashboard/production/checkout
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

After adding or replacing that Doppler value, restart both managed services so
they load the new validator hashes:

```bash
systemctl --user restart mira-dashboard-worker.service mira-dashboard.service
```

Do not copy the full token files into Doppler, SQLite, shell history, prompts,
cron payloads, reports, or host backups. A replacement host gets newly
generated tokens and an updated hash-only Doppler array. See
[Scoped automation credentials](../security/auth-and-trust-boundaries.md#scoped-automation-credentials)
for the exact file names, scopes, wrapper behavior, rotation, and denied-route
tests.

## Managed Systemd User Services

`deploy:bootstrap` installs, enables, restarts, and verifies the tracked web and
worker units. No separate unit-file installation or `daemon-reload` is needed.

The web role owns HTTP, WebSocket, and the Gateway bridge. The worker role owns
scheduled-job registration, queue claims, cache startup seeds, and action
execution. Both units have explicit CPU, IO, memory, and task guardrails. Heavy
worker children are additionally placed in transient resource-class scopes.

Optional status checks:

```bash
loginctl show-user ubuntu -p Linger
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
curl --fail http://127.0.0.1:3100/api/health/ready
systemctl --user status mira-dashboard.service --no-pager
journalctl --user -u mira-dashboard.service -n 100 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 100 --no-pager
```

Healthy response shape:

```json
{
    "checks": {
        "database": {
            "currentSchemaVersion": 8,
            "maximumCompatibleSchemaVersion": 8,
            "minimumCompatibleSchemaVersion": 6,
            "ready": true,
            "targetSchemaVersion": 8
        },
        "frontend": { "ready": true },
        "release": {
            "backendCommit": "12345678",
            "frontendCommit": "12345678",
            "manifestFormatVersion": 2,
            "ready": true,
            "source": "manifest"
        },
        "worker": { "ready": true }
    },
    "dependencies": { "gatewayConnected": true },
    "status": "isReady"
}
```

The authenticated Dashboard header shows `WS`, `BE`, and `WK` separately. If
`WS` is offline, check the Gateway token, OpenClaw Gateway service, and
`/api/auth/bootstrap` state before debugging the frontend. If `WK` is offline,
inspect both Dashboard and `mira-dashboard-worker.service`; the worker heartbeat
may be stale, belong to another release commit, or queue telemetry may be
unavailable.
