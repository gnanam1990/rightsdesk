import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { hashCanonical } from '../../domain/canon.ts';
import { reqObject, reqString } from '../../domain/validate.ts';
import type {
  AssetRevisionRow, GrantEventRow, GrantRow, IntentRow, OfferRow,
  OrderRow, PublicationRow, ReceiptRow, ReviewRow, SellerRow,
} from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { forbidden, notFound, Router } from '../http.ts';

export function exportRoutes(db: Db): Router {
  const r = new Router();

  // Impacted uses of a grant: decisions bound to it plus the receipts they
  // authorized (historic receipts remain immutable — INV-07).
  r.get('/grants/{id}/impacts', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'rights_officer', 'publisher', 'editor', 'budget_holder']);
    const g = one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', ctx.params.id!);
    if (!g) throw notFound('grant');
    if (u.role === 'seller_agent') {
      const s = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', g.seller_id)!;
      if (s.org_id !== u.org_id) throw forbidden('another seller');
    } else if (u.role !== 'operator' && g.buyer_org_id !== u.org_id) {
      throw forbidden('another organization');
    }
    const decisions = all(db, 'SELECT * FROM decisions WHERE grant_id=? ORDER BY evaluated_at', g.id);
    const receipts = all(db,
      `SELECT pr.* FROM publication_receipts pr JOIN decisions d ON d.id=pr.decision_id
       WHERE d.grant_id=? ORDER BY pr.published_at`, g.id);
    const events = all<GrantEventRow>(db,
      'SELECT * FROM grant_events WHERE grant_id=? ORDER BY seq', g.id);
    return { grant: g, decisions, receipts, events };
  });

  // Access-controlled decision packet: the complete redacted evidence bundle
  // for one intent case — exact input revisions, actor scope, persisted
  // decisions, signatures and the ordered event log (NFR-01).
  r.get('/cases/{id}/export', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'rights_officer', 'publisher', 'editor', 'budget_holder']);
    const intent = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', ctx.params.id!);
    if (!intent) throw notFound('case');
    if (u.role !== 'operator' && intent.buyer_org_id !== u.org_id) {
      throw forbidden('case belongs to another organization');
    }
    const offer = intent.offer_id ? one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', intent.offer_id) : null;
    const seller = offer ? one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id) : null;
    const revisions = offer
      ? all<AssetRevisionRow>(db, 'SELECT * FROM asset_revisions WHERE asset_id=? ORDER BY revision', offer.asset_id)
      : [];
    const keys = seller
      ? all(db, 'SELECT key_version, status, created_at, retired_at FROM seller_keys WHERE seller_id=? ORDER BY key_version', seller.id)
      : [];
    const orders = all<OrderRow>(db, 'SELECT * FROM orders WHERE intent_id=? ORDER BY created_at', intent.id);
    const grants = orders.length
      ? all<GrantRow>(db, `SELECT * FROM grants WHERE order_id IN (${orders.map(() => '?').join(',')})`,
        ...orders.map(o => o.id))
      : [];
    const events = grants.length
      ? all<GrantEventRow>(db, `SELECT * FROM grant_events WHERE grant_id IN (${grants.map(() => '?').join(',')}) ORDER BY grant_id, seq`,
        ...grants.map(g => g.id))
      : [];
    const decisions = all(db, 'SELECT * FROM decisions WHERE intent_id=? ORDER BY evaluated_at', intent.id);
    const publications = all<PublicationRow>(db, 'SELECT * FROM publications WHERE intent_id=?', intent.id);
    const receipts = all<ReceiptRow>(db, 'SELECT * FROM publication_receipts WHERE intent_id=?', intent.id);
    const reviews = all<ReviewRow>(db,
      `SELECT * FROM reviews WHERE (subject_kind='intent' AND subject_id=?) OR (subject_kind='decision' AND subject_id IN (SELECT id FROM decisions WHERE intent_id=?)) ORDER BY created_at`,
      intent.id, intent.id);
    const declarations = all(db, 'SELECT * FROM control_declarations WHERE intent_id=?', intent.id);
    const quarantined = orders.length
      ? all(db, `SELECT * FROM grant_quarantine WHERE order_id IN (${orders.map(() => '?').join(',')})`,
        ...orders.map(o => o.id))
      : [];

    const body = {
      packet_schema: 'rightsdesk.packet.v1',
      exported_at: now(),
      exported_by: { actor_id: u.id, role: u.role, org_id: u.org_id },
      intent,
      offer: offer ? { ...offer, terms_schema: JSON.parse(offer.terms_schema) } : null,
      seller: seller ? { ...seller, keys } : null,
      asset_revisions: revisions,
      orders,
      grants: grants.map(g => ({ ...g, payload: JSON.parse(g.payload_json) })),
      grant_events: events,
      decisions: decisions.map((d: any) => ({
        ...d, reason_codes: JSON.parse(d.reason_codes), dimensions: JSON.parse(d.dimensions),
      })),
      publications, receipts, reviews, control_declarations: declarations,
      quarantined_grants: quarantined,
    };
    const packet = { ...body, packet_hash: hashCanonical(body) };
    audit(db, u.id, 'case.exported', { subjectKind: 'intent', subjectId: intent.id });
    return packet;
  });

  return r;
}
