import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { reqString, reqInt, reqSha256, optString, reqObject } from '../../domain/validate.ts';
import type { AssetRevisionRow, AssetRow, OfferRow, SellerKeyRow, SellerRow } from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, conflict, forbidden, notFound, Router, type Ctx } from '../http.ts';

export function registryRoutes(db: Db): Router {
  const r = new Router();

  const sellerOr404 = (id: string) => {
    const s = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id = ?', id);
    if (!s) throw notFound('seller');
    return s;
  };

  // --- sellers -----------------------------------------------------------
  r.get('/sellers', (ctx) => {
    requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    return all(db, `SELECT s.*, (SELECT json_group_array(json_object('key_version', key_version, 'status', status))
        FROM seller_keys k WHERE k.seller_id = s.id) AS keys FROM sellers s ORDER BY s.created_at`);
  });

  r.post('/sellers', (ctx) => {
    const u = requireRole(ctx.user, ['operator']);
    const b = reqObject(ctx.body, 'body');
    const id = rid('sel');
    const orgName = reqString(b.org_name, 'org_name');
    const agreementRef = reqString(b.agreement_ref, 'agreement_ref');
    tx(db, () => {
      const orgId = rid('org');
      db.prepare('INSERT INTO orgs (id, kind, name, created_at) VALUES (?,?,?,?)')
        .run(orgId, 'seller', orgName, now());
      db.prepare(`INSERT INTO sellers (id, org_id, agreement_ref, status, created_at)
        VALUES (?,?,?,'pending_review',?)`).run(id, orgId, agreementRef, now());
      audit(db, u.id, 'seller.enrolled', { subjectKind: 'seller', subjectId: id });
    });
    return one(db, 'SELECT * FROM sellers WHERE id = ?', id);
  });

  r.post('/sellers/{id}/verify', (ctx) => {
    const u = requireRole(ctx.user, ['operator']);
    const s = sellerOr404(ctx.params.id!);
    if (s.status !== 'pending_review') throw conflict(`seller is ${s.status}, cannot verify`);
    db.prepare(`UPDATE sellers SET status='verified', verified_by=?, verified_at=? WHERE id=?`)
      .run(u.id, now(), s.id);
    audit(db, u.id, 'seller.verified', { subjectKind: 'seller', subjectId: s.id });
    return one(db, 'SELECT * FROM sellers WHERE id = ?', s.id);
  });

  r.post('/sellers/{id}/suspend', (ctx) => {
    const u = requireRole(ctx.user, ['operator']);
    const s = sellerOr404(ctx.params.id!);
    db.prepare(`UPDATE sellers SET status='suspended' WHERE id=?`).run(s.id);
    audit(db, u.id, 'seller.suspended', { subjectKind: 'seller', subjectId: s.id });
    return one(db, 'SELECT * FROM sellers WHERE id = ?', s.id);
  });

  r.get('/sellers/{id}', (ctx) => {
    requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const s = sellerOr404(ctx.params.id!);
    const keys = all<SellerKeyRow>(db,
      'SELECT seller_id, key_version, status, created_at, retired_at FROM seller_keys WHERE seller_id=? ORDER BY key_version', s.id);
    return { ...s, keys };
  });

  // Register a public key version for the seller (issuer service publishes its
  // public half; private custody stays with the issuer adapter, not the API).
  r.post('/sellers/{id}/keys', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent']);
    const s = sellerOr404(ctx.params.id!);
    if (u.role === 'seller_agent' && u.org_id !== s.org_id) throw forbidden('wrong seller org');
    const b = reqObject(ctx.body, 'body');
    const pem = reqString(b.public_key_pem, 'public_key_pem', 4096);
    const next = (one<{ m: number }>(db,
      'SELECT COALESCE(MAX(key_version),0)+1 AS m FROM seller_keys WHERE seller_id=?', s.id))!.m;
    db.prepare(`INSERT INTO seller_keys (seller_id, key_version, public_key_pem, status, created_at)
      VALUES (?,?,?,'active',?)`).run(s.id, next, pem, now());
    audit(db, u.id, 'seller.key_registered', { subjectKind: 'seller', subjectId: s.id });
    return { seller_id: s.id, key_version: next };
  });

  // Rotate: retire current active key, activate the new version. Retired keys
  // remain for verifying historical signatures.
  r.post('/sellers/{id}/keys/rotate', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent']);
    const s = sellerOr404(ctx.params.id!);
    if (u.role === 'seller_agent' && u.org_id !== s.org_id) throw forbidden('wrong seller org');
    const b = reqObject(ctx.body, 'body');
    const pem = reqString(b.public_key_pem, 'public_key_pem', 4096);
    const result = tx(db, () => {
      db.prepare(`UPDATE seller_keys SET status='retired', retired_at=? WHERE seller_id=? AND status='active'`)
        .run(now(), s.id);
      const next = (one<{ m: number }>(db,
        'SELECT COALESCE(MAX(key_version),0)+1 AS m FROM seller_keys WHERE seller_id=?', s.id))!.m;
      db.prepare(`INSERT INTO seller_keys (seller_id, key_version, public_key_pem, status, created_at)
        VALUES (?,?,?,'active',?)`).run(s.id, next, pem, now());
      audit(db, u.id, 'seller.key_rotated', { subjectKind: 'seller', subjectId: s.id });
      return next;
    });
    return { seller_id: s.id, key_version: result };
  });

  // --- assets ------------------------------------------------------------
  r.get('/assets', (ctx) => {
    requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    return all(db, `SELECT a.*, json_group_array(json_object('revision', r.revision, 'content_sha256', r.content_sha256)) AS revisions
      FROM assets a JOIN asset_revisions r ON r.asset_id = a.id
      JOIN sellers s ON s.id = a.seller_id WHERE s.status = 'verified'
      GROUP BY a.id ORDER BY a.created_at`);
  });

  r.post('/sellers/{id}/assets', (ctx) => {
    const u = requireRole(ctx.user, ['seller_agent']);
    const s = sellerOr404(ctx.params.id!);
    if (u.org_id !== s.org_id) throw forbidden('seller agent can only register assets for own seller');
    if (s.status !== 'verified') throw new ApiError(409, 'seller_not_verified',
      `seller must be verified before registering assets (status=${s.status})`);
    const b = reqObject(ctx.body, 'body');
    const revision = reqInt(b.revision, 'revision', { min: 1 });
    const content = reqSha256(b.content_sha256, 'content_sha256');
    const predecessor = optString(b.predecessor_sha256, 'predecessor_sha256', 64);
    const result = tx(db, () => {
      let assetId = optString(b.asset_id, 'asset_id', 128);
      if (assetId) {
        const existing = one<AssetRow>(db, 'SELECT * FROM assets WHERE id=?', assetId);
        if (!existing) throw notFound('asset');
        if (existing.seller_id !== s.id) throw forbidden('asset belongs to another seller');
        // predecessor must match previous revision's hash for a linear chain
        const prev = one<AssetRevisionRow>(db,
          'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', assetId, revision - 1);
        if (revision > 1 && !prev) throw conflict(`revision ${revision} requires registered revision ${revision - 1}`);
        if (prev && predecessor !== prev.content_sha256) {
          throw conflict(`predecessor_sha256 must equal revision ${revision - 1} hash`);
        }
      } else {
        assetId = rid('ast');
        db.prepare('INSERT INTO assets (id, seller_id, title, created_at) VALUES (?,?,?,?)')
          .run(assetId, s.id, reqString(b.title, 'title'), now());
      }
      const dup = one(db, 'SELECT 1 AS x FROM asset_revisions WHERE asset_id=? AND revision=?', assetId, revision);
      if (dup) throw conflict(`revision ${revision} already registered (immutable)`);
      db.prepare(`INSERT INTO asset_revisions (asset_id, revision, content_sha256, predecessor_sha256, registered_by, created_at)
        VALUES (?,?,?,?,?,?)`).run(assetId, revision, content, predecessor, u.id, now());
      audit(db, u.id, 'asset.revision_registered', { subjectKind: 'asset', subjectId: assetId });
      return assetId;
    });
    return {
      asset: one(db, 'SELECT * FROM assets WHERE id=?', result),
      revision: one(db, 'SELECT * FROM asset_revisions WHERE asset_id=? AND revision=?', result, revision),
    };
  });

  r.get('/assets/{id}', (ctx) => {
    requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const a = one<AssetRow>(db, 'SELECT * FROM assets WHERE id=?', ctx.params.id!);
    if (!a) throw notFound('asset');
    const revisions = all<AssetRevisionRow>(db,
      'SELECT * FROM asset_revisions WHERE asset_id=? ORDER BY revision', a.id);
    const seller = sellerOr404(a.seller_id);
    const offers = all<OfferRow>(db,
      `SELECT id, asset_revision, revision, price_atomic, asset_symbol, rail, expires_at, status, terms_sha256
       FROM offers WHERE asset_id=? AND status='published'`, a.id);
    return { ...a, revisions, seller: { id: seller.id, status: seller.status, agreement_ref: seller.agreement_ref, verified_at: seller.verified_at }, offers };
  });

  return r;
}
