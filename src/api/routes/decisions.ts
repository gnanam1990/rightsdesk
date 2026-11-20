import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { evaluate } from '../../domain/evaluator.ts';
import { optString, reqObject, reqSha256 } from '../../domain/validate.ts';
import type { DecisionRow, IntentRow } from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { forbidden, notFound, Router } from '../http.ts';

// Persist an evaluation as an immutable decision record; identical inputs
// (intent, artifact, grant revision) replay the stored row.
export function persistDecision(
  db: Db, intent: IntentRow, artifactHash: string,
  ev: ReturnType<typeof evaluate>, actorId: string,
): DecisionRow {
  return tx(db, () => {
    const existing = one<DecisionRow>(db,
      `SELECT * FROM decisions WHERE intent_id=? AND artifact_hash=?
       AND grant_id IS ? AND grant_seq IS ?`,
      intent.id, artifactHash, ev.grant_id, ev.grant_seq);
    if (existing) return existing;
    const id = rid('dec');
    db.prepare(`INSERT INTO decisions (id, intent_id, artifact_hash, intent_hash, grant_id,
        grant_seq, status_watermark, policy_version, result, reason_codes, dimensions,
        decision_hash, evaluated_at, expires_at, actor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, intent.id, artifactHash, intent.intent_hash, ev.grant_id, ev.grant_seq,
        ev.status_watermark, ev.policy_version, ev.result, JSON.stringify(ev.reason_codes),
        JSON.stringify(ev.dimensions), ev.decision_hash, ev.time_window.evaluated_at,
        ev.expires_at, actorId);
    audit(db, actorId, 'decision.evaluated', {
      subjectKind: 'intent', subjectId: intent.id, reasonCode: ev.reason_codes[0],
    });
    return one<DecisionRow>(db, 'SELECT * FROM decisions WHERE id=?', id)!;
  });
}

export function decisionRoutes(db: Db): Router {
  const r = new Router();

  const intentOf = (id: string) => {
    const i = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', id);
    if (!i) throw notFound('intent');
    return i;
  };
  const assertTenant = (u: { org_id: string; role: string }, orgId: string) => {
    if (u.role !== 'operator' && u.org_id !== orgId) {
      throw forbidden('record belongs to another organization');
    }
  };

  // POST /intents/{id}/evaluate — deterministic per-use evaluation; identical
  // inputs return the persisted decision (stable decision_hash).
  r.post('/intents/{id}/evaluate', (ctx) => {
    const u = requireRole(ctx.user, ['publisher', 'rights_officer', 'operator']);
    const intent = intentOf(ctx.params.id!);
    assertTenant(u, intent.buyer_org_id);
    const b = reqObject(ctx.body, 'body');
    const artifactHash = reqSha256(b.artifact_hash, 'artifact_hash');
    const artifactAsset = optString(b.artifact_asset_sha256, 'artifact_asset_sha256', 64);

    const ev = evaluate(db, intent, artifactHash, artifactAsset, now());
    const decision = persistDecision(db, intent, artifactHash, ev, u.id);
    return { decision, evaluation: ev };
  });

  r.get('/decisions/{id}', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'seller_agent', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const d = one<DecisionRow>(db, 'SELECT * FROM decisions WHERE id=?', ctx.params.id!);
    if (!d) throw notFound('decision');
    const intent = intentOf(d.intent_id);
    if (u.role === 'seller_agent') {
      const o = intent.offer_id
        ? one(db, 'SELECT seller_id FROM offers WHERE id=?', intent.offer_id) : null;
      const s = o ? one(db, 'SELECT org_id FROM sellers WHERE id=?', (o as { seller_id: string }).seller_id) : null;
      if (!s || (s as { org_id: string }).org_id !== u.org_id) throw forbidden('not your decision');
    } else {
      assertTenant(u, intent.buyer_org_id);
    }
    return { ...d, reason_codes: JSON.parse(d.reason_codes), dimensions: JSON.parse(d.dimensions) };
  });

  r.get('/decisions', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const intentId = ctx.query.get('intent_id');
    const result = ctx.query.get('result');
    let sql = 'SELECT d.* FROM decisions d JOIN intents i ON i.id=d.intent_id WHERE 1=1';
    const params: unknown[] = [];
    if (u.role !== 'operator') { sql += ' AND i.buyer_org_id=?'; params.push(u.org_id); }
    if (intentId) { sql += ' AND d.intent_id=?'; params.push(intentId); }
    if (result) { sql += ' AND d.result=?'; params.push(result); }
    sql += ' ORDER BY d.evaluated_at DESC';
    return all(db, sql, ...params);
  });

  // Review queue: decisions needing a rights officer + flagged intents.
  r.get('/review-queue', (ctx) => {
    const u = requireRole(ctx.user, ['rights_officer', 'operator']);
    const pending = all(db,
      `SELECT d.*, i.buyer_org_id FROM decisions d JOIN intents i ON i.id=d.intent_id
       WHERE d.result='review_required' AND i.buyer_org_id=? ORDER BY d.evaluated_at DESC`, u.org_id);
    const flagged = all(db,
      `SELECT * FROM intents WHERE buyer_org_id=? AND status='rights_review' ORDER BY created_at DESC`, u.org_id);
    const awaitingGrant = all(db,
      `SELECT o.* FROM orders o WHERE o.buyer_org_id=? AND o.status='paid_awaiting_grant'`, u.org_id);
    return { review_required_decisions: pending, flagged_intents: flagged, paid_awaiting_grant: awaitingGrant };
  });

  return r;
}
