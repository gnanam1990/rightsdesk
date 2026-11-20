import { now, one, tx, type Db } from './db/store.ts';
import type { OrderRow, OutboxRow } from './domain/types.ts';
import { all } from './db/store.ts';
import { audit } from './api/auth.ts';
import type { CheckoutProvider } from './providers/checkout.ts';
import type { LocalIssuerService } from './providers/issuer.ts';
import { enqueue } from './api/routes/orders-grants.ts';

export interface WorkerDeps {
  db: Db;
  issuer?: LocalIssuerService;
  checkout?: CheckoutProvider;
}

const MAX_ATTEMPTS = 50;
const backoffMs = (attempts: number) => Math.min(attempts * 5000, 60_000);

// One worker pass over due outbox rows. Tests call this directly; the worker
// binary loops it. Every handler is restart-safe: the domain write and its
// outbox state live in the same store.
export async function tick(deps: WorkerDeps): Promise<{ processed: number; errors: number }> {
  const due = all<OutboxRow>(deps.db,
    `SELECT * FROM outbox WHERE status='pending' AND next_attempt_at <= ? ORDER BY id`, now());
  let errors = 0;
  for (const row of due) {
    try {
      await processOne(deps, row);
    } catch (e) {
      errors++;
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      deps.db.prepare(`UPDATE outbox SET attempts=?, status=?, last_error=?, next_attempt_at=? WHERE id=?`)
        .run(attempts, failed ? 'failed' : 'pending', String(e),
          new Date(Date.now() + backoffMs(attempts)).toISOString(), row.id);
    }
  }
  return { processed: due.length, errors };
}

function markDone(db: Db, id: number) {
  db.prepare(`UPDATE outbox SET status='done', processed_at=? WHERE id=?`).run(now(), id);
}

function retry(db: Db, row: OutboxRow, note: string) {
  const attempts = row.attempts + 1;
  db.prepare(`UPDATE outbox SET attempts=?, last_error=?, next_attempt_at=? WHERE id=?`)
    .run(attempts, note, new Date(Date.now() + backoffMs(attempts)).toISOString(), row.id);
}

async function processOne(deps: WorkerDeps, row: OutboxRow): Promise<void> {
  const payload = JSON.parse(row.payload) as Record<string, string>;
  switch (row.kind) {
    case 'order.settled': {
      if (!deps.issuer) return retry(deps.db, row, 'issuer not configured');
      const res = deps.issuer.issueGrant(payload.order_id!, 'system:worker');
      if (res.status === 'unavailable') return retry(deps.db, row, res.reason);
      if (res.status === 'rejected') {
        // Permanent rejection — keep the row for reconciliation, stop dispatch.
        return retry(deps.db, row, `rejected: ${res.reason}`);
      }
      return markDone(deps.db, row.id);
    }
    case 'payment.inspect': {
      const order = one<OrderRow>(deps.db, 'SELECT * FROM orders WHERE id=?', payload.order_id!);
      if (!order || !order.payment_ref) return markDone(deps.db, row.id);
      if (!deps.checkout) return retry(deps.db, row, 'checkout not configured');
      const { status } = await deps.checkout.inspect(order.payment_ref);
      if (status === 'settled') {
        tx(deps.db, () => {
          deps.db.prepare(`UPDATE orders SET payment_status='settled', status='paid_awaiting_grant' WHERE id=?`)
            .run(order.id);
          deps.db.prepare(`UPDATE intents SET status='paid_awaiting_grant' WHERE id=?`).run(order.intent_id);
          enqueue(deps.db, 'order.settled', { order_id: order.id });
          audit(deps.db, 'system:worker', 'payment.settled', {
            subjectKind: 'order', subjectId: order.id, externalRef: order.payment_ref ?? undefined,
          });
        });
        return markDone(deps.db, row.id);
      }
      if (status === 'failed') {
        tx(deps.db, () => {
          deps.db.prepare(`UPDATE orders SET payment_status='failed', status='cancelled' WHERE id=?`).run(order.id);
          deps.db.prepare(`UPDATE intents SET status='specified' WHERE id=?`).run(order.intent_id);
        });
        return markDone(deps.db, row.id);
      }
      if (status === 'unknown') {
        deps.db.prepare(`UPDATE orders SET status='payment_unknown' WHERE id=? AND status='checkout_pending'`)
          .run(order.id);
      }
      return retry(deps.db, row, `settlement status: ${status}`);
    }
    case 'grant.expiry_scan':
      return scanExpiries(deps.db);
    default:
      return markDone(deps.db, row.id);
  }
}

// Expire grants whose validity window has closed; records a system event so
// the ordered event log stays the single source of status transitions.
function scanExpiries(db: Db) {
  const expired = all<{ id: string; seller_id: string; status_seq: number }>(db,
    `SELECT id, seller_id, status_seq FROM grants WHERE status='active' AND valid_until <= ?`, now());
  for (const g of expired) {
    tx(db, () => {
      const seq = g.status_seq + 1;
      db.prepare(`INSERT INTO grant_events (id, seller_id, grant_id, seq, kind, new_status, signature, key_version, actor, received_at)
        VALUES (?,?,?,?, 'expired','expired','system',0,'system:expiry',?)`)
        .run(`gev_sys_${g.id}_${seq}`, g.seller_id, g.id, seq, now());
      db.prepare(`UPDATE grants SET status='expired', status_seq=? WHERE id=?`).run(seq, g.id);
      audit(db, 'system:expiry', 'grant.expired', { subjectKind: 'grant', subjectId: g.id });
    });
  }
}

export function scheduleExpiryScan(db: Db) {
  enqueue(db, 'grant.expiry_scan', {});
}
