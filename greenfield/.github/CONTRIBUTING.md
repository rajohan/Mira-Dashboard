# Contributing to Mira Dashboard

Thanks for helping improve Mira Dashboard.

## Development flow

- Create a branch from `main`.
- Open a pull request for every change.
- Do not push directly to `main`.
- Keep pull requests focused and small enough to review comfortably.
- Use squash merge when merging accepted pull requests.

## Before opening a pull request

Run the relevant checks locally when possible:

```bash
bun run lint
bun run format:check
bun run check:boundaries
bun run typecheck
bun run test
bun run docs:check
bun run db:check
```

Run focused tests while iterating, then run the applicable coverage suite before
handoff. For visible behavior, add a short manual smoke result or screenshot. If
a check cannot be run locally, explain why in the pull request.

## Pull request requirements

Pull requests must satisfy the repository rules before merging:

- Required status checks must pass.
- Every changed runtime boundary must retain focused regression coverage.
- CodeQL/code scanning checks must pass.
- Code owner review is required.
- Conversations should be resolved before merge.
- Merge commits are avoided; use squash merge.

## Security

Do not open public issues for vulnerabilities. Use GitHub private vulnerability reporting when available, or follow the instructions in `SECURITY.md`.

Never commit secrets, tokens, private keys, production data, or `.env` files.
