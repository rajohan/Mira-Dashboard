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
bun run test
bun run docs:check
bun run db:check
```

The root CI copies these contents into an isolated temporary directory before installing
dependencies and running the same gates. This prevents an accidental dependency on the
coexisting application or its `node_modules`.

## Documentation

- [Documentation index](docs/index.md)
- [Rewrite blueprint](docs/architecture/greenfield-rewrite.md)
- [Generated reference](docs/generated/README.md)
- [Testing and pull requests](docs/development/testing-and-prs.md)

## Cutover

Cutover preserves the Git repository metadata, removes the retired application tree, and promotes
the **contents** of this directory to the repository root. No application import or configuration
path should need rewriting during that promotion.
