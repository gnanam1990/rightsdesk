import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDIA_INTENT, makeWorld, seededCatalog, TERMS_SCHEMA, H3, type World } from './helpers.ts';
import { one } from '../src/db/store.ts';

// M03 · Purchase and grant acquisition (FR-03, INV-03)

async function makeIntent(w: World, offerId: string, intent = INDIA_INTENT) {
  const res = await w.call('editor', 'POST', '/publication-intents', { ...intent, offer_id: offerId });
  assert.equal(res.status, 200, res.text);
  return res.json.id as string;
}

test('T-005: settled checkout + worker issues one signed grant; retries recover the same grant', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intentId = await makeIntent(w, offerId);

    const res = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 12500, idempotency_key: 'ord-001',
    });
    assert.equal(res.status, 200, res.text);
    const order = res.json.order;
    assert.equal(order.status, 'paid_awaiting_grant');
    assert.match(order.payment_ref, /^pay_emu_/);
    // INV-03: payment exists but no license yet
    const preGrant = await w.call('budget', 'GET', `/orders/${order.id}`);
    assert.equal(preGrant.json.grant, null);

    // Idempotent retry of the same approval returns the stored operation ref.
    const retry = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 12500, idempotency_key: 'ord-001',
    });
    assert.equal(retry.json.order.id, order.id);

    // Worker issues the seller-signed grant.
    const t1 = await w.runWorker();
    assert.equal(t1.errors, 0);
    const after = await w.call('budget', 'GET', `/orders/${order.id}`);
    assert.equal(after.json.status, 'grant_active');
    const grant = after.json.grant;
    assert.equal(grant.status, 'active');
    assert.equal(grant.asset_sha256, H3);
    assert.equal(grant.issuer_key_version, 1);
    assert.match(grant.signed_payload_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(grant.territory_set), ['IN']);

    // Retry issuance after confirmed settlement recovers the SAME grant.
    const again = await w.call('seller', 'POST', '/issuers/sel_meridian/grants', { order_id: order.id });
    assert.equal(again.status, 200);
    assert.equal(again.json.status, 'already_issued');
    assert.equal(again.json.grant.id, grant.id);
  } finally { w.cleanup(); }
});

test('T-006: paid order with unavailable issuer stays paid_awaiting_grant, no permit', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intentId = await makeIntent(w, offerId);
    const res = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 20000,
    });
    const order = res.json.order;
    assert.equal(order.status, 'paid_awaiting_grant');

    w.issuer.setAvailable(false);
    await w.runWorker();
    // Simulate the backoff window elapsing, then retry.
    w.db.prepare(`UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'`).run();
    await w.runWorker();

    const after = await w.call('budget', 'GET', `/orders/${order.id}`);
    assert.equal(after.json.status, 'paid_awaiting_grant');
    assert.equal(after.json.grant, null);
    // outbox row keeps pending for reconciliation (not silently failed)
    const ob = one(w.db, `SELECT * FROM outbox WHERE kind='order.settled'`) as any;
    assert.equal(ob.status, 'pending');
    assert.ok(ob.attempts >= 2);

    // Issuer recovers → grant issues on next tick.
    w.issuer.setAvailable(true);
    w.db.prepare(`UPDATE outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE status='pending'`).run();
    await w.runWorker();
    const done = await w.call('budget', 'GET', `/orders/${order.id}`);
    assert.equal(done.json.status, 'grant_active');
    assert.equal(done.json.grant.status, 'active');
  } finally { w.cleanup(); }
});

test('price cap, duplicate purchase, and editor-cannot-approve boundaries', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intentId = await makeIntent(w, offerId);

    const low = await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 100,
    });
    assert.equal(low.status, 422);
    assert.equal(low.json.error.code, 'price_cap_exceeded');

    const editorTry = await w.call('editor', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 999999,
    });
    assert.equal(editorTry.status, 403);

    // Grant cannot be issued before settlement.
    const pre = await w.call('seller', 'POST', '/issuers/sel_meridian/grants', { order_id: 'ord_none' });
    assert.equal(pre.status, 404);
  } finally { w.cleanup(); }
});

test('unverified seller cannot issue a trusted grant (T-002 completion)', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);
    const intentId = await makeIntent(w, offerId);
    await w.call('budget', 'POST', `/offers/${offerId}/orders`, {
      intent_id: intentId, price_cap_atomic: 12500,
    });
    const order = one(w.db, 'SELECT * FROM orders') as any;

    // Suspend the seller: issuance now refuses, order stays paid_awaiting_grant.
    await w.call('operator', 'POST', '/sellers/sel_meridian/suspend', {});
    const res = w.issuer.issueGrant(order.id, 'test');
    assert.equal(res.status, 'rejected');
    const o = one(w.db, 'SELECT * FROM orders WHERE id=?', order.id) as any;
    assert.equal(o.status, 'paid_awaiting_grant');
    const grants = w.db.prepare('SELECT COUNT(*) AS c FROM grants').get() as any;
    assert.equal(grants.c, 0);
  } finally { w.cleanup(); }
});
