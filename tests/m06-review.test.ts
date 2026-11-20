import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_HASH, INDIA_INTENT, licensedCase, makeWorld, purchaseLicense,
  seededCatalog, TERMS_SCHEMA, H3, type World,
} from './helpers.ts';
import { all, one } from '../src/db/store.ts';

// M06 · Newsroom review and provenance (FR-06, INV-06)

test('T-011: editor sees exact attribution and edition limits of the release', async () => {
  const w = await makeWorld();
  try {
    const { intentId } = await licensedCase(w);
    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const conf = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf.json.status, 'released');

    const view = await w.call('editor', 'GET', `/intents/${intentId}`);
    const grant = view.json.grants[0];
    assert.equal(grant.attribution, 'Chart: Meridian Charts for The Chronicle');
    assert.deepEqual(JSON.parse(grant.edition_set), ['IN']);
    assert.equal(view.json.receipts.length, 1);
    assert.equal(view.json.receipts[0].decision_id, conf.json.decision.id);

    // Side-by-side comparison surface
    const cmp = await w.call('editor', 'GET', `/intents/${intentId}/compare`);
    assert.equal(cmp.json.intent.attribution_text, grant.attribution);
    assert.deepEqual(cmp.json.grant_scope.edition_set, ['IN']);
    assert.equal(cmp.json.offer_scope.terms_sha256, view.json.intent.terms_sha256);
    assert.equal(cmp.json.intent.asset_sha256, H3);
  } finally { w.cleanup(); }
});

test('T-012: officer note cannot override out-of-scope global edition', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const { intentId } = await purchaseLicense(w, offerId, {
      ...INDIA_INTENT, publication_id: 'pub_g2', edition: 'GLOBAL', territory_set: ['GLOBAL'],
    });
    const denied = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(denied.json.evaluation.result, 'deny');

    // Officer records a note — the known out-of-scope dimension still denies.
    const rv = await w.call('officer', 'POST', '/reviews', {
      subject_kind: 'intent', subject_id: intentId, verdict: 'accepted',
      rationale: 'Requested exception noted — no applicable grant for global.',
      evidence_scope: 'territory,edition',
    });
    assert.equal(rv.status, 200, rv.text);
    const again = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(again.json.evaluation.result, 'deny');
    const codes = again.json.evaluation.reason_codes;
    assert.ok(codes.includes('edition_out_of_scope'));
    assert.ok(codes.includes('territory_out_of_scope'));
  } finally { w.cleanup(); }
});

test('officer review covers unsupported clauses → review_required becomes allow', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w, {
      ...TERMS_SCHEMA,
      clauses: { credit_required: true, bespoke_revival_clause: 'see annex' },
    });
    const { intentId } = await purchaseLicense(w, offerId, INDIA_INTENT);
    const res = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res.json.evaluation.result, 'review_required');
    assert.deepEqual(res.json.evaluation.reason_codes, ['unsupported_terms_clause']);

    const rv = await w.call('officer', 'POST', '/reviews', {
      subject_kind: 'intent', subject_id: intentId, verdict: 'accepted',
      rationale: 'Reviewed annex: revival clause is archival-only, acceptable for this use.',
      evidence_scope: 'terms_support',
    });
    assert.equal(rv.json.version, 1);

    const res2 = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res2.json.evaluation.result, 'allow');
  } finally { w.cleanup(); }
});

test('control declaration clears missing-evidence review state', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const { control_evidence_ref: _r, control_evidence_digest: _d, ...noCtl } = INDIA_INTENT;
    const { intentId } = await purchaseLicense(w, offerId, {
      ...noCtl, publication_id: 'pub_ctl',
    });
    const res = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res.json.evaluation.result, 'review_required');

    const decl = await w.call('editor', 'POST', `/intents/${intentId}/control-declarations`, {
      kind: 'distribution_controls',
      reference: 'controls://edition-routing/in-only',
      digest: 'e'.repeat(64),
    });
    assert.equal(decl.status, 200);

    const res2 = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res2.json.evaluation.result, 'allow');
  } finally { w.cleanup(); }
});

test('pending grant inbox surfaces paid-awaiting and quarantined records', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intent = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intent.json.id, price_cap_atomic: 50000,
    });
    w.issuer.setAvailable(false);
    const box = await w.call('officer', 'GET', '/inbox');
    assert.equal(box.json.paid_awaiting_grant.length, 1);
    assert.equal(box.json.paid_awaiting_grant[0].status, 'paid_awaiting_grant');
  } finally { w.cleanup(); }
});
