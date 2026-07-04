# Testing And PR Workflow

## Standard Gates

Root/frontend:

```bash
bun run lint
bun run build
bun run test
bun run test:coverage
bun run format:check
```

Backend:

```bash
cd backend
bun run lint
bun run build
bun run test
bun run test:coverage
bun run format:check
```

Docs-only changes usually need:

```bash
git diff --check
```

## Coverage

Coverage is uploaded to Codecov with two flags:

- `frontend`
- `backend`

Local total coverage can differ from Codecov patch coverage. When Codecov
fails, inspect the patch coverage and missing lines instead of relying only on
the local total percentage.

Do not use ignore comments or coverage config to hide meaningful gaps. Add
targeted functional coverage.

## GitHub Checks

Workflows:

- `Dashboard checks`: frontend and backend lint/build/coverage.
- `CodeQL`: JavaScript/TypeScript security and quality analysis.

Required PR reality:

- human review may still block even when checks are green;
- CodeRabbit can be advisory and sometimes rate-limited;
- Codecov patch failures need actual coverage or reduced risky diff.

## PR Hygiene

Use `mira-2026` git identity and GitHub token. Do not use connector write tools
that may authenticate as Raymond.

When creating/editing PR bodies, write the body to a temp file and use
`--body-file`; do not pass escaped newlines inline.

Verify body formatting:

```bash
GITHUB_TOKEN="$MIRA_GITHUB_TOKEN" gh pr view <number> --json body --jq .body | sed -n l
```

Expected: line endings shown as `$`, not literal `\\n`.

Apply useful labels. Common Dashboard labels:

- `type: documentation`
- `type: bugfix`
- `type: feature`
- `type: maintenance`
- `type: security`
- `area: frontend`
- `area: backend`
- `area: ci`
- `area: docker`
- `area: auth`
- `area: openclaw`
- `area: ops`

## Production Checkout

Feature and autopilot PR work must not edit, build, or pull inside the
production checkout. Do the implementation and verification in a separate
worktree, then finish with a read-only check that production is still clean
`main`:

```bash
cd /home/ubuntu/projects/mira-dashboard
git status --short --branch
```

Syncing the production checkout with `git pull --ff-only` belongs in the
approved deploy workflow, not in background PR preparation.
