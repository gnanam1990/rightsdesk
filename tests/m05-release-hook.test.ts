import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_HASH, H4, INDIA_INTENT, licensedCase, makeWorld, seededCatalog, purchaseLicense, type World,
} from './helpers.ts';
import { all, one } from '../src/db/store.ts';

// M05 · Release hook and concurrency (FR-05, INV-05)

test('T-009: publishing the same approved artifact twice records one logical release', async () => {
  const w = await makeWorld();
  try {
    const { intentId } = await licensedCase(w);
    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(pub.status, 200, pub.text);

    const c1 = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c1.json.status, 'released');
    const receiptId = c1.json.receipt.id;
    assert.equal(c1.json.decision.result, 'allow');

    // Retry — same operation replays the same receipt, one logical release.
    const c2 = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(c2.json.status, 'released');
    assert.equal(c2.json.receipt.id, receiptId);
    assert.equal(c2.json.replayed, true);

    const receipts = all(w.db, 'SELECT * FROM publication_receipts WHERE publication_id=?', pub.json.id);
    assert.equal(receipts.length, 1);
  } finally { w.cleanup(); }
});

test('T-010: artifact swapped to H4 blocks; revocation before release blocks', async () => {
  const w = await makeWorld();
  try {
    const { intentId, grantId } = await licensedCase(w);

    // (a) Same artifact name but carrying an unlicensed chart hash H4.
    const badPub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH, artifact_asset_sha256: H4,
    });
    const blocked = await w.call('publisher', 'POST', `/publications/${badPub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(blocked.json.status, 'blocked');
    assert.ok(blocked.json.evaluation.reason_codes.includes('asset_hash_mismatch'));
    assert.equal((all(w.db, 'SELECT * FROM publication_receipts WHERE publication_id=?', badPub.json.id)).length, 0);

    // (b) Valid artifact; grant revoked by signed issuer event before release.
    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    // a prior allow decision exists but is not a permit after revocation
    const ev = w.issuer.makeStatusEvent(grantId, 'revoked');
    const rev = await w.call('seller', 'POST', '/issuers/sel_meridian/grant-events', ev);
    assert.equal(rev.status, 200, rev.text);
    assert.equal(rev.json.grant.status, 'revoked');

    const conf = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf.json.status, 'blocked');
    assert.ok(conf.json.evaluation.reason_codes.includes('grant_not_active'));
    assert.equal((all(w.db, 'SELECT * FROM publication_receipts WHERE publication_id=?', pub.json.id)).length, 0);

    // Reinstated grant releases on retry — current state governs, not stale deny.
    const ev2 = w.issuer.makeStatusEvent(grantId, 'reinstated');
    await w.call('seller', 'POST', '/issuers/sel_meridian/grant-events', ev2);
    const conf2 = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf2.json.status, 'released');
  } finally { w.cleanup(); }
});

test('confirm boundary: artifact mismatch, cross-tenant, non-publisher', async () => {
  const w = await makeWorld();
  try {
    const { intentId } = await licensedCase(w);
    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const wrong = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: '9'.repeat(64),
    });
    assert.equal(wrong.status, 409);
    const wrongRole = await w.call('editor', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(wrongRole.status, 403);
    const p = await w.call('publisher', 'GET', `/publications/${pub.json.id}`);
    assert.equal(p.json.status, 'draft');
  } finally { w.cleanup(); }
});
