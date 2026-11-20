# RightsDesk · acceptance contract

### FR-01 — Rights-holder and asset registry

Implement reviewed seller enrollment, versioned keys, agreement references, tenant roles and immutable chart revisions with hashes.

### INV-01 — Rights-holder and asset registry

Issuer identity and asset authority are separately recorded.

### FR-02 — Offer and editorial intent

Persist original terms plus a bounded machine-readable schema; collect planned purpose, channel, edition, territories, exact asset and attribution.

### INV-02 — Offer and editorial intent

Offer revision and signed terms digest accompany the intent at approval time.

### FR-03 — Purchase and grant acquisition

Bind buyer authorization and price cap to the offer. Integrate the supported Kite checkout with separate authenticated seller issuance and grant lookup.

### INV-03 — Purchase and grant acquisition

A payment reference cannot by itself create an active license.

### FR-04 — Deterministic usage evaluator

Build a structured rule evaluator returning dimension-level evidence, explicit time bounds, support gaps and per-use decision hashes.

### INV-04 — Deterministic usage evaluator

A known incompatible dimension denies; absent decisive context can only yield review_required when no known disqualifier already applies.

### FR-05 — Release hook and concurrency

Integrate a local editorial CMS release surface; bind prepublish decision to artifact hash, signed grant revision and latest issuer state. Test a revoked or changed grant across release retries.

### INV-05 — Release hook and concurrency

Publication on the controlled route needs a current matching allow decision.

### FR-06 — Newsroom review and provenance

Build asset/terms comparison, pending grant inbox, declaration of distribution controls and a versioned rights officer review for unsupported clauses.

### INV-06 — Newsroom review and provenance

Every reviewed outcome records authority, reviewer, rationale and evidence scope; unilateral editorial edits cannot extend a seller grant.

### FR-07 — Expiry, issuer updates and audit export

Process authenticated ordered status events, track expiries and impacted uses, retain verification keys and export an access-controlled decision packet.

### INV-07 — Expiry, issuer updates and audit export

Historic publication receipts remain immutable and each new use checks current issuer status.

### FR-08 — Partner pilot and recovery rehearsal

Exercise the real seller and managed newsroom release hook with an approved sample. Test unknown settlement, delayed grant and loss of issuer availability; capture evidence separately per boundary.

### INV-08 — Partner pilot and recovery rehearsal

A demo fixture may validate policy behavior, while a claim of having obtained rights requires a cooperating issuer and its acknowledged grant.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
