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
