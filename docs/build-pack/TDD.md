# RightsDesk · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** A participating rights holder registers an asset and its offer, a newsroom editor proposes a use, a budget holder approves a purchase, a rights officer reviews ambiguity, and a publisher requests a decision before releasing an edition.

## Domain schema

Seller(id, agreement_ref, signing_key_version, verified_by); Asset(id, seller_id, revision, content_sha256, predecessor); Offer(id, asset_revision, terms_text_hash, price_atomic, asset_symbol, rail, expires_at, schema_version); Intent(id, buyer_id, publication_id, asset_version, edition, channel, territory_set, purpose, attribution_text, control_evidence_ref, control_evidence_digest, intended_at); Order(id, offer_id, approved_by, payment_ref, status); Grant(id, seller_id, order_id, buyer_id, asset_hash, edition_set, channel_set, territory_set, purposes, attribution, valid_from, valid_until, status, signed_payload_hash, issuer_key_version); Decision(id, artifact_hash, intent_hash, grant_revision, status_watermark, policy_version, result, reason_codes, expires_at); PublicationReceipt(id, artifact_hash, decision_id, timestamp).

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /sellers/{id}/assets; POST /assets/{id}/offers; POST /publication-intents; GET /intents/{id}/offers; POST /offers/{id}/orders; POST /issuers/{id}/grants; POST /intents/{id}/evaluate; GET /decisions/{id}; POST /publications/{id}/confirm; POST /issuers/{id}/grant-events.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Canonicalize the seller-signed grant payload over a schema version and key ID. Bind offer, buyer, asset hash and payment reference; terms text stays independently retrievable. A checkout can be paid while the grant is pending. For evaluation use half-open UTC validity intervals and explicit set inclusion for each supported dimension. Evaluate all known dimensions. A confirmed incompatibility yields deny even if another dimension is unknown. With no incompatibility, any missing field or unsupported clause yields review_required. Allow only when every required dimension is satisfied. For example an India-specific grant fails a global distribution request. Use a distribution control reference for a territory-restricted edition; if enforcement is unknown, hold for review. Re-evaluate immediately before managed publish and bind the decision to the artifact digest, intent and current grant status. Keep historic decisions immutable when status changes.

## State model

Offer published → intent specified → awaiting_approval → order_authorized → paid_awaiting_grant → grant_active. Each use then evaluates to allow, deny or review_required. Expiry or authenticated status events trigger re-evaluation. Revocation disputes and unrecognized legal terms route to a rights officer. External publication can be logged as observed; enforcement applies only at integrated publishing gates.

## Recovery

Use stable checkout idempotency and record the seller payment reference. A timeout obtaining a grant triggers issuer lookup on the same order and preserves paid_awaiting_grant. Rotation retains historical public keys. Retry publication using the same decision key, requiring current grant status and intended artifact hash. Preserve audit evidence when re-evaluation changes the outcome.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
