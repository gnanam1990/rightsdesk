import { createServer, type Server } from 'node:http';
import { openDb, type Db } from '../src/db/store.ts';
import { seed } from '../src/seed.ts';
import { buildApp } from '../src/api/app.ts';
import { createSession } from '../src/api/auth.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Sandbox-friendly temp root inside the workspace checkout.
const TMP_ROOT = join(process.cwd(), 'data', 'test-tmp');

export interface World {
  db: Db;
  server: Server;
  base: string;
  keyDir: string;
  sessions: Record<string, string>;
  cleanup: () => void;
  // Perform an HTTP call as a named seeded role.
  call: (role: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    Promise<{ status: number; json: any; text: string }>;
}

export function makeWorld(opts: { memoryDb?: boolean } = {}): Promise<World> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'rightsdesk-test-'));
  const keyDir = join(dir, 'issuer-keys');
  const dbPath = opts.memoryDb === false ? join(dir, 'rightsdesk.db') : ':memory:';
  const db = openDb(dbPath);
  seed(db, keyDir);
  const app = buildApp({ db, keyDir });
  const server = createServer(app.handle);
  return new Promise<World>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const sessions: Record<string, string> = {
        operator: createSession(db, 'usr_operator'),
        seller: createSession(db, 'usr_seller'),
        editor: createSession(db, 'usr_editor'),
        budget: createSession(db, 'usr_budget'),
        officer: createSession(db, 'usr_officer'),
        publisher: createSession(db, 'usr_publisher'),
      };
      const call: World['call'] = async (role, method, path, body, headers = {}) => {
        const h: Record<string, string> = { ...headers };
        if (role) h.authorization = `Bearer ${sessions[role]}`;
        if (body !== undefined) {
          h['content-type'] = 'application/json';
        }
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* html or empty */ }
        return { status: res.status, json, text };
      };
      resolve({
        db, server, base: `http://127.0.0.1:${port}`, keyDir, sessions, call,
        cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
      });
    });
  });
}

// Convenience: verify the seeded seller (operator action) and return it.
export async function verifySeller(w: World) {
  const r = await w.call('operator', 'POST', '/sellers/sel_meridian/verify', {});
  if (r.status !== 200) throw new Error(`verifySeller failed: ${r.status} ${r.text}`);
  return r.json;
}

export const H3 = 'a'.repeat(64); // deterministic fixture hash for Asset A rev 3
export const H4 = 'b'.repeat(64);
export const H2 = 'c'.repeat(64);
export const H1 = 'd'.repeat(64);

export const TERMS_TEXT = 'Meridian Charts standard chart license, schedule 1 (reference terms).';
export const TERMS_SCHEMA = {
  edition_set: ['IN'],
  channel_set: ['web'],
  territory_set: ['IN'],
  purposes: ['editorial'],
  attribution: 'Chart: Meridian Charts for The Chronicle',
  valid_from: '2030-01-01T00:00:00.000Z',
  valid_until: '2030-02-01T00:00:00.000Z',
  clauses: { credit_required: true, sublicensing: false, revocable: true },
};

// Verified seller + chained revisions 1-3 (H3 at rev 3) + published offer.
export async function seededCatalog(w: World, termsSchema: Record<string, unknown> = TERMS_SCHEMA) {
  await verifySeller(w);
  const r1 = await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
    title: 'Chart A', revision: 1, content_sha256: H1,
  });
  const assetId = r1.json.asset.id as string;
  await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
    asset_id: assetId, revision: 2, content_sha256: H2, predecessor_sha256: H1,
  });
  await w.call('seller', 'POST', '/sellers/sel_meridian/assets', {
    asset_id: assetId, revision: 3, content_sha256: H3, predecessor_sha256: H2,
  });
  const offer = await w.call('seller', 'POST', `/assets/${assetId}/offers`, {
    asset_revision: 3,
    terms_text: TERMS_TEXT,
    terms_schema: termsSchema,
    price_atomic: 12500,
    asset_symbol: 'USDC',
    rail: 'local-emulator',
    expires_at: '2031-01-01T00:00:00.000Z',
  });
  if (offer.status !== 200) throw new Error(`offer failed: ${offer.status} ${offer.text}`);
  return { assetId, offerId: offer.json.id as string, termsSha256: offer.json.terms_sha256 as string };
}

export const INDIA_INTENT = {
  publication_id: 'pub_jan20_in',
  edition: 'IN',
  channel: 'web',
  territory_set: ['IN'],
  purpose: 'editorial',
  attribution_text: TERMS_SCHEMA.attribution,
  control_evidence_ref: 'controls://edition-routing/in-only',
  control_evidence_digest: 'e'.repeat(64),
  intended_at: '2030-01-20T12:00:00.000Z',
};
