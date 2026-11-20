# RightsDesk · Product requirements

## Product decision

One rights holder sells grants for identified chart versions to one newsroom. Encode publisher, edition, channel, distribution territory, purpose, attribution and term. Return a scoped decision for the newsroom publishing workflow with auditable evidence. Seller onboarding and rights authority require human verification under the participating agreement.

**Buyer and commercial hypothesis.** Publishers licensing third-party charts or data. Sell newsroom seats or per-edition license administration.

**People and responsibilities.** A participating rights holder registers an asset and its offer, a newsroom editor proposes a use, a budget holder approves a purchase, a rights officer reviews ambiguity, and a publisher requests a decision before releasing an edition.

## Customer journey

An editor selects a chart and describes the intended edition and territory. The rights officer checks the seller identity, asset and terms. An authorized purchase obtains a seller-issued structured grant. The publication integration submits the exact planned use and receives its decision and required credit line. A later global republication triggers a fresh evaluation.

## Acceptance scene

Asset A revision 3 has hash H3. A signed grant permits one newsroom's India edition on web, editorial use, territory IN, named attribution, from 2030-01-01T00:00Z up to but excluding 2030-02-01T00:00Z. A Jan 20 controlled IN edition carrying the exact credit and H3 is allowed. A global edition is denied. A request lacking evidence of distribution controls is referred for review. Payment without the signed grant yields paid_awaiting_grant and no publish permit. At the expiry instant the old decision cannot authorize publication.

## Behaviors for the team

- **FR-01 · Rights-holder and asset registry.** Implement reviewed seller enrollment, versioned keys, agreement references, tenant roles and immutable chart revisions with hashes.
- **FR-02 · Offer and editorial intent.** Persist original terms plus a bounded machine-readable schema; collect planned purpose, channel, edition, territories, exact asset and attribution.
- **FR-03 · Purchase and grant acquisition.** Bind buyer authorization and price cap to the offer. Integrate the supported Kite checkout with separate authenticated seller issuance and grant lookup.
- **FR-04 · Deterministic usage evaluator.** Build a structured rule evaluator returning dimension-level evidence, explicit time bounds, support gaps and per-use decision hashes.
- **FR-05 · Release hook and concurrency.** Integrate a local editorial CMS release surface; bind prepublish decision to artifact hash, signed grant revision and latest issuer state. Test a revoked or changed grant across release retries.
- **FR-06 · Newsroom review and provenance.** Build asset/terms comparison, pending grant inbox, declaration of distribution controls and a versioned rights officer review for unsupported clauses.
- **FR-07 · Expiry, issuer updates and audit export.** Process authenticated ordered status events, track expiries and impacted uses, retain verification keys and export an access-controlled decision packet.
- **FR-08 · Partner pilot and recovery rehearsal.** Exercise the real seller and managed newsroom release hook with an approved sample. Test unknown settlement, delayed grant and loss of issuer availability; capture evidence separately per boundary.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Recruit one chart rights holder and one editor with approved sample terms, signed grants, a test asset and controlled edition routing. Ask the rights officer to preclassify representative uses and compare product decisions with those judgments. A cooperating issuer and authenticated grant payload are required to demonstrate acquired rights.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [Licensor](https://devpost.com/software/licensor); customer willingness to pay requires pilot evidence.

## Larger team scope

- Versioned catalogs of allowable media, territories, editions and reuse grants
- Immutable acquisition terms, evidence linking and vendor key rotation
- Editorial CMS checks before reuse and issue-lock review
- Expiry calendars, withdrawals, conflicts and back-catalog audits

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
