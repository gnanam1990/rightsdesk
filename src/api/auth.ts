import type { IncomingMessage, ServerResponse } from 'node:http';
import { token as newToken, rid } from '../domain/ids.ts';
import { now, one, type Db } from '../db/store.ts';
import type { Role, UserRow } from '../domain/types.ts';
import { forbidden, unauthorized } from './http.ts';

export const SESSION_COOKIE = 'rd_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;

export function createSession(db: Db, userId: string): string {
  const t = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(t, userId, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return t;
}

export function resolveUser(db: Db, req: IncomingMessage): UserRow | null {
  let t: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) t = auth.slice(7);
  if (!t) {
    const cookie = req.headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === SESSION_COOKIE) t = v;
    }
  }
  if (!t) return null;
  const row = one<{ user_id: string; expires_at: string }>(
    db, 'SELECT user_id, expires_at FROM sessions WHERE token = ?', t);
  if (!row || row.expires_at <= now()) return null;
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id) ?? null;
}

export function requireUser(user: UserRow | null): UserRow {
  if (!user) throw unauthorized();
  return user;
}

export function requireRole(user: UserRow | null, roles: Role[]): UserRow {
  const u = requireUser(user);
  if (!roles.includes(u.role)) {
    throw forbidden(`role ${u.role} cannot perform this action (requires ${roles.join('|')})`);
  }
  return u;
}

// The worker's internal service identity — not a DB user; used for issuer-side
// actions that run inside this process (audit trail shows system:worker).
export const SYSTEM_ACTOR = 'system:worker';

export function setSessionCookie(res: ServerResponse, token: string) {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/`);
}

export function audit(db: Db, actorId: string, action: string, opts: {
  subjectKind?: string; subjectId?: string; reasonCode?: string; externalRef?: string; latencyMs?: number;
} = {}) {
  db.prepare(`INSERT INTO audit_log (actor_id, action, subject_kind, subject_id, reason_code, external_ref, latency_ms, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(actorId, action, opts.subjectKind ?? null, opts.subjectId ?? null,
      opts.reasonCode ?? null, opts.externalRef ?? null, opts.latencyMs ?? null, now());
}

export { rid };
