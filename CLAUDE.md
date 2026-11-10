# Run315

Notes for the coding agent that works on this repo.

## House standards (shared across every app by this maker)

@../CoworkSyncHub/HOUSE-STANDARDS.md

For this app:
- Check the standards: `node ../CoworkSyncHub/standards.mjs run315 -v`. Keep it all `ok` before pushing.
- Test: `npm run lint && npm test` (tests pin TZ=UTC via test/tz.mjs; pin a zone explicitly to test local days)
- Deploy: push to main: pages.yml tests, publishes, live-checks and tags
- Work on `main`, push your own work when it passes, and add user-visible changes to `whatsnew.json`.
