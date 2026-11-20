import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_HASH, INDIA_INTENT, licensedCase, makeWorld, seededCatalog,
} from './helpers.ts';
import { signGrantPayload } from '../src/domain/grants.ts';
import { one } from '../src/db/store.ts';
import type { GrantPayloadV1 } from '../src/domain/types.ts';

// M08 · Partner pilot and recovery rehearsal (FR-08, T-015, T-016)

function backdateDue(db: ReturnType<typeof import('../src/db/store.ts').openDb>) {
  db.prepare(`UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'`).run();
}

test('T-015: restart after checkout recovers the grant before the release gate', async () => {
  const w1 = await makeWorld({ memoryDb: false });
  let intentId = '';
  let orderId = '';
  const dir = w1.dir;
  try {
    const { offerId } = await seededCatalog(w1);
    const intent = await w1.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    intentId = intent.json.id;
    const ord = await w1.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 50000,
    });
    orderId = ord.json.order.id;
    assert.equal(ord.json.order.status, 'paid_awaiting_grant');
    // Crash window: payment settled, grant not yet issued — no worker run.
  } finally {
    // Close everything but keep the data dir — simulates a restart.
    w1.server.close(); w1.db.close();
  }

  const w2 = await makeWorld({ dir, seedDb: false });
  try {
    await w2.runWorker(); // order.settled → issuer recovers the grant
    const check = await w2.call('budget', 'GET', `/orders/${orderId}`);
    assert.equal(check.json.status, 'grant_active', check.text);
    assert.ok(check.json.grant?.id, 'grant recovered after restart');

    const pub = await w2.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const conf = await w2.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf.json.status, 'released', conf.text);
  } finally {
    w2.server.close(); w2.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-016: signed grant bound to a different buyer is quarantined, no permit', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intent = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId, publication_id: 'pub_q',
    });
    const ord = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intent.json.id, price_cap_atomic: 50000,
    });
    const orderId = ord.json.order.id as string;

    // Craft a payload signed by the real issuer key but bound to the wrong buyer.
    const priv = readFileSync(join(w.keyDir, 'sel_meridian_v1.pem'), 'utf8');
    const bogus: GrantPayloadV1 = {
      schema: 'rightsdesk.grant.v1',
      grant_id: 'gra_bogus', seller_id: 'sel_meridian', order_id: orderId,
      buyer_org_id: 'org_evil', asset_sha256: 'a'.repeat(64),
      edition_set: ['IN'], channel_set: ['web'], territory_set: ['IN'],
      purposes: ['editorial'], attribution: 'Chart: Meridian Charts for The Chronicle',
      valid_from: '2030-01-01T00:00:00.000Z', valid_until: '2030-02-01T00:00:00.000Z',
      issued_at: '2030-01-05T00:00:00.000Z', key_version: 1,
    };
    const res = await w.call('seller', 'POST', '/issuers/sel_meridian/grants', {
      order_id: orderId, payload: bogus, signature: signGrantPayload(priv, bogus),
    });
    assert.equal(res.status, 422, res.text);
    assert.equal(res.json.error.code, 'grant_quarantined');

    // Quarantine row recorded; order did not acquire a license.
    const q = one<{ reason: string }>(w.db,
      'SELECT reason FROM grant_quarantine WHERE order_id=?', orderId);
    assert.equal(q!.reason, 'binding_mismatch');
    const check = await w.call('budget', 'GET', `/orders/${orderId}`);
    assert.equal(check.json.status, 'paid_awaiting_grant');

    // No permit: evaluation denies on the missing grant.
    const ev = await w.call('publisher', 'POST', `/intents/${intent.json.id}/evaluate`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(ev.json.evaluation.result, 'deny');
    assert.ok(ev.json.evaluation.reason_codes.includes('no_active_grant'));
  } finally { w.cleanup(); }
});

test('unknown settlement stops dispatch until inspect recovers the outcome', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    w.checkout.firstCallStatus = 'unknown';
    const intent = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId, publication_id: 'pub_u',
    });
    const ord = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intent.json.id, price_cap_atomic: 50000,
    });
    const orderId = ord.json.order.id as string;
    assert.equal(ord.json.order.status, 'payment_unknown');

    // Inspect still reports unknown — automatic redispatch stays parked.
    await w.runWorker();
    const still = await w.call('budget', 'GET', `/orders/${orderId}`);
    assert.equal(still.json.status, 'payment_unknown');
    assert.equal(still.json.grant, null);

    // Provider later settles; the reconciliation worker picks it up.
    const ref = one<{ payment_ref: string }>(w.db,
      'SELECT payment_ref FROM orders WHERE id=?', orderId)!.payment_ref;
    w.checkout.forceSettle(ref);
    backdateDue(w.db);
    await w.runWorker(); // inspect → settled → enqueue order.settled
    backdateDue(w.db);
    await w.runWorker(); // order.settled → issue grant
    const done = await w.call('budget', 'GET', `/orders/${orderId}`);
    assert.equal(done.json.status, 'grant_active', done.text);
  } finally { w.cleanup(); }
});

test('T-016: grant signed by an unknown key version is quarantined', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intent = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId, publication_id: 'pub_qk',
    });
    const ord = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intent.json.id, price_cap_atomic: 50000,
    });
    const orderId = ord.json.order.id as string;
    const order = one<{ buyer_org_id: string }>(w.db,
      'SELECT buyer_org_id FROM orders WHERE id=?', orderId)!;

    const priv = readFileSync(join(w.keyDir, 'sel_meridian_v1.pem'), 'utf8');
    const bogus: GrantPayloadV1 = {
      schema: 'rightsdesk.grant.v1',
      grant_id: 'gra_badkey', seller_id: 'sel_meridian', order_id: orderId,
      buyer_org_id: order.buyer_org_id, asset_sha256: 'a'.repeat(64),
      edition_set: ['IN'], channel_set: ['web'], territory_set: ['IN'],
      purposes: ['editorial'], attribution: 'Chart: Meridian Charts for The Chronicle',
      valid_from: '2030-01-01T00:00:00.000Z', valid_until: '2030-02-01T00:00:00.000Z',
      issued_at: '2030-01-05T00:00:00.000Z', key_version: 99,
    };
    const res = await w.call('seller', 'POST', '/issuers/sel_meridian/grants', {
      order_id: orderId, payload: bogus, signature: signGrantPayload(priv, bogus),
    });
    assert.equal(res.status, 422);
    const q = one<{ reason: string }>(w.db,
      'SELECT reason FROM grant_quarantine WHERE order_id=?', orderId);
    assert.equal(q!.reason, 'key_version_unknown');
  } finally { w.cleanup(); }
});
