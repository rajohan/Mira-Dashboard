# Contributing to Mira Dashboard

Thanks for helping improve Mira Dashboard.

## Development flow

- Create a branch from `master`.
- Open a pull request for every change.
- Do not push directly to `master`.
- Keep pull requests focused and small enough to review comfortably.
- Use squash merge when merging accepted pull requests.

## Before opening a pull request

Run the relevant checks locally when possible:

```bash
npm run lint
npm run build
npm test
```

For browser-facing changes, also run the relevant Playwright tests:

```bash
npm run test:e2e
```

If a check cannot be run locally, mention that in the pull request notes.

## Pull request requirements

Pull requests must satisfy the repository rules before merging:

- Required status checks must pass.
- CodeQL/code scanning checks must pass.
- Code owner review is required.
- Conversations should be resolved before merge.
- Merge commits are avoided; use squash merge.

## Security

Do not open public issues for vulnerabilities. Use GitHub private vulnerability reporting when available, or follow the instructions in `SECURITY.md`.

Never commit secrets, tokens, private keys, production data, or `.env` files.
