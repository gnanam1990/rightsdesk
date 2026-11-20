# RightsDesk · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Asset A revision 3 has hash H3. A signed grant permits one newsroom's India edition on web, editorial use, territory IN, named attribution, from 2030-01-01T00:00Z up to but excluding 2030-02-01T00:00Z. A Jan 20 controlled IN edition carrying the exact credit and H3 is allowed. A global edition is denied. A request lacking evidence of distribution controls is referred for review. Payment without the signed grant yields paid_awaiting_grant and no publish permit. At the expiry instant the old decision cannot authorize publication.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Rights-holder and asset registry • expected behavior

Status: NOT_RUN

A verified seller registers H3 and can expose its active offer to the newsroom.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Rights-holder and asset registry • failure boundary

Status: NOT_RUN

An editor acting as a seller or an unverified key cannot issue a trusted grant.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Offer and editorial intent • expected behavior

Status: NOT_RUN

The Jan 20 India web editorial intent matches the declared H3 offer.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Offer and editorial intent • failure boundary

Status: NOT_RUN

An unknown legal clause is explicitly referred for rights review rather than silently ignored.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Purchase and grant acquisition • expected behavior

Status: NOT_RUN

Retries after confirmed settlement recover one matching seller-issued grant for the original order.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Purchase and grant acquisition • failure boundary

Status: NOT_RUN

A paid order with unavailable issuer remains paid_awaiting_grant and cannot generate a publication permit.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Deterministic usage evaluator • expected behavior

Status: NOT_RUN

The fully supported H3 India fixture with attribution returns allow; its global counterpart returns deny.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Deterministic usage evaluator • failure boundary

Status: NOT_RUN

The exact expiry instant yields deny, and unknown distribution control in an otherwise compatible restricted edition yields review_required.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Release hook and concurrency • expected behavior

Status: NOT_RUN

Publishing the same approved artifact twice through retry records one logical release.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Release hook and concurrency • failure boundary

Status: NOT_RUN

Swapping H3 for H4 after approval or receiving a revocation before release invalidates the prior decision.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Newsroom review and provenance • expected behavior

Status: NOT_RUN

An editor sees the exact attribution and edition limits used in the successful release.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Newsroom review and provenance • failure boundary

Status: NOT_RUN

A human note cannot override a known out-of-scope global edition without a newly applicable grant.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Expiry, issuer updates and audit export • expected behavior

Status: NOT_RUN

A signed update flags affected future uses and preserves proof of the Jan 20 evaluation.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Expiry, issuer updates and audit export • failure boundary

Status: NOT_RUN

A stale replayed status message cannot resurrect a revoked or expired license.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-015 — Partner pilot and recovery rehearsal • expected behavior

Status: NOT_RUN

Restart after checkout and recover the matching grant before the real sample passes its publishing gate.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-016 — Partner pilot and recovery rehearsal • failure boundary

Status: NOT_RUN

A valid grant for another buyer, asset or order is quarantined without issuing a permit.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
