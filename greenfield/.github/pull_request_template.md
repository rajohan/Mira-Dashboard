## Summary

<!-- What changed, and why? Keep this short and concrete. -->

## Behavior and regression coverage

<!-- Describe visible/API behavior and the regression test that protects it. -->

## Verification

<!-- Check everything you ran. Leave unchecked with a short reason if not applicable. -->

- [ ] Repository lint: `bun run lint`
- [ ] Repository formatting: `bun run format:check`
- [ ] Source boundaries: `bun run check:boundaries`
- [ ] TypeScript graphs: `bun run typecheck`
- [ ] Dashboard tests: `bun run test`
- [ ] Coverage threshold: `bun run test:coverage`
- [ ] Generated docs and database graph: `bun run docs:check && bun run db:check`
- [ ] Focused regression tests: <!-- command(s) -->
- [ ] Manual UI/API smoke check, if relevant

## Risk checklist

- [ ] No secrets, tokens, `.env` files, database dumps, or runtime state committed
- [ ] Auth, Gateway, terminal, file, Docker, or settings changes were reviewed carefully
- [ ] New/changed API routes enforce the expected authentication and validation
- [ ] Migrations or data-shape changes include a rollout/rollback note, if relevant
- [ ] Runtime/reconnect behavior preserves ordering, idempotency, and recovery
- [ ] UI changes include screenshots or a short description of visible changes

## Deployment / operations

- [ ] No deploy/restart needed
- [ ] Deploy/restart needed after merge: <!-- service(s), reason, and timing -->
- [ ] Config/secrets changes needed: <!-- describe, do not paste secrets -->
- [ ] Rollback path verified: <!-- previous bundle/commit, backup, or recovery action -->

## Notes for reviewers

<!-- Anything specific reviewers should focus on? -->
