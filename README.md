# Mira Dashboard

[![coverage](https://img.shields.io/codecov/c/github/rajohan/Mira-Dashboard?branch=main&label=coverage&logo=codecov)](https://codecov.io/gh/rajohan/Mira-Dashboard)
[![checks](https://img.shields.io/github/actions/workflow/status/rajohan/Mira-Dashboard/dashboard-checks.yml?branch=main&label=checks&logo=github)](https://github.com/rajohan/Mira-Dashboard/actions/workflows/dashboard-checks.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/rajohan/Mira-Dashboard/codeql.yml?branch=main&label=codeql&logo=github)](https://github.com/rajohan/Mira-Dashboard/actions/workflows/codeql.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![License](https://img.shields.io/github/license/rajohan/Mira-Dashboard)](LICENSE)

This is the self-contained Dashboard repository root. Application source lives in `src/`,
repository tooling in `scripts/`, migrations in `migrations/`, and project configuration at the
root. The retired implementation has been removed; no compatibility source tree remains.

## Local verification

Use the Bun revision selected by `.bun-version`, then run:

```bash
bun install --frozen-lockfile
bun run check
bun run build browser
bun run build processes
bun run test
bun run test coverage
```

For a fresh development checkout, `bun run bootstrap development` combines frozen install,
generated checks, isolated state preparation, and local start. Bare `bun run bootstrap` owns the
complete first installation on a clean production host. The
[command reference](docs/development/commands.md) documents every public entrypoint and subcommand.

`bun run build release` additionally requires a clean Git tree. It produces a commit-addressed
immutable release containing browser/process artifacts, migrations, generated documentation,
package/runtime identity, and the reviewed systemd units; it does not mutate production.

## Account recovery

Bootstrap registers the account's recovery email and sends a verification link. The account stays
usable before verification, and the address can be corrected or resent from Account email. A
verified address remains active while a replacement is pending. Forgotten passwords use the
**Forgot password?** flow on the sign-in page; successful reset preserves MFA and revokes existing
sessions. See the [account-recovery runbook](docs/operations/runbooks.md#account-email-verification-and-forgotten-password).

## Documentation

- [Documentation index](docs/index.md)
- [Rewrite blueprint](docs/architecture/greenfield-rewrite.md)
- [Generated reference](docs/generated/README.md)
- [Local development](docs/development/local-development.md)
- [Testing and pull requests](docs/development/testing-and-prs.md)
- [Storybook](docs/development/storybook.md)
- [Operator runbooks](docs/operations/runbooks.md)
- [Authentication trust boundaries](docs/security/auth-and-trust-boundaries.md)

## Repository transition

The rewrite source has been promoted to the repository root and the retired application tree has
been removed. Production remains unchanged until a reviewed root-layout commit is activated.
Persistent state stays in the existing `<project-root>/production/state` project tree and is never
stored in the checkout.
