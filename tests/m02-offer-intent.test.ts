import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDIA_INTENT, makeWorld, seededCatalog, TERMS_SCHEMA, TERMS_TEXT, H3,
} from './helpers.ts';
import { sha256Hex } from '../src/domain/canon.ts';

// M02 · Offer and editorial intent (FR-02, INV-02)

test('T-003: Jan 20 India web editorial intent binds the declared H3 offer', async () => {
  const w = await makeWorld();
  try {
    const { offerId, termsSha256 } = await seededCatalog(w);

    // terms digest = sha256 over the original persisted terms text
    assert.equal(termsSha256, sha256Hex(TERMS_TEXT));

    const res = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    assert.equal(res.status, 200, res.text);
    const intent = res.json;
    // INV-02: offer revision + signed terms digest accompany the intent
    assert.equal(intent.offer_id, offerId);
    assert.equal(intent.offer_revision, 1);
    assert.equal(intent.terms_sha256, termsSha256);
    assert.equal(intent.asset_sha256, H3);
    assert.equal(intent.asset_revision, 3);
    assert.equal(intent.edition, 'IN');
    assert.equal(intent.channel, 'web');
    assert.equal(intent.purpose, 'editorial');
    assert.equal(intent.intended_at, '2030-01-20T12:00:00.000Z');
    assert.equal(intent.status, 'specified');
    assert.deepEqual(intent.flags.unsupported_clauses, []);
    assert.match(intent.intent_hash, /^[0-9a-f]{64}$/);

    // Case view exposes intent + offer + seller to the tenant
    const view = await w.call('editor', 'GET', `/intents/${intent.id}`);
    assert.equal(view.json.intent.asset_sha256, H3);
    assert.equal(view.json.offer.id, offerId);
    assert.equal(view.json.seller.status, 'verified');
    // terms schema visible as machine-readable structure
    assert.equal(view.json.offer.terms_sha256, termsSha256);
  } finally { w.cleanup(); }
});

test('T-004: unknown legal clause is explicitly referred for rights review', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w, {
      ...TERMS_SCHEMA,
      clauses: {
        credit_required: true,
        in_perpetuity_all_media: true,        // not in the supported vocabulary
        irrevocable_worldwide_sublicense: {}, // likewise unknown
      },
    });
    const res = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    assert.equal(res.status, 200, res.text);
    // Explicit referral — not silently ignored
    assert.equal(res.json.status, 'rights_review');
    assert.deepEqual(res.json.flags.unsupported_clauses,
      ['in_perpetuity_all_media', 'irrevocable_worldwide_sublicense']);
    const listed = await w.call('officer', 'GET', '/intents');
    const mine = listed.json.find((i: any) => i.id === res.json.id);
    assert.equal(mine.status, 'rights_review');
  } finally { w.cleanup(); }
});

test('intent validation: expired/withdrawn offers and cross-tenant reads rejected', async () => {
  const w = await makeWorld();
  try {
    const { offerId } = await seededCatalog(w);

    const expired = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: 'off_missing',
    });
    assert.equal(expired.status, 404);

    // editor in the SAME newsroom can read; a different tenant cannot.
    const res = await w.call('editor', 'POST', '/publication-intents', {
      ...INDIA_INTENT, offer_id: offerId,
    });
    const mk = () => {
      w.db.prepare(`INSERT INTO orgs (id, kind, name, created_at) VALUES ('org_other','newsroom','Other Wire',?)`)
        .run(new Date().toISOString());
      w.db.prepare(`INSERT INTO users (id, org_id, display_name, role, created_at) VALUES ('usr_other','org_other','O','editor',?)`)
        .run(new Date().toISOString());
    };
    mk();
    const { createSession } = await import('../src/api/auth.ts');
    const t = createSession(w.db, 'usr_other');
    const r = await fetch(`${w.base}/intents/${res.json.id}`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal(r.status, 403);
  } finally { w.cleanup(); }
});
