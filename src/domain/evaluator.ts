import { all, one, type Db } from '../db/store.ts';
import { hashCanonical } from './canon.ts';
import { POLICY_VERSION, SUPPORTED_CLAUSES } from './policy.ts';
import { verifyGrantSignature } from './grants.ts';
import type {
  DecisionResult, DimensionStatus, GrantPayloadV1, GrantRow,
  IntentRow, OfferRow, OrderRow, SellerRow,
} from './types.ts';

export interface DimensionResult {
  dimension: string;
  status: DimensionStatus;
  code: string;
  detail: string;
}

export interface Evaluation {
  result: DecisionResult;
  reason_codes: string[];
  dimensions: DimensionResult[];
  time_window: { valid_from: string | null; valid_until: string | null; intended_at: string; evaluated_at: string };
  grant_id: string | null;
  grant_seq: number | null;
  status_watermark: number | null;
  policy_version: string;
  decision_hash: string;
  expires_at: string | null;
}

const dim = (dimension: string, status: DimensionStatus, code: string, detail: string): DimensionResult =>
  ({ dimension, status, code, detail });
const ok = (d: string, detail: string) => dim(d, 'satisfied', 'ok', detail);
const bad = (d: string, code: string, detail: string) => dim(d, 'violated', code, detail);
const unknown = (d: string, code: string, detail: string) => dim(d, 'unknown', code, detail);
const unsup = (d: string, code: string, detail: string) => dim(d, 'unsupported', code, detail);

/**
 * Deterministic usage evaluation (FR-04, INV-04):
 * every known dimension is evaluated; a confirmed incompatibility denies even
 * when another dimension is unknown; only when nothing is violated can
 * missing/unsupported context yield review_required; allow requires all
 * required dimensions satisfied.
 */
export function evaluate(
  db: Db, intent: IntentRow, artifactHash: string, artifactAssetHash: string | null, evaluatedAt: string,
): Evaluation {
  const dims: DimensionResult[] = [];
  const artifactAsset = artifactAssetHash ?? intent.asset_sha256;

  const order = one<OrderRow>(db,
    `SELECT * FROM orders WHERE intent_id=? AND status NOT IN ('cancelled') ORDER BY created_at DESC`, intent.id);
  const grant = order
    ? one<GrantRow>(db, `SELECT * FROM grants WHERE order_id=?`, order.id) ?? null
    : null;
  const offer = intent.offer_id
    ? one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', intent.offer_id) ?? null
    : null;
  const seller = offer ? one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id) ?? null : null;

  let gp: GrantPayloadV1 | null = null;
  if (grant) {
    try { gp = JSON.parse(grant.payload_json) as GrantPayloadV1; } catch { gp = null; }
  }

  // 1. Grant presence + binding (INV-03: a paid order is not a license).
  if (!grant || !gp || !order) {
    dims.push(bad('grant_present', 'no_active_grant',
      order ? `order ${order.id} is ${order.status}; no seller-issued grant` : 'no purchase for this intent'));
  } else {
    const bound = grant.order_id === order.id
      && order.intent_id === intent.id
      && grant.buyer_org_id === intent.buyer_org_id
      && gp.seller_id === grant.seller_id;
    dims.push(bound
      ? ok('grant_present', `grant ${grant.id} bound to order ${order.id}`)
      : bad('grant_present', 'grant_binding_mismatch', 'grant does not bind this intent/order/buyer'));

    // 2. Grant status (current issuer state).
    dims.push(grant.status === 'active'
      ? ok('grant_status', 'grant is active')
      : bad('grant_status', 'grant_not_active', `grant status is ${grant.status}`));

    // 3. Signature vs registry key (retired keys still verify).
    const sig = verifyGrantSignature(db, grant.seller_id, grant.issuer_key_version, gp, grant.signature);
    dims.push(sig.valid
      ? ok('grant_signature', `signature verifies under seller key v${grant.issuer_key_version}`)
      : bad('grant_signature', 'grant_signature_invalid', sig.reason ?? 'invalid'));

    // 4. Scope dimensions.
    dims.push(artifactAsset === grant.asset_sha256 && intent.asset_sha256 === grant.asset_sha256
      ? ok('asset_hash', `artifact carries licensed hash ${artifactAsset.slice(0, 12)}…`)
      : bad('asset_hash', 'asset_hash_mismatch',
        `artifact asset ${artifactAsset.slice(0, 12)}… vs licensed ${grant.asset_sha256.slice(0, 12)}…`));
    dims.push(gp.edition_set.includes(intent.edition)
      ? ok('edition', `edition ${intent.edition} licensed`)
      : bad('edition', 'edition_out_of_scope', `edition ${intent.edition} not in ${JSON.stringify(gp.edition_set)}`));
    dims.push(gp.channel_set.includes(intent.channel)
      ? ok('channel', `channel ${intent.channel} licensed`)
      : bad('channel', 'channel_out_of_scope', `channel ${intent.channel} not in ${JSON.stringify(gp.channel_set)}`));
    const intentTerr = JSON.parse(intent.territory_set) as string[];
    const missingTerr = intentTerr.filter(t => !gp.territory_set.includes(t));
    dims.push(missingTerr.length === 0
      ? ok('territory', `territories ${JSON.stringify(intentTerr)} within grant`)
      : bad('territory', 'territory_out_of_scope',
        `${JSON.stringify(missingTerr)} outside licensed ${JSON.stringify(gp.territory_set)}`));
    dims.push(gp.purposes.includes(intent.purpose)
      ? ok('purpose', `purpose ${intent.purpose} licensed`)
      : bad('purpose', 'purpose_out_of_scope', `purpose ${intent.purpose} not in ${JSON.stringify(gp.purposes)}`));
    dims.push(intent.attribution_text === gp.attribution
      ? ok('attribution', 'required credit line matches exactly')
      : bad('attribution', 'attribution_mismatch',
        `credit "${intent.attribution_text}" != licensed "${gp.attribution}"`));

    // 5. Time window — half-open [valid_from, valid_until) applied to the
    // planned use. Freshness at publish time is enforced by re-evaluation
    // against current grant status (grant_not_active) plus decision expiry.
    const tFrom = gp.valid_from, tUntil = gp.valid_until;
    const intendedInside = intent.intended_at >= tFrom && intent.intended_at < tUntil;
    dims.push(intendedInside
      ? ok('time_window', `intended ${intent.intended_at} within [${tFrom}, ${tUntil})`)
      : bad('time_window', 'outside_validity_window',
        `intended_at ${intent.intended_at} outside [${tFrom}, ${tUntil})`));

    // 6. Distribution control evidence for territory-restricted editions.
    const restricted = !gp.territory_set.includes('GLOBAL') && missingTerr.length === 0;
    if (restricted) {
      const declared = (intent.control_evidence_ref && intent.control_evidence_digest)
        || one(db, 'SELECT id FROM control_declarations WHERE intent_id=?', intent.id);
      dims.push(declared
        ? ok('distribution_control', 'distribution controls declared with evidence reference')
        : unknown('distribution_control', 'missing_distribution_control_evidence',
          'restricted-territory edition lacks declared distribution controls'));
    } else {
      dims.push(ok('distribution_control', 'not a territory-restricted evaluation'));
    }
  }

  // 7. Seller verification state at evaluation time.
  if (seller) {
    dims.push(seller.status === 'verified'
      ? ok('seller_verified', `seller ${seller.id} verified by ${seller.verified_by}`)
      : bad('seller_verified', 'seller_not_verified', `seller status is ${seller.status}`));
  } else if (offer) {
    dims.push(bad('seller_verified', 'seller_not_verified', 'seller record missing'));
  }

  // 8. Unsupported legal clauses on the bound offer.
  if (offer) {
    const schema = JSON.parse(offer.terms_schema) as { clauses?: Record<string, unknown> };
    const unknownClauses = Object.keys(schema.clauses ?? {}).filter(k => !SUPPORTED_CLAUSES.has(k));
    dims.push(unknownClauses.length === 0
      ? ok('terms_support', 'all machine-readable clauses supported')
      : unsup('terms_support', 'unsupported_terms_clause',
        `clauses require rights review: ${unknownClauses.join(', ')}`));
  }

  // Result: violated beats everything; unknown/unsupported only when clean.
  const violated = dims.filter(d => d.status === 'violated');
  const gaps = dims.filter(d => d.status === 'unknown' || d.status === 'unsupported');
  const result: DecisionResult = violated.length ? 'deny'
    : gaps.length ? 'review_required' : 'allow';
  const reason_codes = (violated.length ? violated : gaps).map(d => d.code);

  const statusWatermark = grant ? grant.status_seq : null;
  const decision_hash = hashCanonical({
    policy_version: POLICY_VERSION,
    intent_hash: intent.intent_hash,
    artifact_hash: artifactHash,
    artifact_asset: artifactAsset,
    grant_payload_hash: grant?.signed_payload_hash ?? null,
    grant_seq: grant?.status_seq ?? null,
    dimensions: dims.map(d => [d.dimension, d.status, d.code]),
  });

  return {
    result, reason_codes, dimensions: dims,
    time_window: {
      valid_from: gp?.valid_from ?? null, valid_until: gp?.valid_until ?? null,
      intended_at: intent.intended_at, evaluated_at: evaluatedAt,
    },
    grant_id: grant?.id ?? null,
    grant_seq: grant?.status_seq ?? null,
    status_watermark: statusWatermark,
    policy_version: POLICY_VERSION,
    decision_hash,
    expires_at: result === 'allow' ? gp!.valid_until : null,
  };
}

export function intentsWithPendingWork(db: Db) {
  return all(db, `SELECT * FROM intents WHERE status IN ('rights_review','specified') ORDER BY created_at`);
}
