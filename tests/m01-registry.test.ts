import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, verifySeller, H3, H2, type World } from './helpers.ts';

// M01 · Rights-holder and asset registry (FR-01, INV-01)

test('T-001: verified seller registers H3 and exposes asset to the newsroom', async () => {
  const w: World = await makeWorld();
  try {
    // Seller starts pending_review — enrollment is recorded separately from
    // asset authority (INV-01): issuer identity (seller row + keys) vs the
    // immutable asset revision record.
    const before = await w.call('editor', 'GET', '/sellers/sel_meridian');
    assert.equal(before.status, 200);
    assert.equal(before.json.status, 'pending_review');
    assert.equal(before.json.verified_by, null);
    assert.equal(before.json.keys.length, 1); // issuer key v1 registered

    await verifySeller(w);
    const after = await w.call('editor', 'GET', '/sellers/sel_meridian');
    assert.equal(after.json.status, 'verified');
    assert.equal(after.json.verified_by, 'usr_operator');

    // Register revisions 2 then 3 (chain: predecessor enforced)
    const r2 = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      title: 'Chart A', revision: 2, content_sha256: H2,
    });
    assert.equal(r2.status, 200, r2.text);
    const assetId = r2.json.asset.id;

    const r3 = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      asset_id: assetId, revision: 3, content_sha256: H3, predecessor_sha256: H2,
    });
    assert.equal(r3.status, 200, r3.text);
    assert.equal(r3.json.revision.content_sha256, H3);

    // Newsroom sees the asset through the catalog with seller identity attached
    const view = await w.call('editor', 'GET', `/assets/${assetId}`);
    assert.equal(view.status, 200);
    assert.equal(view.json.seller.status, 'verified');
    assert.deepEqual(
      view.json.revisions.map((r: any) => r.revision), [2, 3]);
    const h3rev = view.json.revisions.find((r: any) => r.revision === 3);
    assert.equal(h3rev.content_sha256, H3);
    assert.equal(h3rev.predecessor_sha256, H2);
  } finally { w.cleanup(); }
});

test('T-002: editor cannot register assets; unverified seller cannot publish revisions', async () => {
  const w = await makeWorld();
  try {
    // Editor role lacks seller scope entirely.
    const denied = await w.call('editor', 'POST', '/sellers/sel_meridian/assets', {
      title: 'Forged', revision: 1, content_sha256: 'd'.repeat(64),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'forbidden');

    // Newsroom publisher likewise cannot act as the seller.
    const denied2 = await w.call('publisher', 'POST', '/sellers/sel_meridian/assets', {
      title: 'Forged', revision: 1, content_sha256: 'd'.repeat(64),
    });
    assert.equal(denied2.status, 403);

    // Real seller agent but seller not yet verified → asset authority blocked.
    const pending = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      title: 'Chart A', revision: 1, content_sha256: 'd'.repeat(64),
    });
    assert.equal(pending.status, 409);
    assert.equal(pending.json.error.code, 'seller_not_verified');

    // Unauthenticated → 401.
    const anon = await w.call(null, 'POST', '/sellers/sel_meridian/assets', {
      title: 'X', revision: 1, content_sha256: 'd'.repeat(64),
    });
    assert.equal(anon.status, 401);
  } finally { w.cleanup(); }
});

test('immutable revisions: duplicate revision rejected, predecessor enforced', async () => {
  const w = await makeWorld();
  try {
    await verifySeller(w);
    const r1 = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      title: 'Chart A', revision: 1, content_sha256: H2,
    });
    const assetId = r1.json.asset.id;
    const dup = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      asset_id: assetId, revision: 1, content_sha256: 'e'.repeat(64), predecessor_sha256: null,
    });
    assert.equal(dup.status, 409);
    const badPrev = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
      asset_id: assetId, revision: 2, content_sha256: H3, predecessor_sha256: 'f'.repeat(64),
    });
    assert.equal(badPrev.status, 409);
  } finally { w.cleanup(); }
});

test('key rotation retains retired key for verification history', async () => {
  const w = await makeWorld();
  try {
    const rot = await w.call('seller', 'POST', '/sellers/sel_meridian/keys/rotate', {
      public_key_pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAx\n-----END PUBLIC KEY-----\n',
    });
    assert.equal(rot.status, 200, rot.text);
    const s = await w.call('operator', 'GET', '/sellers/sel_meridian');
    const v1 = s.json.keys.find((k: any) => k.key_version === 1);
    const v2 = s.json.keys.find((k: any) => k.key_version === 2);
    assert.equal(v1.status, 'retired');
    assert.equal(v2.status, 'active');
  } finally { w.cleanup(); }
});
