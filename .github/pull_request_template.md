## Summary

<!-- What changed, and why? Keep this short and concrete. -->

## Verification

<!-- Check everything you ran. Leave unchecked with a short reason if not applicable. -->

- [ ] Frontend lint: `bun run lint`
- [ ] Frontend tests/coverage: `bun run test:coverage`
- [ ] Frontend build: `bun run build`
- [ ] Backend lint: `bun run lint` from `backend/`
- [ ] Backend tests/coverage: `bun run test:coverage` from `backend/`
- [ ] Backend build: `bun run build` from `backend/`
- [ ] Manual UI/API smoke check, if relevant

## Risk checklist

- [ ] No secrets, tokens, `.env` files, database dumps, or runtime state committed
- [ ] Auth, Gateway, terminal, file, Docker, or settings changes were reviewed carefully
- [ ] New/changed API routes enforce the expected authentication and validation
- [ ] Migrations or data-shape changes include a rollout/rollback note, if relevant
- [ ] UI changes include screenshots or a short description of visible changes

## Deployment / operations

- [ ] No deploy/restart needed
- [ ] Deploy/restart needed after merge: <!-- service(s), reason, and timing -->
- [ ] Config/secrets changes needed: <!-- describe, do not paste secrets -->

## Notes for reviewers

<!-- Anything specific reviewers should focus on? -->
