import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { all, now, one, tx, type Db } from '../db/store.ts';
import { generateEd25519 } from '../domain/keys.ts';
import {
  buildGrantEvent, canonicalGrantPayload, GRANT_SCHEMA,
  signGrantEvent, signGrantPayload, verifyGrantSignature,
} from '../domain/grants.ts';
import { sha256Hex } from '../domain/canon.ts';
import { rid } from '../domain/ids.ts';
import type {
  AssetRevisionRow, GrantPayloadV1, GrantRow,
  OfferRow, OrderRow, SellerKeyRow, SellerRow,
} from '../domain/types.ts';
import { audit } from '../api/auth.ts';

export type IssueResult =
  | { status: 'issued' | 'already_issued'; grant: GrantRow }
  | { status: 'unavailable' | 'rejected'; reason: string };

// Verify + persist a seller-signed grant payload against a paid order.
// Binding violations are quarantined and never create a license (INV-03).
export function ingestGrant(
  db: Db, order: OrderRow, payload: Record<string, unknown>, signature: string, actor: string,
): { status: 'issued' | 'quarantined'; grant?: GrantRow; reason?: string } {
  const offer = one<OfferRow>(db, 'SELECT * FROM offers WHERE id=?', order.offer_id)!;
  const rev = one<AssetRevisionRow>(db,
    'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', offer.asset_id, offer.asset_revision)!;
  const seller = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id)!;

  const quarantine = (reason: string) => {
    db.prepare(`INSERT INTO grant_quarantine (id, grant_id, order_id, reason, payload_json, signature, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(rid('quar'), (payload.grant_id as string) ?? null, order.id, reason,
        JSON.stringify(payload), signature, now());
    audit(db, actor, 'grant.quarantined', { subjectKind: 'order', subjectId: order.id, reasonCode: reason });
    return { status: 'quarantined' as const, reason };
  };

  if (payload.schema !== GRANT_SCHEMA) return quarantine('schema_unsupported');
  const binding =
    payload.order_id === order.id &&
    payload.buyer_org_id === order.buyer_org_id &&
    payload.seller_id === seller.id &&
    payload.asset_sha256 === rev.content_sha256;
  if (!binding) return quarantine('binding_mismatch');

  const gp = payload as unknown as import('../domain/types.ts').GrantPayloadV1;
  const keyVersion = gp.key_version;
  const sig = verifyGrantSignature(db, seller.id, keyVersion, gp, signature);
  if (!sig.valid) return quarantine(sig.reason ?? 'signature_invalid');
  if (seller.status !== 'verified') return quarantine('seller_not_verified');

  const existing = one<GrantRow>(db, 'SELECT * FROM grants WHERE order_id=?', order.id);
  if (existing) return { status: 'issued', grant: existing };

  const grantId = gp.grant_id;
  return tx(db, () => {
    db.prepare(`INSERT INTO grants (id, seller_id, order_id, buyer_org_id, asset_sha256,
        edition_set, channel_set, territory_set, purposes, attribution,
        valid_from, valid_until, status, payload_json, signed_payload_hash, signature,
        issuer_key_version, status_seq, issued_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?,?, 0, ?,?)`)
      .run(grantId, seller.id, order.id, order.buyer_org_id, gp.asset_sha256,
        JSON.stringify(gp.edition_set), JSON.stringify(gp.channel_set),
        JSON.stringify(gp.territory_set), JSON.stringify(gp.purposes), gp.attribution,
        gp.valid_from, gp.valid_until, JSON.stringify(payload),
        sha256Hex(canonicalGrantPayload(gp)), signature, keyVersion, gp.issued_at, now());
    db.prepare(`INSERT INTO grant_events (id, seller_id, grant_id, seq, kind, new_status, signature, key_version, actor, received_at)
      VALUES (?,?,?,0,'issued','active',?,?,?,?)`)
      .run(rid('gev'), seller.id, grantId, signature, keyVersion, actor, now());
    db.prepare(`UPDATE orders SET status='grant_active' WHERE id=?`).run(order.id);
    if (order.intent_id) {
      db.prepare(`UPDATE intents SET status='grant_active' WHERE id=?`).run(order.intent_id);
    }
    audit(db, actor, 'grant.issued', { subjectKind: 'grant', subjectId: grantId, externalRef: order.payment_ref ?? undefined });
    return { status: 'issued' as const, grant: one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', grantId)! };
  });
}

// Seller-side issuance service: holds private keys in its own directory
// (issuer custody, never in the API database) and signs canonical grants for
// settled orders. Deterministic fault injection via `available`.
export class LocalIssuerService {
  readonly id = 'local-issuer';
  available = true;
  private db: Db;
  private keyDir: string;

  constructor(db: Db, keyDir: string) {
    this.db = db;
    this.keyDir = keyDir;
  }

  setAvailable(v: boolean) { this.available = v; }

  private keyFile(sellerId: string, version: number) {
    return join(this.keyDir, `${sellerId}_v${version}.pem`);
  }

  private loadPrivate(sellerId: string, version: number): string | null {
    const f = this.keyFile(sellerId, version);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  /** Register a fresh keypair for the seller (issuer custody for the private half). */
  registerKey(sellerId: string): { keyVersion: number; publicKeyPem: string } {
    const next = (one<{ m: number }>(this.db,
      'SELECT COALESCE(MAX(key_version),0)+1 AS m FROM seller_keys WHERE seller_id=?', sellerId))!.m;
    const kp = generateEd25519();
    mkdirSync(this.keyDir, { recursive: true });
    writeFileSync(this.keyFile(sellerId, next), kp.privateKeyPem, { mode: 0o600 });
    this.db.prepare(`INSERT INTO seller_keys (seller_id, key_version, public_key_pem, status, created_at)
      VALUES (?,?,?,'active',?)`).run(sellerId, next, kp.publicKeyPem, now());
    return { keyVersion: next, publicKeyPem: kp.publicKeyPem };
  }

  rotateKey(sellerId: string): { keyVersion: number; publicKeyPem: string } {
    return tx(this.db, () => {
      this.db.prepare(`UPDATE seller_keys SET status='retired', retired_at=? WHERE seller_id=? AND status='active'`)
        .run(now(), sellerId);
      return this.registerKey(sellerId);
    });
  }

  /** Issue (or recover) the grant for a settled order. Idempotent per order. */
  issueGrant(orderId: string, actor = 'system:worker'): IssueResult {
    if (!this.available) return { status: 'unavailable', reason: 'issuer_unavailable' };
    const order = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id=?', orderId);
    if (!order) return { status: 'rejected', reason: 'order_not_found' };
    const existing = one<GrantRow>(this.db, 'SELECT * FROM grants WHERE order_id=?', order.id);
    if (existing) return { status: 'already_issued', grant: existing };
    if (order.status !== 'paid_awaiting_grant') {
      return { status: 'rejected', reason: `order_${order.status}` };
    }
    const offer = one<OfferRow>(this.db, 'SELECT * FROM offers WHERE id=?', order.offer_id)!;
    const rev = one<AssetRevisionRow>(this.db,
      'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', offer.asset_id, offer.asset_revision)!;
    const seller = one<SellerRow>(this.db, 'SELECT * FROM sellers WHERE id=?', offer.seller_id)!;
    if (seller.status !== 'verified') return { status: 'rejected', reason: 'seller_not_verified' };

    const key = one<SellerKeyRow>(this.db,
      `SELECT * FROM seller_keys WHERE seller_id=? AND status='active' ORDER BY key_version DESC`, seller.id);
    if (!key) return { status: 'rejected', reason: 'no_active_key' };
    const priv = this.loadPrivate(seller.id, key.key_version);
    if (!priv) return { status: 'rejected', reason: 'issuer_key_unavailable' };

    const terms = JSON.parse(offer.terms_schema) as {
      edition_set: string[]; channel_set: string[]; territory_set: string[];
      purposes: string[]; attribution: string; valid_from: string; valid_until: string;
    };
    const payload: GrantPayloadV1 = {
      schema: GRANT_SCHEMA, grant_id: rid('grt'), seller_id: seller.id,
      order_id: order.id, buyer_org_id: order.buyer_org_id, asset_sha256: rev.content_sha256,
      edition_set: terms.edition_set, channel_set: terms.channel_set,
      territory_set: terms.territory_set, purposes: terms.purposes,
      attribution: terms.attribution, valid_from: terms.valid_from,
      valid_until: terms.valid_until, issued_at: now(), key_version: key.key_version,
    };
    const signature = signGrantPayload(priv, payload);
    const res = ingestGrant(this.db, order, { ...payload }, signature, actor);
    if (res.status === 'issued') return { status: 'issued', grant: res.grant! };
    return { status: 'rejected', reason: res.reason ?? 'quarantined' };
  }

  /** Build + sign a status event for a grant (issuer side of grant-events API). */
  makeStatusEvent(grantId: string, kind: 'revoked' | 'reinstated' | 'expired') {
    const grant = one<GrantRow>(this.db, 'SELECT * FROM grants WHERE id=?', grantId);
    if (!grant) throw new Error('grant not found');
    const key = one<SellerKeyRow>(this.db,
      `SELECT * FROM seller_keys WHERE seller_id=? AND status='active' ORDER BY key_version DESC`, grant.seller_id);
    if (!key) throw new Error('no active issuer key');
    const priv = this.loadPrivate(grant.seller_id, key.key_version);
    if (!priv) throw new Error('issuer key unavailable');
    const newStatus = kind === 'reinstated' ? 'active' : kind;
    const payload = buildGrantEvent(grant.seller_id, grantId, grant.status_seq + 1, kind, newStatus);
    return { payload, signature: signGrantEvent(priv, payload), key_version: key.key_version };
  }
}
