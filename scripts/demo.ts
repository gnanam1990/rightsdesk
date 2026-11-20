// Acceptance rehearsal: full product journey against a real server + worker,
// evidence written to build-progress/rightsdesk/evidence/. Local-only —
// checkout is the local emulator, issuance is the local issuer service.
// Run: node --experimental-strip-types scripts/demo.ts
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/store.ts';
import { seed } from '../src/seed.ts';
import { buildApp } from '../src/api/app.ts';
import { createSession } from '../src/api/auth.ts';
import { LocalIssuerService } from '../src/providers/issuer.ts';
import { LocalCheckoutEmulator } from '../src/providers/checkout.ts';
import { tick } from '../src/worker.ts';
import { one } from '../src/db/store.ts';

const OUT = join(process.cwd(), 'build-progress', 'rightsdesk', 'evidence');
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(OUT, 'run-'));
const db = openDb(join(dir, 'rightsdesk.db'));
const keyDir = join(dir, 'issuer-keys');
seed(db, keyDir);
const issuer = new LocalIssuerService(db, keyDir);
const checkout = new LocalCheckoutEmulator();
const app = buildApp({ db, keyDir, issuer, checkout });
const server = createServer(app.handle);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const tokens: Record<string, string> = {
  operator: createSession(db, 'usr_operator'), seller: createSession(db, 'usr_seller'),
  editor: createSession(db, 'usr_editor'), budget: createSession(db, 'usr_budget'),
  officer: createSession(db, 'usr_officer'), publisher: createSession(db, 'usr_publisher'),
};
const steps: { step: string; status: number; summary: unknown }[] = [];
async function call(role: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${tokens[role]}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
async function step(name: string, fn: () => Promise<{ status: number; json: any }>, pick: (j: any) => unknown) {
  const r = await fn();
  steps.push({ step: name, status: r.status, summary: pick(r.json) });
  if (r.status >= 400) console.error(`FAIL ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

const H = (c: string) => c.repeat(64);
const TERMS = {
  edition_set: ['IN'], channel_set: ['web'], territory_set: ['IN'],
  purposes: ['editorial'], attribution: 'Chart: Meridian Charts for The Chronicle',
  valid_from: '2030-01-01T00:00:00.000Z', valid_until: '2030-02-01T00:00:00.000Z',
  clauses: { credit_required: true, sublicensing: false, revocable: true },
};

// 1 · registry
await step('verify seller', () => call('operator', 'POST', '/sellers/sel_meridian/verify', {}), j => j.status);
const a1 = await step('asset rev1', () => call('seller', 'POST', '/sellers/sel_meridian/assets', {
  title: 'Chart A', revision: 1, content_sha256: H('d') }), j => j.asset?.id);
const assetId = a1.json.asset.id;
await step('asset rev2', () => call('seller', 'POST', '/sellers/sel_meridian/assets', {
  asset_id: assetId, revision: 2, content_sha256: H('c'), predecessor_sha256: H('d') }), j => j.revision);
await step('asset rev3 (H3)', () => call('seller', 'POST', '/sellers/sel_meridian/assets', {
  asset_id: assetId, revision: 3, content_sha256: H('a'), predecessor_sha256: H('c') }), j => j.revision);

// 2 · offer
const offer = await step('publish offer', () => call('seller', 'POST', `/assets/${assetId}/offers`, {
  asset_revision: 3, terms_text: 'Meridian Charts standard chart license, schedule 1.',
  terms_schema: TERMS, price_atomic: 12500, asset_symbol: 'USDC', rail: 'local-emulator',
  expires_at: '2031-01-01T00:00:00.000Z' }), j => ({ id: j.id, terms: j.terms_sha256?.slice(0, 16) }));
const offerId = offer.json.id;

// 3 · India intent + purchase
const intent = await step('india intent', () => call('editor', 'POST', '/publication-intents', {
  offer_id: offerId, publication_id: 'pub_jan20_in', edition: 'IN', channel: 'web',
  territory_set: ['IN'], purpose: 'editorial', attribution_text: TERMS.attribution,
  control_evidence_ref: 'controls://edition-routing/in-only',
  control_evidence_digest: H('e'), intended_at: '2030-01-20T12:00:00.000Z' }), j => j.id);
const intentId = intent.json.id;
const order = await step('order', () => call('budget', 'POST', `/offers/${offerId}/orders`, {
  intent_id: intentId, price_cap_atomic: 50000 }), j => j.order?.status);
const orderId = order.json.order.id;
await tick({ db, issuer, checkout });
const licensed = await step('grant issued', () => call('budget', 'GET', `/orders/${orderId}`),
  j => ({ status: j.status, grant: j.grant?.id }));

// 4 · allow decision + release
await step('evaluate IN web editorial', () => call('publisher', 'POST', `/intents/${intentId}/evaluate`, {
  artifact_hash: H('f') }), j => j.evaluation?.result);
const pub = await step('register release', () => call('publisher', 'POST', '/publications', {
  intent_id: intentId, artifact_hash: H('f') }), j => j.id);
const conf = await step('release gate', () => call('publisher', 'POST',
  `/publications/${pub.json.id}/confirm`, { artifact_hash: H('f') }),
  j => ({ status: j.status, receipt: j.receipt?.id }));
const replay = await step('release gate replay', () => call('publisher', 'POST',
  `/publications/${pub.json.id}/confirm`, { artifact_hash: H('f') }),
  j => ({ status: j.status, replayed: j.replayed }));

// 5 · global republication denied
const gIntent = await step('global intent', () => call('editor', 'POST', '/publication-intents', {
  offer_id: offerId, publication_id: 'pub_global', edition: 'GLOBAL', channel: 'web',
  territory_set: ['GLOBAL'], purpose: 'editorial', attribution_text: TERMS.attribution,
  control_evidence_ref: 'controls://edition-routing/global',
  control_evidence_digest: H('9'), intended_at: '2030-01-25T12:00:00.000Z' }), j => j.id);
await step('global order+grant', async () => {
  const o: { status: number; json: any } = await call('budget', 'POST', `/offers/${offerId}/orders`, {
    intent_id: gIntent.json.id, price_cap_atomic: 50000 });
  await tick({ db, issuer, checkout });
  return call('budget', 'GET', `/orders/${o.json.order.id}`);
}, j => j.status);
const gEval = await step('evaluate GLOBAL', () => call('publisher', 'POST',
  `/intents/${gIntent.json.id}/evaluate`, { artifact_hash: H('f') }), j => j.evaluation?.result);

// 6 · missing controls → review_required
const rIntent = await step('intent w/o controls', () => call('editor', 'POST', '/publication-intents', {
  offer_id: offerId, publication_id: 'pub_noctl', edition: 'IN', channel: 'web',
  territory_set: ['IN'], purpose: 'editorial', attribution_text: TERMS.attribution,
  intended_at: '2030-01-21T12:00:00.000Z' }), j => j.id);
await call('budget', 'POST', `/offers/${offerId}/orders`, { intent_id: rIntent.json.id, price_cap_atomic: 50000 });
await tick({ db, issuer, checkout });
await step('evaluate missing controls', () => call('publisher', 'POST',
  `/intents/${rIntent.json.id}/evaluate`, { artifact_hash: H('f') }), j => j.evaluation?.result);

// 7 · decision packet export
const pkt = await step('case export', () => call('officer', 'GET', `/cases/${intentId}/export`),
  j => ({ hash: j.packet_hash?.slice(0, 16), grants: j.grants?.length, decisions: j.decisions?.length }));
writeFileSync(join(OUT, 'decision-packet.json'), JSON.stringify(pkt.json, null, 2));

// 8 · expiry boundary: exact valid_until cannot authorize
const grantRow = one<any>(db, 'SELECT * FROM grants WHERE order_id=?', orderId)!;
const expIntent = await step('intent at exact expiry', () => call('editor', 'POST', '/publication-intents', {
  offer_id: offerId, publication_id: 'pub_exp', edition: 'IN', channel: 'web',
  territory_set: ['IN'], purpose: 'editorial', attribution_text: TERMS.attribution,
  control_evidence_ref: 'controls://edition-routing/in-only', control_evidence_digest: H('e'),
  intended_at: grantRow.valid_until }), j => j.id);
await call('budget', 'POST', `/offers/${offerId}/orders`, { intent_id: expIntent.json.id, price_cap_atomic: 50000 });
await tick({ db, issuer, checkout });
await step('evaluate at valid_until (exclusive)', () => call('publisher', 'POST',
  `/intents/${expIntent.json.id}/evaluate`, { artifact_hash: H('f') }), j => j.evaluation?.result);

writeFileSync(join(OUT, 'demo-steps.json'), JSON.stringify(steps, null, 2));
server.close(); db.close();
const fails = steps.filter(s => s.status >= 400);
console.log(`\n${steps.length} steps · ${fails.length} errors · dir ${dir}`);
console.table(steps.map(s => ({ step: s.step, status: s.status, summary: JSON.stringify(s.summary)?.slice(0, 60) })));
process.exit(fails.length ? 1 : 0);
