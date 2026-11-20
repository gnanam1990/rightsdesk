import { openDb } from './db/store.ts';
import { LocalIssuerService } from './providers/issuer.ts';
import { LocalCheckoutEmulator } from './providers/checkout.ts';
import { tick } from './worker.ts';

const DB_PATH = process.env.RIGHTSDESK_DB ?? 'data/rightsdesk.db';
const KEY_DIR = process.env.RIGHTSDESK_ISSUER_KEYS ?? 'data/issuer-keys';
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 2000);

const db = openDb(DB_PATH);
const issuer = new LocalIssuerService(db, KEY_DIR);
const checkout = new LocalCheckoutEmulator();

console.log(`[rightsdesk] worker started (interval=${INTERVAL_MS}ms)`);
setInterval(() => {
  void (async () => {
    try {
      const { processed, errors } = await tick({ db, issuer, checkout });
      if (processed || errors) {
        console.log(`[rightsdesk] tick: processed=${processed} errors=${errors}`);
      }
    } catch (e) {
      console.error('tick error', e);
    }
  })();
}, INTERVAL_MS).unref();
setInterval(() => {}, 1 << 30); // keep process alive
