// Local dev entrypoint: API + server-rendered console + outbox worker in one
// process. Checkout is the LOCAL EMULATOR (non-settling beyond the process,
// deterministic) — external providers stay disabled here regardless of env.
// Run: npm run dev   (env: PORT, RIGHTSDESK_DB, RIGHTSDESK_ISSUER_KEYS,
// WORKER_INTERVAL_MS, WORKER=0 to disable the worker)
import { createServer } from 'node:http';
import { openDb } from '../src/db/store.ts';
import { seed } from '../src/seed.ts';
import { buildApp } from '../src/api/app.ts';
import { LocalIssuerService } from '../src/providers/issuer.ts';
import { LocalCheckoutEmulator } from '../src/providers/checkout.ts';
import { scheduleExpiryScan, tick } from '../src/worker.ts';

const DB_PATH = process.env.RIGHTSDESK_DB ?? 'data/rightsdesk.db';
const KEY_DIR = process.env.RIGHTSDESK_ISSUER_KEYS ?? 'data/issuer-keys';
const PORT = Number(process.env.PORT ?? 8787);
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 2000);
const WORKER = process.env.WORKER !== '0';

const db = openDb(DB_PATH);
seed(db, KEY_DIR);
const issuer = new LocalIssuerService(db, KEY_DIR);
const checkout = new LocalCheckoutEmulator();
const app = buildApp({ db, keyDir: KEY_DIR, issuer, checkout });

const server = createServer(app.handle);

let timer: NodeJS.Timeout | undefined;
if (WORKER) {
  scheduleExpiryScan(db);
  timer = setInterval(() => {
    void tick({ db, issuer, checkout }).catch(e => console.error('[dev] tick error', e));
  }, INTERVAL_MS);
  timer.unref();
}

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`[dev] rightsdesk listening on http://localhost:${port}`);
  console.log(`[dev] console: http://localhost:${port}/login  db=${DB_PATH}`);
  console.log(`[dev] worker ${WORKER ? `every ${INTERVAL_MS}ms` : 'disabled'} · checkout=local-emulator (external providers disabled)`);
});

function shutdown(signal: string) {
  console.log(`[dev] ${signal} — shutting down`);
  if (timer) clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not hang on open keep-alive sockets.
  setTimeout(() => { db.close(); process.exit(0); }, 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
