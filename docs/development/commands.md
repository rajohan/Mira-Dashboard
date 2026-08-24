# Repository commands

`package.json` exposes nine stable entrypoints. Typed subcommands keep implementation partitions out
of the package-script list while preserving explicit, shell-free argument handling.

| Command                                                                      | Purpose                                                                                                     | Writes or starts processes                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `bun run bootstrap [--doppler] [--no-start] [--with-browser]`                | Frozen first install, generated checks, isolated development-state preparation, then local start by default | Installs dependencies/state; optionally Chromium/Doppler start      |
| `bun run dev [run]`                                                          | Start the ordinary isolated development stack                                                               | Starts frontend, web, and worker                                    |
| `bun run dev doppler [remote [enable\|disable\|status]]`                     | Run the same development command with the fixed Doppler allowlist                                           | Reads allowed secrets; may manage the dedicated dev Tailscale route |
| `bun run dev prepare-state`                                                  | Prepare isolated marked development state                                                                   | Creates/repairs development state only                              |
| `bun run dev reset-database`                                                 | Remove only the marked development database and sidecars                                                    | Destructive only inside validated development state                 |
| `bun run dev reset-state`                                                    | Remove the complete marked development state root                                                           | Destructive only inside validated development state                 |
| `bun run dev remote [enable\|disable\|status]`                               | Start remote development or manage its dedicated Tailscale route                                            | Starts dev and/or changes only the reviewed dev route               |
| `bun run check`                                                              | Format, hooks, lint, TypeScript, boundaries, docs, and database schema                                      | Read-only                                                           |
| `bun run check <format\|lint> --fix`                                         | Apply configured formatter or safe lint fixes                                                               | Writes source files                                                 |
| `bun run check <boundaries\|database\|docs\|format\|hooks\|lint\|typecheck>` | Run one focused check                                                                                       | Read-only without `--fix`                                           |
| `bun run build <browser\|processes\|storybook>`                              | Build one artifact class                                                                                    | Writes under `dist/`                                                |
| `bun run build release`                                                      | Build and freeze one clean commit-addressed immutable release                                               | Requires clean Git; writes under `dist/releases/`                   |
| `bun run generate <docs\|database>`                                          | Regenerate checked-in docs or the unpublished pre-cutover migration snapshot                                | Writes generated files; review the diff                             |
| `bun run test [all\|bun\|browser\|storybook]`                                | Run all tests or one runtime partition                                                                      | Test artifacts only; Storybook installs Chromium if absent          |
| `bun run test coverage [bun\|browser\|storybook\|merge]`                     | Run/merge aggregate and Git-diff patch coverage                                                             | Writes `coverage/`; installs Chromium only when needed              |
| `bun run test timings <bun\|browser\|storybook>`                             | Refresh one timing inventory after its complete partition passes                                            | Replaces one checked-in timing file                                 |
| `bun run storybook [dev\|build]`                                             | Start the workbench or build static Storybook                                                               | Starts upstream port 6007 or writes `dist/storybook`                |
| `bun run delivery <prepare-state\|activate> ...`                             | Prepare protected production state or activate an already-qualified immutable release                       | Production-sensitive; can change active production                  |
| `bun run preflight [--parallel]`                                             | Prove a clean candidate through audit, checks, coverage, builds, and immutable release creation             | Sequential by default; `--parallel` uses bounded two-command phases |

Internal files under `scripts/` are not additional public commands. CI uses the same entrypoints and
passes explicit partitions rather than calling implementation files. The root provisioning
installer is intentionally absent: its independent manifest digest and root-owned staging boundary
must not be weakened into an application-owned package command.

The SSE resource-evidence runner remains at
`src/test/integration/resources/runSseMemoryEvidence.ts` for explicit runtime qualification. It is
not an everyday package command and does not run implicitly during ordinary development.

`preflight` and `delivery` deliberately remain separate: preflight proves that one unchanged source
commit can produce a qualified immutable artifact, while delivery performs the stateful preparation
or activation of that artifact. Passing preflight never grants or implies production authority.
The optional `--parallel` mode still installs first and builds the immutable release last. Between
those boundaries it runs audit with static checks, then coverage with the Storybook build. This
bounded two-command concurrency is intended for an isolated worker with at least 4 vCPU and 8 GiB;
the default remains the lower-risk sequential path.

## Tooling decisions

Lefthook is the single Git-hook manager. Its config and portable hook wrappers live at the
repository root; bootstrap points the checkout-local Git hook path at those wrappers, and configuration
validation is part of `bun run check`. Pre-commit runs fast format and
lint checks in parallel; pre-push runs the complete read-only check. Hooks improve local feedback
only—GitHub checks remain authoritative and hooks never receive secrets.

Pino is intentionally not installed. The Dashboard already owns one structured logger plus its
Effect bridge, with recursive redaction, bounded fields and records, process/release identity,
level policy, project-file output, and constant sink-failure fallback. Adding Pino would duplicate
that process-wide logging boundary without closing an unmet capability.

Storybook coverage is inventory-driven: every production route and each material route state must
map to a real page/component story. Authentication coverage includes bootstrap, password login,
forgot/reset password, email-verification success/error, pending MFA, and account-email change.
Generic form-layout stories remain component examples and do not duplicate route-owned controls.
