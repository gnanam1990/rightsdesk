import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { verifyGrantEventSignature, type GrantEventPayload } from '../../domain/grants.ts';
import { reqInt, reqObject, reqString } from '../../domain/validate.ts';
import type { GrantEventRow, GrantRow, SellerRow } from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, conflict, forbidden, notFound, Router } from '../http.ts';

// Authenticated, ordered grant status events (SECURITY.md): signature checked
// against the recorded key version; strictly monotonic seq per grant — a
// replayed or older message is rejected and can never resurrect a license.
export function eventRoutes(db: Db): Router {
  const r = new Router();

  r.post('/issuers/{id}/grant-events', (ctx) => {
    const u = requireRole(ctx.user, ['seller_agent', 'operator']);
    const seller = one<SellerRow>(db, 'SELECT * FROM sellers WHERE id=?', ctx.params.id!);
    if (!seller) throw notFound('issuer');
    if (u.role === 'seller_agent' && u.org_id !== seller.org_id) {
      throw forbidden('issuer belongs to another seller org');
    }
    const b = reqObject(ctx.body, 'body');
    const payload = reqObject(b.payload, 'payload') as unknown as GrantEventPayload;
    const signature = reqString(b.signature, 'signature', 4096);
    const keyVersion = reqInt(b.key_version, 'key_version', { min: 1 });

    if (payload.schema !== 'rightsdesk.grant-event.v1') {
      throw new ApiError(422, 'event_schema', 'unsupported event schema');
    }
    if (payload.seller_id !== seller.id) throw forbidden('event seller mismatch');
    if (!['revoked', 'reinstated', 'expired'].includes(payload.kind)) {
      throw new ApiError(422, 'event_kind', `unsupported event kind ${payload.kind}`);
    }
    const grant = one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', payload.grant_id);
    if (!grant || grant.seller_id !== seller.id) throw notFound('grant');

    const sig = verifyGrantEventSignature(db, payload, signature, keyVersion);
    if (!sig.valid) {
      audit(db, u.id, 'grant_event.rejected', {
        subjectKind: 'grant', subjectId: grant.id, reasonCode: sig.reason,
      });
      throw new ApiError(422, 'signature_invalid', `event signature invalid: ${sig.reason}`);
    }
    if (payload.seq <= grant.status_seq) {
      // Stale replay — rejected, state untouched.
      audit(db, u.id, 'grant_event.rejected', {
        subjectKind: 'grant', subjectId: grant.id, reasonCode: 'stale_seq',
      });
      throw conflict(`event seq ${payload.seq} already applied (watermark ${grant.status_seq})`);
    }
    if (payload.seq !== grant.status_seq + 1) {
      throw conflict(`event seq gap: expected ${grant.status_seq + 1}, got ${payload.seq}`);
    }

    const applied = tx(db, () => {
      const id = rid('gev');
      db.prepare(`INSERT INTO grant_events (id, seller_id, grant_id, seq, kind, new_status, signature, key_version, actor, received_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, seller.id, grant.id, payload.seq, payload.kind, payload.new_status,
          signature, keyVersion, u.id, now());
      db.prepare('UPDATE grants SET status=?, status_seq=? WHERE id=?')
        .run(payload.new_status, payload.seq, grant.id);
      audit(db, u.id, `grant_event.${payload.kind}`, {
        subjectKind: 'grant', subjectId: grant.id,
      });
      return one<GrantEventRow>(db, 'SELECT * FROM grant_events WHERE id=?', id)!;
    });
    return { event: applied, grant: one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', grant.id) };
  });

  r.get('/grants/{id}/events', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'budget_holder', 'rights_officer', 'publisher', 'editor']);
    const g = one<GrantRow>(db, 'SELECT * FROM grants WHERE id=?', ctx.params.id!);
    if (!g) throw notFound('grant');
    if (u.role === 'seller_agent') {
      const s = one<SellerRow>(db, 'SELECT org_id FROM sellers WHERE id=?', g.seller_id)!;
      if ((s as { org_id: string }).org_id !== u.org_id) throw forbidden('another seller');
    } else if (u.role !== 'operator' && g.buyer_org_id !== u.org_id) {
      throw forbidden('another organization');
    }
    return all(db, 'SELECT * FROM grant_events WHERE grant_id=? ORDER BY seq', g.id);
  });

  return r;
}
