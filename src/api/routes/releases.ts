import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { evaluate } from '../../domain/evaluator.ts';
import { optString, reqObject, reqSha256, reqString } from '../../domain/validate.ts';
import type {
  DecisionRow, IntentRow, PublicationRow, ReceiptRow,
} from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, conflict, forbidden, notFound, Router } from '../http.ts';
import { idempotent } from '../idempotency.ts';

export function releaseRoutes(db: Db): Router {
  const r = new Router();

  const intentOf = (id: string) => {
    const i = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', id);
    if (!i) throw notFound('intent');
    return i;
  };
  const pubOf = (id: string) => {
    const p = one<PublicationRow>(db, 'SELECT * FROM publications WHERE id=?', id);
    if (!p) throw notFound('publication');
    return p;
  };

  // POST /publications — CMS registers the exact artifact it intends to ship.
  r.post('/publications', (ctx) => {
    const u = requireRole(ctx.user, ['publisher']);
    const b = reqObject(ctx.body, 'body');
    const intent = intentOf(reqString(b.intent_id, 'intent_id', 128));
    if (intent.buyer_org_id !== u.org_id) throw forbidden('intent belongs to another organization');
    const artifactHash = reqSha256(b.artifact_hash, 'artifact_hash');
    const artifactAsset = optString(b.artifact_asset_sha256, 'artifact_asset_sha256', 64);
    const { value } = idempotent(db, ctx, 'publications.create', () => {
      const id = rid('pub');
      db.prepare(`INSERT INTO publications (id, buyer_org_id, intent_id, artifact_hash, artifact_asset_sha256, status, created_at)
        VALUES (?,?,?,?,?, 'draft', ?)`)
        .run(id, u.org_id, intent.id, artifactHash, artifactAsset, now());
      audit(db, u.id, 'publication.drafted', { subjectKind: 'publication', subjectId: id });
      return pubOf(id);
    });
    return value;
  });

  // POST /publications/{id}/confirm — the managed release gate (INV-05):
  // re-evaluate immediately before publish; a current matching allow decision
  // bound to this artifact and grant revision is required. Retried confirms
  // for an already-released artifact replay the same receipt — one logical
  // release.
  r.post('/publications/{id}/confirm', (ctx) => {
    const u = requireRole(ctx.user, ['publisher']);
    const pub = pubOf(ctx.params.id!);
    if (pub.buyer_org_id !== u.org_id) throw forbidden('publication belongs to another organization');
    const b = reqObject(ctx.body, 'body');
    const artifactHash = reqSha256(b.artifact_hash, 'artifact_hash');
    const artifactAsset = optString(b.artifact_asset_sha256, 'artifact_asset_sha256', 64)
      ?? pub.artifact_asset_sha256 as string | null;
    if (artifactHash !== pub.artifact_hash) {
      throw conflict('artifact_hash differs from the registered publication artifact');
    }

    // Idempotent replay: released artifact returns its existing receipt.
    const prior = one<ReceiptRow>(db,
      'SELECT * FROM publication_receipts WHERE publication_id=? AND artifact_hash=?',
      pub.id, artifactHash);
    if (prior) return { status: 'released', receipt: prior, replayed: true };

    const intent = intentOf(pub.intent_id);
    const ev = evaluate(db, intent, artifactHash, artifactAsset, now());
    if (ev.result !== 'allow') {
      return tx(db, () => {
        const decId = rid('dec');
        db.prepare(`INSERT INTO decisions (id, intent_id, artifact_hash, intent_hash, grant_id,
            grant_seq, status_watermark, policy_version, result, reason_codes, dimensions,
            decision_hash, evaluated_at, expires_at, actor_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(decId, intent.id, artifactHash, intent.intent_hash, ev.grant_id, ev.grant_seq,
            ev.status_watermark, ev.policy_version, ev.result, JSON.stringify(ev.reason_codes),
            JSON.stringify(ev.dimensions), ev.decision_hash, now(), ev.expires_at, u.id);
        db.prepare(`UPDATE publications SET status='blocked' WHERE id=?`).run(pub.id);
        audit(db, u.id, 'publication.blocked', {
          subjectKind: 'publication', subjectId: pub.id, reasonCode: ev.reason_codes[0],
        });
        return { status: 'blocked', decision_id: decId, evaluation: ev };
      });
    }

    return tx(db, () => {
      // Persist the allow decision bound to this artifact + grant revision.
      let dec = one<DecisionRow>(db,
        `SELECT * FROM decisions WHERE intent_id=? AND artifact_hash=? AND grant_id IS ? AND grant_seq IS ?`,
        intent.id, artifactHash, ev.grant_id, ev.grant_seq);
      if (!dec) {
        const decId = rid('dec');
        db.prepare(`INSERT INTO decisions (id, intent_id, artifact_hash, intent_hash, grant_id,
            grant_seq, status_watermark, policy_version, result, reason_codes, dimensions,
            decision_hash, evaluated_at, expires_at, actor_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(decId, intent.id, artifactHash, intent.intent_hash, ev.grant_id, ev.grant_seq,
            ev.status_watermark, ev.policy_version, ev.result, JSON.stringify(ev.reason_codes),
            JSON.stringify(ev.dimensions), ev.decision_hash, now(), ev.expires_at, u.id);
        dec = one<DecisionRow>(db, 'SELECT * FROM decisions WHERE id=?', decId)!;
      }
      const recId = rid('rec');
      db.prepare(`INSERT INTO publication_receipts (id, publication_id, artifact_hash, decision_id, intent_id, actor_id, published_at)
        VALUES (?,?,?,?,?,?,?)`).run(recId, pub.id, artifactHash, dec.id, intent.id, u.id, now());
      db.prepare(`UPDATE publications SET status='released' WHERE id=?`).run(pub.id);
      audit(db, u.id, 'publication.released', {
        subjectKind: 'publication', subjectId: pub.id, externalRef: dec.id,
      });
      return {
        status: 'released',
        receipt: one<ReceiptRow>(db, 'SELECT * FROM publication_receipts WHERE id=?', recId)!,
        decision: dec, replayed: false,
      };
    });
  });

  r.get('/publications', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'publisher', 'editor', 'rights_officer', 'budget_holder']);
    if (u.role === 'operator') {
      return all(db, 'SELECT * FROM publications ORDER BY created_at DESC');
    }
    return all(db, 'SELECT * FROM publications WHERE buyer_org_id=? ORDER BY created_at DESC', u.org_id);
  });

  r.get('/publications/{id}', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'publisher', 'editor', 'rights_officer', 'budget_holder']);
    const p = pubOf(ctx.params.id!);
    if (u.role !== 'operator' && p.buyer_org_id !== u.org_id) throw forbidden('another organization');
    const receipts = all<ReceiptRow>(db,
      'SELECT * FROM publication_receipts WHERE publication_id=? ORDER BY published_at', p.id);
    const decisions = all<DecisionRow>(db,
      'SELECT * FROM decisions WHERE intent_id=? AND artifact_hash=? ORDER BY evaluated_at',
      p.intent_id, p.artifact_hash);
    return { ...p, receipts, decisions };
  });

  return r;
}
