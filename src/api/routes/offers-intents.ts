import { all, now, one, tx, type Db } from '../../db/store.ts';
import { canonicalJson, hashCanonical, sha256Hex } from '../../domain/canon.ts';
import { rid } from '../../domain/ids.ts';
import { parseTermsSchema, TERMS_SCHEMA_VERSION, unsupportedClauses } from '../../domain/policy.ts';
import {
  optString, reqInt, reqIso, reqObject, reqString, reqStringArray,
} from '../../domain/validate.ts';
import type {
  AssetRevisionRow, AssetRow, DecisionRow, GrantRow, IntentRow, OfferRow,
  OrderRow, ReceiptRow, ReviewRow, SellerRow,
} from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, conflict, forbidden, notFound, Router, type Ctx } from '../http.ts';

export function offerIntentRoutes(db: Db): Router {
  const r = new Router();

  const sellerOf = (id: string) => {
    const s = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', id);
    if (!s) throw notFound('seller');
    return s;
  };
  const offerOf = (id: string) => {
    const o = one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', id);
    if (!o) throw notFound('offer');
    return o;
  };
  const intentOf = (id: string) => {
    const i = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', id);
    if (!i) throw notFound('intent');
    return i;
  };
  const assertTenant = (u: { org_id: string }, orgId: string) => {
    if (u.org_id !== orgId) throw forbidden('record belongs to another organization');
  };

  // --- offers ------------------------------------------------------------
  r.post('/assets/{id}/offers', (ctx) => {
    const u = requireRole(ctx.user, ['seller_agent']);
    const a = one<AssetRow>(db, 'SELECT * FROM assets WHERE id=?', ctx.params.id!);
    if (!a) throw notFound('asset');
    const s = sellerOf(a.seller_id);
    if (u.org_id !== s.org_id) throw forbidden('asset belongs to another seller');
    if (s.status !== 'verified') throw new ApiError(409, 'seller_not_verified', 'seller must be verified');

    const b = reqObject(ctx.body, 'body');
    const assetRevision = reqInt(b.asset_revision, 'asset_revision', { min: 1 });
    const rev = one<AssetRevisionRow>(db,
      'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', a.id, assetRevision);
    if (!rev) throw conflict(`asset revision ${assetRevision} not registered`);

    const termsText = reqString(b.terms_text, 'terms_text', 65536);
    const schema = parseTermsSchema(b.terms_schema);
    const priceAtomic = reqInt(b.price_atomic, 'price_atomic', { min: 0 });
    const assetSymbol = reqString(b.asset_symbol, 'asset_symbol', 16);
    const rail = reqString(b.rail, 'rail', 64);
    const expiresAt = reqIso(b.expires_at, 'expires_at');
    const termsSha = sha256Hex(termsText);
    const flagged = unsupportedClauses(schema);

    const id = rid('off');
    tx(db, () => {
      const revNo = (one<{ m: number }>(db,
        'SELECT COALESCE(MAX(revision),0)+1 AS m FROM offers WHERE asset_id=? AND asset_revision=?',
        a.id, assetRevision))!.m;
      db.prepare(`INSERT INTO offers (id, asset_id, asset_revision, seller_id, revision,
          terms_text, terms_sha256, terms_schema, price_atomic, asset_symbol, rail, expires_at,
          schema_version, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?)`)
        .run(id, a.id, assetRevision, s.id, revNo, termsText, termsSha,
          canonicalJson(schema), priceAtomic, assetSymbol, rail, expiresAt,
          TERMS_SCHEMA_VERSION, now());
      audit(db, u.id, 'offer.published', { subjectKind: 'offer', subjectId: id });
    });
    const offer = offerOf(id);
    return { ...offer, unsupported_clauses: flagged };
  });

  r.get('/offers/{id}', (ctx) => {
    requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const o = offerOf(ctx.params.id!);
    const schema = JSON.parse(o.terms_schema) as { clauses?: Record<string, unknown> };
    return {
      ...o,
      terms_schema: schema,
      unsupported_clauses: unsupportedClauses({ clauses: schema.clauses ?? {} }),
    };
  });

  // --- intents -----------------------------------------------------------
  r.post('/publication-intents', (ctx) => {
    const u = requireRole(ctx.user, ['editor']);
    const b = reqObject(ctx.body, 'body');
    const offerId = reqString(b.offer_id, 'offer_id', 128);
    const offer = offerOf(offerId);
    if (offer.status !== 'published') throw conflict(`offer is ${offer.status}`);
    if (offer.expires_at <= now()) throw conflict('offer expired');

    const rev = one<AssetRevisionRow>(db,
      'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', offer.asset_id, offer.asset_revision)!;
    const schema = JSON.parse(offer.terms_schema) as { clauses?: Record<string, unknown> };
    const flagged = unsupportedClauses({ clauses: schema.clauses ?? {} });

    const fields = {
      buyer_org_id: u.org_id,
      buyer_user_id: u.id,
      publication_id: reqString(b.publication_id, 'publication_id', 128),
      offer_id: offer.id,
      offer_revision: offer.revision,
      terms_sha256: offer.terms_sha256,
      asset_id: offer.asset_id,
      asset_revision: offer.asset_revision,
      asset_sha256: rev.content_sha256,
      edition: reqString(b.edition, 'edition', 64),
      channel: reqString(b.channel, 'channel', 64),
      territory_set: reqStringArray(b.territory_set, 'territory_set', 64),
      purpose: reqString(b.purpose, 'purpose', 64),
      attribution_text: reqString(b.attribution_text, 'attribution_text', 512),
      control_evidence_ref: optString(b.control_evidence_ref, 'control_evidence_ref', 1024),
      control_evidence_digest: optString(b.control_evidence_digest, 'control_evidence_digest', 128),
      intended_at: reqIso(b.intended_at, 'intended_at'),
    };
    const id = rid('int');
    const status = flagged.length ? 'rights_review' : 'specified';
    tx(db, () => {
      db.prepare(`INSERT INTO intents (id, buyer_org_id, buyer_user_id, publication_id,
          offer_id, offer_revision, terms_sha256, asset_id, asset_revision, asset_sha256,
          edition, channel, territory_set, purpose, attribution_text,
          control_evidence_ref, control_evidence_digest, intended_at, intent_hash, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, fields.buyer_org_id, fields.buyer_user_id, fields.publication_id,
          fields.offer_id, fields.offer_revision, fields.terms_sha256, fields.asset_id,
          fields.asset_revision, fields.asset_sha256, fields.edition, fields.channel,
          canonicalJson(fields.territory_set), fields.purpose, fields.attribution_text,
          fields.control_evidence_ref, fields.control_evidence_digest, fields.intended_at,
          hashCanonical(fields), status, now());
      audit(db, u.id, 'intent.specified', { subjectKind: 'intent', subjectId: id });
    });
    const intent = intentOf(id);
    return { ...intent, flags: { unsupported_clauses: flagged } };
  });

  r.get('/intents', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    if (u.role === 'operator') return all(db, 'SELECT * FROM intents ORDER BY created_at DESC');
    return all(db, 'SELECT * FROM intents WHERE buyer_org_id=? ORDER BY created_at DESC', u.org_id);
  });

  r.get('/intents/{id}', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const i = intentOf(ctx.params.id!);
    if (u.role !== 'operator' && u.role !== 'seller_agent') assertTenant(u, i.buyer_org_id);
    if (u.role === 'seller_agent') {
      // seller sees intents bound to their offers only
      const o = i.offer_id ? offerOf(i.offer_id) : null;
      if (!o) throw forbidden('not your offer');
      const s = sellerOf(o.seller_id);
      if (s.org_id !== u.org_id) throw forbidden('not your offer');
    }
    return caseView(db, i);
  });

  r.get('/intents/{id}/offers', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const i = intentOf(ctx.params.id!);
    if (u.role !== 'operator') assertTenant(u, i.buyer_org_id);
    return all(db,
      `SELECT * FROM offers WHERE asset_id=? AND status='published' AND expires_at > ? ORDER BY created_at DESC`,
      i.asset_id, now());
  });

  return r;
}

// Full case view: intent, offer+terms, seller, orders, grants, decisions,
// receipts — one evidence surface per UI-SPEC.
export function caseView(db: Db, i: IntentRow) {
  const offer = i.offer_id ? one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', i.offer_id) : null;
  const seller = offer ? one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id) : null;
  const orders = all<OrderRow>(db, 'SELECT * FROM orders WHERE intent_id=? ORDER BY created_at', i.id);
  const grants = orders.length
    ? all<GrantRow>(db, `SELECT * FROM grants WHERE order_id IN (${orders.map(() => '?').join(',')})`,
      ...orders.map(o => o.id))
    : [];
  const decisions = all<DecisionRow>(db,
    'SELECT * FROM decisions WHERE intent_id=? ORDER BY evaluated_at', i.id);
  const receipts = all<ReceiptRow>(db,
    'SELECT * FROM publication_receipts WHERE intent_id=? ORDER BY published_at', i.id);
  const reviews = all<ReviewRow>(db,
    `SELECT * FROM reviews WHERE (subject_kind='intent' AND subject_id=?) OR (subject_kind='decision' AND subject_id IN (SELECT id FROM decisions WHERE intent_id=?)) ORDER BY created_at`,
    i.id, i.id);
  const declarations = all(db, 'SELECT * FROM control_declarations WHERE intent_id=? ORDER BY created_at', i.id);
  return {
    intent: i, offer, seller, orders, grants, decisions, receipts, reviews,
    control_declarations: declarations,
  };
}
