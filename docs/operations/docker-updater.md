# Docker Updater

Dashboard tracks and updates selected Docker Compose services under the
Docker/Stremio repo. It is designed for managed image bumps, not arbitrary
compose rewriting.

## Configuration

Important environment variables:

| Variable                                     | Purpose                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `MIRA_DOCKER_COMPOSE_WRAPPER`                | Command used to run compose operations. Production commonly uses `/opt/docker/bin/docker-compose-doppler`. |
| `MIRA_DOCKER_UPDATER_PLATFORM`               | Optional platform override for registry lookups.                                                           |
| `MIRA_DOCKER_UPDATER_SKIP_REGISTRY`          | Set `1` only for tests/debugging to skip registry checks.                                                  |
| `DOCKER_LOGIN` + `DOCKER_TOKEN`              | Docker Hub auth. Both are required; token alone is ignored.                                                |
| `MIRA_GITHUB_USERNAME` + `MIRA_GITHUB_TOKEN` | GHCR auth for registry lookups where needed.                                                               |

Validate production compose after manual changes:

```bash
cd /opt/docker
/opt/docker/bin/docker-compose-doppler config
```

## Supported Registries

The updater handles:

- Docker Hub (`docker.io`)
- GitHub Container Registry (`ghcr.io`)
- LinuxServer registry (`lscr.io`)

Unsupported registry/image formats should be treated as manual updates.

## Managed Service State

Docker updater state is stored in SQLite:

| Table                     | Purpose                                          |
| ------------------------- | ------------------------------------------------ |
| `docker_managed_services` | Services Dashboard is allowed to inspect/update. |
| `docker_update_events`    | Update check/apply history and errors.           |

The Docker page reads this state and backend registry probes. The scheduled job
can check for updates in the background when schedulers are enabled.

## Git Sync

After a successful Dashboard-managed image update, the updater attempts a
best-effort git sync for the compose files changed by that updater run. The sync
adds, commits, and pushes only those safe compose pathspecs. A git sync failure
is recorded as a `git-sync:docker` step, but it does not make the Docker update
itself fail after the container and updater state have already been updated.
If Compose succeeds but updater state reconciliation fails, the changed compose
paths are still passed to the same best-effort git sync so the deployed image
change is not left dirty solely because SQLite reconciliation failed.

## Compose File Rewrite Rules

The updater preserves human-readable YAML formatting for normal image updates.
It rewrites only the direct service-level `image:` line:

```yaml
services:
    app:
        image: ghcr.io/example/app:1.2.3
```

It must not rewrite:

- nested `image:` keys under `build`, labels, anchors, or templates;
- service names that appear as nested keys under another service;
- `services:` blocks inside extension/template maps.

For complex YAML scalar forms, such as block scalars or anchored/tagged scalar
image values, the updater falls back to structured YAML writing instead of raw
line replacement.

## Safe Manual Update Flow

```bash
cd /opt/docker
git status --short
/opt/docker/bin/docker-compose-doppler config
```

After Dashboard applies an update:

```bash
git diff -- apps/<service>/compose.yaml
/opt/docker/bin/docker-compose-doppler config
```

Only commit intended image changes and formatting-preserving rewrites.

## Troubleshooting

| Symptom                                       | Check                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Registry checks unauthenticated               | Ensure `DOCKER_LOGIN` and `DOCKER_TOKEN` are both set.                                                                              |
| GHCR rate/auth errors                         | Check `MIRA_GITHUB_USERNAME` and `MIRA_GITHUB_TOKEN`.                                                                               |
| Compose validates locally but Dashboard fails | Confirm `MIRA_DOCKER_COMPOSE_WRAPPER` points to the same wrapper you used manually.                                                 |
| Compose file collapsed to one line            | This should not happen with current updater code; inspect recent commits and restore readable YAML before applying further updates. |
| Wrong image changed                           | Check direct-child rewrite rules and add a regression test before retrying.                                                         |
