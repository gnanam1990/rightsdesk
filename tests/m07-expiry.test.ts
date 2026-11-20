import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_HASH, licensedCase, makeWorld, type World } from './helpers.ts';
import { buildGrantEvent, signGrantEvent } from '../src/domain/grants.ts';
import { scheduleExpiryScan } from '../src/worker.ts';
import { one } from '../src/db/store.ts';

// M07 · Expiry, issuer updates and audit export (FR-07, INV-07)

// Issuer-side signer for arbitrary event payloads (used for stale replays).
function signEvent(w: World, sellerId: string, seq: number, kind: 'revoked' | 'reinstated' | 'expired', grantId: string) {
  const newStatus = kind === 'reinstated' ? 'active' : kind;
  const payload = buildGrantEvent(sellerId, grantId, seq, kind, newStatus as 'revoked' | 'active' | 'expired');
  const priv = readFileSync(join(w.keyDir, `${sellerId}_v1.pem`), 'utf8');
  return { payload, signature: signGrantEvent(priv, payload), key_version: 1 };
}

async function releasedCase(w: World) {
  const c = await licensedCase(w);
  const pub = await w.call('publisher', 'POST', '/publications', {
    intent_id: c.intentId, artifact_hash: ARTIFACT_HASH,
  });
  const conf = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
    artifact_hash: ARTIFACT_HASH,
  });
  assert.equal(conf.json.status, 'released', conf.text);
  return { ...c, publicationId: pub.json.id as string, decisionId: conf.json.decision.id as string };
}

test('T-013: revocation flags impacted uses; Jan 20 evaluation proof preserved', async () => {
  const w = await makeWorld();
  try {
    const { grantId, decisionId, intentId } = await releasedCase(w);

    const ev = w.issuer.makeStatusEvent(grantId, 'revoked');
    const sent = await w.call('operator', 'POST', '/issuers/sel_meridian/grant-events', ev);
    assert.equal(sent.status, 200, sent.text);

    // Historic proof is unchanged: decision still allow, receipt still present.
    const dec = await w.call('publisher', 'GET', `/decisions/${decisionId}`);
    assert.equal(dec.json.result, 'allow');
    const view = await w.call('editor', 'GET', `/intents/${intentId}`);
    assert.equal(view.json.receipts.length, 1);

    // Impacted-uses surface shows the ordered event log.
    const impacts = await w.call('publisher', 'GET', `/grants/${grantId}/impacts`);
    assert.equal(impacts.json.grant.status, 'revoked');
    assert.equal(impacts.json.receipts.length, 1);
    assert.deepEqual(impacts.json.events.map((e: any) => e.kind), ['issued', 'revoked']);

    // A subsequent use is denied.
    const pub2 = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const conf2 = await w.call('publisher', 'POST', `/publications/${pub2.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf2.json.status, 'blocked');
    assert.ok(conf2.json.evaluation.reason_codes.includes('grant_not_active'));
  } finally { w.cleanup(); }
});

test('T-014: stale replayed status event cannot resurrect rights', async () => {
  const w = await makeWorld();
  try {
    const { grantId } = await licensedCase(w);
    const revoked = w.issuer.makeStatusEvent(grantId, 'revoked');
    await w.call('operator', 'POST', '/issuers/sel_meridian/grant-events', revoked);

    // Replay the exact same signed event → rejected as stale.
    const replay = await w.call('operator', 'POST', '/issuers/sel_meridian/grant-events', revoked);
    assert.equal(replay.status, 409);

    // A signed "reinstated" carrying the already-consumed seq → stale too.
    const staleReinstate = signEvent(w, 'sel_meridian', 1, 'reinstated', grantId);
    const r2 = await w.call('operator', 'POST', '/issuers/sel_meridian/grant-events', staleReinstate);
    assert.equal(r2.status, 409);

    const g = one<{ status: string }>(w.db, 'SELECT status FROM grants WHERE id=?', grantId);
    assert.equal(g!.status, 'revoked');

    // A properly-sequenced reinstatement applies and permits use again.
    const fresh = w.issuer.makeStatusEvent(grantId, 'reinstated');
    const ok = await w.call('operator', 'POST', '/issuers/sel_meridian/grant-events', fresh);
    assert.equal(ok.status, 200);
    const g2 = one<{ status: string }>(w.db, 'SELECT status FROM grants WHERE id=?', grantId);
    assert.equal(g2!.status, 'active');
  } finally { w.cleanup(); }
});

test('expiry scan marks grants expired and blocks future use', async () => {
  const w = await makeWorld();
  try {
    const { intentId, grantId } = await licensedCase(w);
    // Fast-forward past validity: update row + payload.
    const g = one<{ payload_json: string }>(w.db, 'SELECT payload_json FROM grants WHERE id=?', grantId)!;
    const payload = JSON.parse(g.payload_json);
    payload.valid_until = '2020-01-01T00:00:00.000Z';
    w.db.prepare('UPDATE grants SET payload_json=?, valid_until=? WHERE id=?')
      .run(JSON.stringify(payload), '2020-01-01T00:00:00.000Z', grantId);

    scheduleExpiryScan(w.db);
    await w.runWorker();

    const now = one<{ status: string }>(w.db, 'SELECT status FROM grants WHERE id=?', grantId)!;
    assert.equal(now.status, 'expired');
    const ev = one<{ kind: string }>(w.db,
      `SELECT kind FROM grant_events WHERE grant_id=? AND kind='expired'`, grantId);
    assert.ok(ev, 'expiry event recorded');

    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const conf = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf.status, 200);
    assert.equal(conf.json.status, 'blocked');
  } finally { w.cleanup(); }
});

test('decision packet export: complete, hashed, access-controlled', async () => {
  const w = await makeWorld();
  try {
    const { intentId, grantId } = await releasedCase(w);
    const pkt = await w.call('officer', 'GET', `/cases/${intentId}/export`);
    assert.equal(pkt.status, 200, pkt.text);
    assert.equal(pkt.json.packet_schema, 'rightsdesk.packet.v1');
    assert.match(pkt.json.packet_hash, /^[0-9a-f]{64}$/);
    assert.equal(pkt.json.grants[0].id, grantId);
    assert.equal(pkt.json.grants[0].payload.grant_id, grantId);
    assert.ok(pkt.json.decisions.length >= 1); // release re-check decision
    assert.equal(pkt.json.receipts.length, 1);
    assert.ok(pkt.json.seller.keys.length >= 1);
    assert.equal(pkt.json.asset_revisions.length, 3);
    assert.ok(pkt.json.exported_by.actor_id);

    // A non-existent case is 404; a seller agent cannot export a buyer case.
    const other = await w.call('editor', 'GET', '/cases/int_other/export');
    assert.equal(other.status, 404);
    const denied = await w.call('seller', 'GET', `/cases/${intentId}/export`);
    assert.equal(denied.status, 403);
  } finally { w.cleanup(); }
});

test('key rotation retains old key for historical verification', async () => {
  const w = await makeWorld();
  try {
    const { intentId, grantId } = await licensedCase(w);
    // Issuer-side rotation retires v1, activates v2 (custody stays with issuer).
    const rot = w.issuer.rotateKey('sel_meridian');
    assert.equal(rot.keyVersion, 2);

    const pkt = await w.call('officer', 'GET', `/cases/${intentId}/export`);
    const v1 = pkt.json.seller.keys.find((k: any) => k.key_version === 1);
    const v2 = pkt.json.seller.keys.find((k: any) => k.key_version === 2);
    assert.equal(v1.status, 'retired');
    assert.equal(v2.status, 'active');

    // The grant signed under v1 still verifies and still permits release.
    const g = one<{ signature: string; issuer_key_version: number; payload_json: string }>(
      w.db, 'SELECT signature, issuer_key_version, payload_json FROM grants WHERE id=?', grantId)!;
    const { verifyGrantSignature } = await import('../src/domain/grants.ts');
    const check = verifyGrantSignature(w.db, 'sel_meridian', g.issuer_key_version, JSON.parse(g.payload_json), g.signature);
    assert.equal(check.valid, true, check.reason);

    const pub = await w.call('publisher', 'POST', '/publications', {
      intent_id: intentId, artifact_hash: ARTIFACT_HASH,
    });
    const conf = await w.call('publisher', 'POST', `/publications/${pub.json.id}/confirm`, {
      artifact_hash: ARTIFACT_HASH,
    });
    assert.equal(conf.json.status, 'released');
  } finally { w.cleanup(); }
});
