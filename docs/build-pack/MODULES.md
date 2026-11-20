# RightsDesk · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Rights-holder and asset registry](prompts/M01.md) — Implement reviewed seller enrollment, versioned keys, agreement references, tenant roles and immutable chart revisions with hashes.
2. [M02 · Offer and editorial intent](prompts/M02.md) — Persist original terms plus a bounded machine-readable schema; collect planned purpose, channel, edition, territories, exact asset and attribution.
3. [M03 · Purchase and grant acquisition](prompts/M03.md) — Bind buyer authorization and price cap to the offer. Integrate the supported Kite checkout with separate authenticated seller issuance and grant lookup.
4. [M04 · Deterministic usage evaluator](prompts/M04.md) — Build a structured rule evaluator returning dimension-level evidence, explicit time bounds, support gaps and per-use decision hashes.
5. [M05 · Release hook and concurrency](prompts/M05.md) — Integrate a local editorial CMS release surface; bind prepublish decision to artifact hash, signed grant revision and latest issuer state. Test a revoked or changed grant across release retries.
6. [M06 · Newsroom review and provenance](prompts/M06.md) — Build asset/terms comparison, pending grant inbox, declaration of distribution controls and a versioned rights officer review for unsupported clauses.
7. [M07 · Expiry, issuer updates and audit export](prompts/M07.md) — Process authenticated ordered status events, track expiries and impacted uses, retain verification keys and export an access-controlled decision packet.
8. [M08 · Partner pilot and recovery rehearsal](prompts/M08.md) — Exercise the real seller and managed newsroom release hook with an approved sample. Test unknown settlement, delayed grant and loss of issuer availability; capture evidence separately per boundary.
