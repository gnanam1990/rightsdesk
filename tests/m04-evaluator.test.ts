import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_HASH, H4, INDIA_INTENT, licensedCase, makeWorld, purchaseLicense, seededCatalog, type World,
} from './helpers.ts';

// M04 · Deterministic usage evaluator (FR-04, INV-04)

test('T-007: supported H3 India fixture allows; global counterpart denies', async () => {
  const w = await makeWorld();
  try {
    const { intentId, offerId } = await licensedCase(w);

    const res = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res.status, 200, res.text);
    const ev = res.json.evaluation;
    assert.equal(ev.result, 'allow');
    assert.deepEqual(ev.reason_codes, []);
    for (const d of ev.dimensions) {
      assert.equal(d.status, 'satisfied', `${d.dimension}: ${d.detail}`);
    }
    assert.equal(ev.expires_at, '2030-02-01T00:00:00.000Z');
    assert.match(ev.decision_hash, /^[0-9a-f]{64}$/);

    // Identical evaluation replays the persisted decision (stable hash).
    const again = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(again.json.decision.id, res.json.decision.id);
    assert.equal(again.json.evaluation.decision_hash, ev.decision_hash);

    // Global republication: new purchase against same offer, IN-scoped grant,
    // fresh evaluation denies on edition + territory.
    const gi = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
      publication_id: 'pub_global', edition: 'GLOBAL', territory_set: ['GLOBAL'],
    });
    const gOrder = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: gi.json.id, price_cap_atomic: 50000,
    });
    await w.runWorker();
    const gres = await w.call('publisher', 'POST', `/intents/${gi.json.id}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(gres.json.evaluation.result, 'deny');
    const codes = gres.json.evaluation.reason_codes;
    assert.ok(codes.includes('edition_out_of_scope'));
    assert.ok(codes.includes('territory_out_of_scope'));
  } finally { w.cleanup(); }
});

test('T-008: expiry instant denies; missing distribution control refers to review', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    // Exact expiry instant: valid_until is exclusive (half-open window).
    const { intentId: expIntent } = await purchaseLicense(w, offerId, {
      ...INDIA_INTENT, publication_id: 'pub_expiry_edge',
      intended_at: '2030-02-01T00:00:00.000Z',
    });
    const res = await w.call('publisher', 'POST', `/intents/${expIntent}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    const ev = res.json.evaluation;
    assert.equal(ev.result, 'deny');
    assert.ok(ev.reason_codes.includes('outside_validity_window'));
    const tw = ev.dimensions.find((d: any) => d.dimension === 'time_window');
    assert.equal(tw.status, 'violated');

    // Same restricted edition minus control evidence → review_required (not deny).
    const { control_evidence_ref: _r, control_evidence_digest: _d, ...noControls } = INDIA_INTENT;
    const { intentId: nocIntent } = await purchaseLicense(w, offerId, {
      ...noControls, publication_id: 'pub_nocontrols',
    });
    const res2 = await w.call('publisher', 'POST', `/intents/${nocIntent}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    const ev2 = res2.json.evaluation;
    assert.equal(ev2.result, 'review_required');
    assert.deepEqual(ev2.reason_codes, ['missing_distribution_control_evidence']);
    assert.equal(ev2.expires_at, null);

    // And it surfaces in the officer review queue.
    const q = await w.call('officer', 'GET', '/review-queue');
    assert.ok(q.json.review_required_decisions.some((d: any) => d.intent_id === nocIntent));
  } finally { w.cleanup(); }
});

test('INV-04: a violated dimension denies even when others are unknown', async () => {
  const w = await makeWorld();
  try {
    // Intent: no control evidence (unknown) AND artifact carries H4 (violated).
    const { control_evidence_ref: _r2, control_evidence_digest: _d2, ...noControls2 } = INDIA_INTENT;
    const { intentId } = await licensedCase(w, {
      ...noControls2, publication_id: 'pub_mixed',
    });
    const res = await w.call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
      artifact_hash: ARTIFACT_HASH, artifact_asset_sha256: H4,
    });
    const ev = res.json.evaluation;
    assert.equal(ev.result, 'deny');
    assert.ok(ev.reason_codes.includes('asset_hash_mismatch'));
    // the unknown dimension is still reported for evidence
    const dc = ev.dimensions.find((d: any) => d.dimension === 'distribution_control');
    assert.equal(dc.status, 'unknown');
  } finally { w.cleanup(); }
});

test('evaluation without a grant denies (paid is not licensed, INV-03)', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intent = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    // Pay but never run the worker — settled money, no grant.
    await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intent.json.id, price_cap_atomic: 50000,
    });
    const res = await w.call('publisher', 'POST', `/intents/${intent.json.id}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(res.json.evaluation.result, 'deny');
    assert.deepEqual(res.json.evaluation.reason_codes, ['no_active_grant']);
  } finally { w.cleanup(); }
});
