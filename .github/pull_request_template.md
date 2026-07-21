## Summary

<!-- What changed, and why? Keep this short and concrete. -->

## Behavior and regression coverage

<!-- Describe visible/API behavior and the regression test that protects it. -->

## Verification

<!-- Check everything you ran. Leave unchecked with a short reason if not applicable. -->

- [ ] Frontend lint: `bun run lint`
- [ ] Frontend build: `bun run build`
- [ ] Frontend tests/coverage: `bun run test:coverage`
- [ ] Backend lint: `bun run lint` from `backend/`
- [ ] Backend build: `bun run build` from `backend/`
- [ ] Backend tests/coverage: `bun run test:coverage` from `backend/`
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
