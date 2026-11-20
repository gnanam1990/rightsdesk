import { canonicalJson, hashCanonical } from '../domain/canon.ts';
import { now, one, type Db } from '../db/store.ts';
import { ApiError, type Ctx } from './http.ts';

// Durable idempotency: identical retry returns the stored operation reference;
// same key with a different payload conflicts.
export function idempotent<T>(db: Db, ctx: Ctx, endpoint: string, fn: () => T): { value: T; replayed: boolean } {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const key = (ctx.req.headers['x-idempotency-key'] as string | undefined)
    ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined);
  if (!key) return { value: fn(), replayed: false };
  if (key.length > 200) throw new ApiError(400, 'validation', 'idempotency key too long');

  const requestHash = hashCanonical(body);
  const existing = one<{ request_hash: string; response_json: string; actor_id: string }>(
    db, 'SELECT request_hash, response_json, actor_id FROM idempotency_keys WHERE key = ? AND endpoint = ?',
    key, endpoint);
  if (existing) {
    if (existing.request_hash !== requestHash || existing.actor_id !== ctx.user?.id) {
      throw new ApiError(409, 'idempotency_conflict',
        'idempotency key already used with a different payload or actor');
    }
    return { value: JSON.parse(existing.response_json) as T, replayed: true };
  }
  const value = fn();
  db.prepare(`INSERT INTO idempotency_keys (key, endpoint, actor_id, request_hash, response_json, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(key, endpoint, ctx.user?.id ?? 'anonymous', requestHash, canonicalJson(value), now());
  return { value, replayed: false };
}
