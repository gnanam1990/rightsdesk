import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { reqInt, reqObject, reqString, optString } from '../../domain/validate.ts';
import type {
  GrantRow, IntentRow, OfferRow, OrderRow, SellerRow,
} from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, conflict, forbidden, notFound, Router, type Ctx } from '../http.ts';
import { idempotent } from '../idempotency.ts';
import type { CheckoutProvider } from '../../providers/checkout.ts';
import { ingestGrant, LocalIssuerService } from '../../providers/issuer.ts';

export interface PurchaseDeps {
  db: Db;
  checkout: CheckoutProvider;
  issuer?: LocalIssuerService;
}

export function purchaseRoutes(deps: PurchaseDeps): Router {
  const r = new Router();
  const db = deps.db;

  const offerOf = (id: string) => {
    const o = one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', id);
    if (!o) throw notFound('offer');
    return o;
  };
  const orderOf = (id: string) => {
    const o = one<OrderRow>(db, 'SELECT * FROM orders WHERE id=?', id);
    if (!o) throw notFound('order');
    return o;
  };

  // POST /offers/{id}/orders — budget_holder authorizes purchase under a
  // price cap; checkout settles (emulator) or the order parks honestly.
  r.post('/offers/{id}/orders', async (ctx) => {
    const u = requireRole(ctx.user, ['budget_holder']);
    const offer = offerOf(ctx.params.id!);
    const b = reqObject(ctx.body, 'body');
    const intentId = reqString(b.intent_id, 'intent_id', 128);
    const cap = reqInt(b.price_cap_atomic, 'price_cap_atomic', { min: 0 });

    const { value } = await idempotent(db, ctx, 'orders.create', () => {
      const intent = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', intentId);
      if (!intent) throw notFound('intent');
      if (intent.buyer_org_id !== u.org_id) throw forbidden('intent belongs to another organization');
      if (intent.offer_id !== offer.id) throw conflict('intent is bound to a different offer');
      if (offer.status !== 'published') throw conflict(`offer is ${offer.status}`);
      if (offer.expires_at <= now()) throw conflict('offer expired');
      if (cap < offer.price_atomic) {
        throw new ApiError(422, 'price_cap_exceeded',
          `price_cap_atomic ${cap} below offer price ${offer.price_atomic}`);
      }
      // One purchase per intent.
      const dup = one<OrderRow>(db,
        `SELECT * FROM orders WHERE intent_id=? AND status NOT IN ('cancelled')`, intent.id);
      if (dup) return { order: dup, reused: true };

      return tx(db, () => {
        const id = rid('ord');
        db.prepare(`INSERT INTO orders (id, offer_id, offer_revision, terms_sha256, buyer_org_id,
            intent_id, approved_by, price_cap_atomic, agreed_price_atomic, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?, 'order_authorized', ?)`)
          .run(id, offer.id, offer.revision, offer.terms_sha256, u.org_id, intent.id,
            u.id, cap, offer.price_atomic, now());
        db.prepare(`UPDATE intents SET status='order_authorized' WHERE id=?`).run(intent.id);
        audit(db, u.id, 'order.authorized', { subjectKind: 'order', subjectId: id });
        return { order: orderOf(id), reused: false };
      });
    });
    let order = (value as { order: OrderRow }).order;

    // Checkout dispatch (outside the idempotent write — provider result then
    // persisted with the seller payment reference).
    if (order.status === 'order_authorized' && !(value as { reused?: boolean }).reused) {
      const idemKey = `checkout:${order.id}`;
      try {
        const res = await deps.checkout.createCheckout({
          order_id: order.id, amount_atomic: order.agreed_price_atomic,
          asset_symbol: offer.asset_symbol, rail: offer.rail,
          idempotency_key: idemKey,
          description: `RightsDesk grant for intent ${order.intent_id}`,
        });
        const next = res.status === 'settled' ? 'paid_awaiting_grant'
          : res.status === 'pending' ? 'checkout_pending' : 'payment_unknown';
        tx(db, () => {
          db.prepare(`UPDATE orders SET payment_ref=?, payment_status=?, checkout_provider=?, status=? WHERE id=?`)
            .run(res.payment_ref, res.status, res.provider, next, order.id);
          db.prepare('UPDATE intents SET status=? WHERE id=?').run(next, order.intent_id);
          if (next === 'paid_awaiting_grant') {
            enqueue(db, 'order.settled', { order_id: order.id });
          } else {
            enqueue(db, 'payment.inspect', { order_id: order.id });
          }
          audit(db, u.id, 'checkout.dispatched', {
            subjectKind: 'order', subjectId: order.id, externalRef: res.payment_ref,
          });
        });
      } catch (e) {
        // Provider fail-closed: order stays checkout_pending, no payment ref
        // invented, worker will keep surfacing the provider gap.
        tx(db, () => {
          db.prepare(`UPDATE orders SET status='checkout_pending', checkout_provider=?, payment_status='provider_unavailable' WHERE id=?`)
            .run(deps.checkout.id, order.id);
          enqueue(db, 'payment.inspect', { order_id: order.id });
          audit(db, u.id, 'checkout.unavailable', {
            subjectKind: 'order', subjectId: order.id, reasonCode: 'provider_unavailable',
          });
        });
      }
      order = orderOf(order.id);
    }
    return { order, provider: deps.checkout.id, provider_kind: deps.checkout.kind };
  });

  r.get('/orders', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'budget_holder', 'rights_officer', 'publisher', 'editor']);
    if (u.role === 'operator') return all(db, 'SELECT * FROM orders ORDER BY created_at DESC');
    if (u.role === 'seller_agent') {
      return all(db, `SELECT o.* FROM orders o JOIN offers f ON f.id=o.offer_id
        JOIN sellers s ON s.id=f.seller_id WHERE s.org_id=? ORDER BY o.created_at DESC`, u.org_id);
    }
    return all(db, 'SELECT * FROM orders WHERE buyer_org_id=? ORDER BY created_at DESC', u.org_id);
  });

  r.get('/orders/{id}', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'budget_holder', 'rights_officer', 'publisher', 'editor']);
    const o = orderOf(ctx.params.id!);
    if (u.role === 'seller_agent') {
      const offer = offerOf(o.offer_id);
      const s = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id)!;
      if (s.org_id !== u.org_id) throw forbidden('order belongs to another seller');
    } else if (u.role !== 'operator' && o.buyer_org_id !== u.org_id) {
      throw forbidden('order belongs to another organization');
    }
    const grant = one<GrantRow>(db, 'SELECT * FROM grants WHERE order_id=?', o.id);
    return { ...o, grant: grant ?? null };
  });

  // POST /issuers/{id}/grants — seller issuance. Either local issuance for a
  // settled order ({order_id}) or import of an externally-signed grant
  // ({order_id, payload, signature}). Both paths verify binding + signature;
  // mismatches are quarantined.
  r.post('/issuers/{id}/grants', (ctx) => {
    const u = requireRole(ctx.user, ['seller_agent', 'operator']);
    const seller = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', ctx.params.id!);
    if (!seller) throw notFound('issuer');
    if (u.role === 'seller_agent' && u.org_id !== seller.org_id) {
      throw forbidden('issuer belongs to another seller org');
    }
    const b = reqObject(ctx.body, 'body');
    const orderId = reqString(b.order_id, 'order_id', 128);
    const order = orderOf(orderId);
    const offer = offerOf(order.offer_id);
    if (offer.seller_id !== seller.id) throw forbidden('order does not belong to this issuer');
    if (order.status !== 'paid_awaiting_grant' && order.status !== 'grant_active') {
      throw conflict(`order is ${order.status}; only settled orders can receive a grant`);
    }

    if (b.payload !== undefined || b.signature !== undefined) {
      // External signed-grant import
      const payload = reqObject(b.payload, 'payload');
      const signature = reqString(b.signature, 'signature', 4096);
      const res = ingestGrant(db, order, payload, signature, u.id);
      if (res.status === 'quarantined') {
        throw new ApiError(422, 'grant_quarantined', `grant quarantined: ${res.reason}`);
      }
      return { status: 'issued', grant: res.grant };
    }
    if (!deps.issuer) {
      throw new ApiError(503, 'issuer_unavailable', 'no issuer service configured in this environment');
    }
    const res = deps.issuer.issueGrant(order.id, u.id);
    switch (res.status) {
      case 'issued': case 'already_issued':
        return { status: res.status, grant: res.grant };
      case 'unavailable':
        throw new ApiError(503, 'issuer_unavailable', res.reason);
      default:
        throw conflict(res.reason);
    }
  });

  r.get('/grants/{id}', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'budget_holder', 'rights_officer', 'publisher', 'editor']);
    const g = one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', ctx.params.id!);
    if (!g) throw notFound('grant');
    if (u.role === 'seller_agent') {
      const s = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', g.seller_id)!;
      if (s.org_id !== u.org_id) throw forbidden('grant belongs to another seller');
    } else if (u.role !== 'operator' && g.buyer_org_id !== u.org_id) {
      throw forbidden('grant belongs to another organization');
    }
    return { ...g, payload: JSON.parse(g.payload_json) };
  });

  r.get('/grants', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'budget_holder', 'rights_officer', 'publisher', 'editor']);
    const status = ctx.query.get('status');
    const where = status ? 'WHERE g.status = ?' : '';
    const params = status ? [status] : [];
    if (u.role === 'operator') {
      return all(db, `SELECT g.* FROM grants g ${where} ORDER BY g.created_at DESC`, ...params);
    }
    if (u.role === 'seller_agent') {
      const and = status ? 'AND g.status = ?' : 'WHERE 1=1';
      return all(db, `SELECT g.* FROM grants g JOIN sellers s ON s.id=g.seller_id
        WHERE s.org_id=? ${status ? 'AND g.status=?' : ''} ORDER BY g.created_at DESC`,
        u.org_id, ...params);
    }
    return all(db, `SELECT g.* FROM grants g WHERE g.buyer_org_id=? ${status ? 'AND g.status=?' : ''}
      ORDER BY g.created_at DESC`, u.org_id, ...params);
  });

  return r;
}

export function enqueue(db: Db, kind: string, payload: Record<string, unknown>) {
  db.prepare(`INSERT INTO outbox (kind, payload, status, next_attempt_at, created_at)
    VALUES (?,?, 'pending', ?, ?)`).run(kind, JSON.stringify(payload), now(), now());
}
