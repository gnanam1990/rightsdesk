// Row and payload types shared across api, worker and tests.

export type Role = 'operator' | 'seller_agent' | 'editor' | 'budget_holder' | 'rights_officer' | 'publisher';
export type OrgKind = 'platform' | 'seller' | 'newsroom';
export type SellerStatus = 'pending_review' | 'verified' | 'suspended';
export type OrderStatus =
  | 'order_authorized' | 'checkout_pending' | 'payment_unknown'
  | 'paid_awaiting_grant' | 'grant_active' | 'cancelled';
export type GrantStatus = 'active' | 'revoked' | 'expired' | 'quarantined';
export type DecisionResult = 'allow' | 'deny' | 'review_required';
export type DimensionStatus = 'satisfied' | 'violated' | 'unknown' | 'unsupported';
export type PublicationStatus = 'draft' | 'released' | 'blocked';

export interface UserRow {
  id: string; org_id: string; display_name: string; role: Role; created_at: string;
}
export interface OrgRow { id: string; kind: OrgKind; name: string; created_at: string }
export interface SellerRow {
  id: string; org_id: string; agreement_ref: string; status: SellerStatus;
  verified_by: string | null; verified_at: string | null; created_at: string;
}
export interface SellerKeyRow {
  seller_id: string; key_version: number; public_key_pem: string;
  status: 'active' | 'retired'; created_at: string; retired_at: string | null;
}
export interface AssetRow { id: string; seller_id: string; title: string; created_at: string }
export interface AssetRevisionRow {
  asset_id: string; revision: number; content_sha256: string;
  predecessor_sha256: string | null; registered_by: string; created_at: string;
}
export interface OfferRow {
  id: string; asset_id: string; asset_revision: number; seller_id: string; revision: number;
  terms_text: string; terms_sha256: string; terms_schema: string;
  price_atomic: number; asset_symbol: string; rail: string; expires_at: string;
  schema_version: string; status: 'draft' | 'published' | 'withdrawn'; created_at: string;
}
export interface IntentRow {
  id: string; buyer_org_id: string; buyer_user_id: string; publication_id: string;
  offer_id: string | null; offer_revision: number | null; terms_sha256: string | null;
  asset_id: string; asset_revision: number; asset_sha256: string;
  edition: string; channel: string; territory_set: string; purpose: string;
  attribution_text: string; control_evidence_ref: string | null; control_evidence_digest: string | null;
  intended_at: string; intent_hash: string; status: string; created_at: string;
}
export interface OrderRow {
  id: string; offer_id: string; offer_revision: number; terms_sha256: string; buyer_org_id: string;
  intent_id: string | null; approved_by: string; price_cap_atomic: number;
  agreed_price_atomic: number; payment_ref: string | null; payment_status: string | null;
  checkout_provider: string | null; idempotency_key: string | null;
  status: OrderStatus; created_at: string;
}
export interface GrantRow {
  id: string; seller_id: string; order_id: string; buyer_org_id: string; asset_sha256: string;
  edition_set: string; channel_set: string; territory_set: string; purposes: string;
  attribution: string; valid_from: string; valid_until: string; status: GrantStatus;
  payload_json: string; signed_payload_hash: string; signature: string;
  issuer_key_version: number; status_seq: number; issued_at: string; created_at: string;
}
export interface GrantPayloadV1 {
  schema: 'rightsdesk.grant.v1';
  grant_id: string; seller_id: string; order_id: string; buyer_org_id: string;
  asset_sha256: string; edition_set: string[]; channel_set: string[];
  territory_set: string[]; purposes: string[]; attribution: string;
  valid_from: string; valid_until: string; issued_at: string; key_version: number;
}
export interface DecisionRow {
  id: string; intent_id: string; artifact_hash: string; intent_hash: string;
  grant_id: string | null; grant_seq: number | null; status_watermark: number | null;
  policy_version: string; result: DecisionResult; reason_codes: string; dimensions: string;
  decision_hash: string; evaluated_at: string; expires_at: string | null; actor_id: string;
}
export interface PublicationRow {
  id: string; buyer_org_id: string; intent_id: string; artifact_hash: string;
  status: PublicationStatus; created_at: string;
}
export interface ReceiptRow {
  id: string; publication_id: string; artifact_hash: string; decision_id: string;
  intent_id: string; actor_id: string; published_at: string;
}
export interface ReviewRow {
  id: string; subject_kind: string; subject_id: string; version: number;
  reviewer_id: string; verdict: string; rationale: string; evidence_scope: string; created_at: string;
}
export interface OutboxRow {
  id: number; kind: string; payload: string; status: 'pending' | 'done' | 'failed';
  attempts: number; next_attempt_at: string; last_error: string | null;
  created_at: string; processed_at: string | null;
}
export interface GrantEventRow {
  id: string; seller_id: string; grant_id: string; seq: number; kind: string;
  new_status: string | null; signature: string; key_version: number;
  actor: string; received_at: string;
}
export interface ControlDeclarationRow {
  id: string; intent_id: string; declared_by: string; kind: string;
  reference: string; digest: string; created_at: string;
}
