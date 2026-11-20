import { all, now, one, tx, type Db } from '../../db/store.ts';
import { rid } from '../../domain/ids.ts';
import { optString, reqObject, reqSha256, reqString } from '../../domain/validate.ts';
import type { IntentRow, ReviewRow } from '../../domain/types.ts';
import { audit, requireRole } from '../auth.ts';
import { ApiError, forbidden, notFound, Router } from '../http.ts';

const REVIEW_SUBJECTS = new Set(['intent', 'decision', 'offer']);
const REVIEW_VERDICTS = new Set(['accepted', 'rejected', 'noted']);

export function reviewRoutes(db: Db): Router {
  const r = new Router();

  const tenantOf = (subjectKind: string, subjectId: string): string | null => {
    if (subjectKind === 'intent') {
      const i = one<IntentRow>(db, 'SELECT buyer_org_id FROM intents WHERE id=?', subjectId);
      return i?.buyer_org_id ?? null;
    }
    if (subjectKind === 'decision') {
      return one<{ buyer_org_id: string }>(db,
        `SELECT i.buyer_org_id FROM decisions d JOIN intents i ON i.id=d.intent_id WHERE d.id=?`,
        subjectId)?.buyer_org_id ?? null;
    }
    if (subjectKind === 'offer') {
      return null; // seller-side record — officer sees via its intents only
    }
    return null;
  };

  // POST /reviews — versioned rights-officer review. Every outcome records
  // authority, reviewer, rationale and evidence scope (INV-06).
  r.post('/reviews', (ctx) => {
    const u = requireRole(ctx.user, ['rights_officer']);
    const b = reqObject(ctx.body, 'body');
    const subjectKind = reqString(b.subject_kind, 'subject_kind', 32);
    const subjectId = reqString(b.subject_id, 'subject_id', 128);
    const verdict = reqString(b.verdict, 'verdict', 32);
    const rationale = reqString(b.rationale, 'rationale', 4096);
    const evidenceScope = reqString(b.evidence_scope, 'evidence_scope', 512);
    if (!REVIEW_SUBJECTS.has(subjectKind)) throw new ApiError(422, 'validation', 'invalid subject_kind');
    if (!REVIEW_VERDICTS.has(verdict)) throw new ApiError(422, 'validation', 'invalid verdict');
    const org = tenantOf(subjectKind, subjectId);
    if (!org) throw notFound('review subject');
    if (org !== u.org_id) throw forbidden('subject belongs to another organization');

    return tx(db, () => {
      const version = (one<{ m: number }>(db,
        'SELECT COALESCE(MAX(version),0)+1 AS m FROM reviews WHERE subject_kind=? AND subject_id=?',
        subjectKind, subjectId))!.m;
      const id = rid('rev');
      db.prepare(`INSERT INTO reviews (id, subject_kind, subject_id, version, reviewer_id, verdict, rationale, evidence_scope, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, subjectKind, subjectId, version, u.id, verdict, rationale, evidenceScope, now());
      // A reviewed intent leaves the intake triage state.
      if (subjectKind === 'intent') {
        db.prepare(`UPDATE intents SET status='specified' WHERE id=? AND status='rights_review'`).run(subjectId);
      }
      audit(db, u.id, 'review.recorded', { subjectKind, subjectId });
      return one<ReviewRow>(db, 'SELECT * FROM reviews WHERE id=?', id)!;
    });
  });

  r.get('/reviews', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'rights_officer', 'publisher', 'editor', 'budget_holder']);
    const kind = ctx.query.get('subject_kind');
    const id = ctx.query.get('subject_id');
    let sql = `SELECT rv.* FROM reviews rv WHERE 1=1`;
    const params: unknown[] = [];
    if (u.role !== 'operator') {
      sql += ` AND ((rv.subject_kind='intent' AND rv.subject_id IN (SELECT id FROM intents WHERE buyer_org_id=?))
        OR (rv.subject_kind='decision' AND rv.subject_id IN
          (SELECT d.id FROM decisions d JOIN intents i ON i.id=d.intent_id WHERE i.buyer_org_id=?)))`;
      params.push(u.org_id, u.org_id);
    }
    if (kind) { sql += ' AND rv.subject_kind=?'; params.push(kind); }
    if (id) { sql += ' AND rv.subject_id=?'; params.push(id); }
    sql += ' ORDER BY rv.subject_id, rv.version';
    return all(db, sql, ...params);
  });

  // POST /intents/{id}/control-declarations — declare the distribution
  // controls gating a restricted edition, with an evidence reference.
  r.post('/intents/{id}/control-declarations', (ctx) => {
    const u = requireRole(ctx.user, ['editor', 'rights_officer']);
    const intent = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', ctx.params.id!);
    if (!intent) throw notFound('intent');
    if (intent.buyer_org_id !== u.org_id) throw forbidden('another organization');
    const b = reqObject(ctx.body, 'body');
    const kind = reqString(b.kind, 'kind', 64);
    const reference = reqString(b.reference, 'reference', 1024);
    const digest = reqSha256(b.digest, 'digest');
    const id = rid('dec_ctl');
    tx(db, () => {
      db.prepare(`INSERT INTO control_declarations (id, intent_id, declared_by, kind, reference, digest, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, intent.id, u.id, kind, reference, digest, now());
      audit(db, u.id, 'controls.declared', { subjectKind: 'intent', subjectId: intent.id });
    });
    return one(db, 'SELECT * FROM control_declarations WHERE id=?', id);
  });

  // GET /inbox — pending grant inbox + quarantine + blocked releases.
  r.get('/inbox', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'rights_officer', 'publisher', 'editor', 'budget_holder']);
    const orgFilter = u.role === 'operator' ? '' : 'AND o.buyer_org_id = ?';
    const params = u.role === 'operator' ? [] : [u.org_id];
    const awaiting = all(db,
      `SELECT o.*, i.publication_id FROM orders o LEFT JOIN intents i ON i.id=o.intent_id
       WHERE o.status='paid_awaiting_grant' ${orgFilter} ORDER BY o.created_at`, ...params);
    const quarantined = u.role === 'operator'
      ? all(db, `SELECT q.* FROM grant_quarantine q ORDER BY q.created_at DESC`)
      : all(db, `SELECT q.* FROM grant_quarantine q JOIN orders o ON o.id=q.order_id
          WHERE o.buyer_org_id=? ORDER BY q.created_at DESC`, u.org_id);
    const blocked = u.role === 'operator'
      ? all(db, `SELECT * FROM publications WHERE status='blocked'`)
      : all(db, `SELECT * FROM publications WHERE status='blocked' AND buyer_org_id=?`, u.org_id);
    return { paid_awaiting_grant: awaiting, quarantined_grants: quarantined, blocked_publications: blocked };
  });

  // GET /intents/{id}/compare — requested use vs offer scope vs grant scope.
  r.get('/intents/{id}/compare', (ctx) => {
    const u = requireRole(ctx.user, ['operator', 'editor', 'budget_holder', 'rights_officer', 'publisher']);
    const intent = one<IntentRow>(db, 'SELECT * FROM intents WHERE id=?', ctx.params.id!);
    if (!intent) throw notFound('intent');
    if (u.role !== 'operator' && intent.buyer_org_id !== u.org_id) throw forbidden('another organization');
    const offer = intent.offer_id
      ? one<{ terms_schema: string; terms_sha256: string; revision: number; terms_text: string }>(
        db, 'SELECT terms_schema, terms_sha256, revision, terms_text FROM offers WHERE id=?', intent.offer_id)
      : null;
    const grant = one<{ edition_set: string; channel_set: string; territory_set: string; purposes: string; attribution: string; valid_from: string; valid_until: string; status: string }>(
      db, `SELECT g.edition_set, g.channel_set, g.territory_set, g.purposes, g.attribution,
        g.valid_from, g.valid_until, g.status FROM grants g
        JOIN orders o ON o.id=g.order_id WHERE o.intent_id=? ORDER BY g.created_at DESC`, intent.id);
    const terms = offer ? JSON.parse(offer.terms_schema) as Record<string, unknown> : null;
    return {
      intent: {
        edition: intent.edition, channel: intent.channel,
        territory_set: JSON.parse(intent.territory_set), purpose: intent.purpose,
        attribution_text: intent.attribution_text, intended_at: intent.intended_at,
        asset_sha256: intent.asset_sha256,
      },
      offer_scope: terms ? {
        edition_set: terms.edition_set, channel_set: terms.channel_set,
        territory_set: terms.territory_set, purposes: terms.purposes,
        attribution: terms.attribution, valid_from: terms.valid_from, valid_until: terms.valid_until,
        terms_sha256: offer!.terms_sha256, offer_revision: offer!.revision,
      } : null,
      grant_scope: grant ? {
        edition_set: JSON.parse(grant.edition_set), channel_set: JSON.parse(grant.channel_set),
        territory_set: JSON.parse(grant.territory_set), purposes: JSON.parse(grant.purposes),
        attribution: grant.attribution, valid_from: grant.valid_from, valid_until: grant.valid_until,
        status: grant.status,
      } : null,
      terms_text: offer?.terms_text ?? null,
    };
  });

  return r;
}
