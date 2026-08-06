## Summary

Describe the user-visible problem and the implemented behavior.

## Safety and boundaries

- [ ] No real credentials, account data, local databases, logs, or generated build output are included.
- [ ] The app remains local-only with no telemetry or maintainer-controlled service.
- [ ] Trading-lock, order-state, reconciliation, credential, and network-boundary impacts are explained.
- [ ] New schema changes use a new migration; existing migrations were not edited.
- [ ] New code is compatible with AGPL-3.0-only and third-party license notices are preserved.

## Verification

- [ ] `npm run verify`
- [ ] Regression tests cover the change.
- [ ] Relevant light/dark, keyboard, launcher, or Docker behavior was checked.

## Notes

List manual tests, screenshots, follow-up work, and any behavior that could not be verified locally.
