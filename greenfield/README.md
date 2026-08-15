# Mira Dashboard

This directory is the self-contained future repository root for the Dashboard rewrite.
Its contents use their final post-cutover paths: application source lives in `src/`,
repository tooling in `scripts/`, migrations in `migrations/`, and project configuration
at this directory root.

Until cutover, the current production application remains outside this directory. Greenfield
source, tests, tooling, configuration, and documentation must not import, read, or resolve files
from that parent tree.

## Local verification

Use the Bun revision selected by `.bun-version`, then run:

```bash
bun install --frozen-lockfile
bun run check:boundaries
bun run typecheck
bun run lint
bun run format:check
bun run build:browser
bun run build:processes
bun run test
bun run test:coverage
bun run docs:check
bun run db:check
```

The root CI copies these contents into an isolated temporary directory before installing
dependencies and running the same gates. This prevents an accidental dependency on the
coexisting application or its `node_modules`.

`bun run build:release` additionally requires a clean Git tree. It produces a commit-addressed
immutable release containing browser/process artifacts, migrations, generated documentation,
package/runtime identity, and the reviewed systemd units; it does not mutate production.

## Host password recovery

An operator with an interactive terminal on the Dashboard host can reset a forgotten Dashboard
password through the active, manifest-bound production release:

```bash
cd /home/ubuntu/projects/mira-dashboard/production/checkout
bun run auth:reset-password -- --username <username>
```

Add `--reset-mfa` only for break-glass recovery that must also remove the user's authenticator
apps, security keys, and recovery codes. The command prompts twice with terminal echo disabled;
never place the new password in arguments, environment variables, shell history, or messages.
See the [password-recovery runbook](docs/operations/runbooks.md#forgotten-dashboard-password).

## Documentation

- [Documentation index](docs/index.md)
- [Rewrite blueprint](docs/architecture/greenfield-rewrite.md)
- [Generated reference](docs/generated/README.md)
- [Local development](docs/development/local-development.md)
- [Testing and pull requests](docs/development/testing-and-prs.md)
- [Storybook](docs/development/storybook.md)
- [Operator runbooks](docs/operations/runbooks.md)
- [Authentication trust boundaries](docs/security/auth-and-trust-boundaries.md)

## Cutover

Cutover preserves the Git repository metadata, removes the retired application tree, and promotes
the **contents** of this directory to the repository root. No application import or configuration
path should need rewriting during that promotion. Persistent state stays in the existing
`<project-root>/production/state` project tree and is not moved outside the Dashboard project.
