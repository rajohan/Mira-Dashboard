## Summary

<!-- What changed, and why? Keep this short and concrete. -->

## Verification

<!-- Check everything you ran. Leave unchecked with a short reason if not applicable. -->

- [ ] Frontend lint: `npm run lint`
- [ ] Frontend tests/coverage: `npm run test:coverage`
- [ ] Frontend build: `npm run build`
- [ ] Backend lint: `npm run lint` from `backend/`
- [ ] Backend tests/coverage: `npm run test:coverage` from `backend/`
- [ ] Backend build: `npm run build` from `backend/`
- [ ] Playwright smoke tests: `npm run test:e2e`
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
