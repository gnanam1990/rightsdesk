import { createServer } from 'node:http';
import { openDb } from './db/store.ts';
import { seed } from './seed.ts';
import { buildApp } from './api/app.ts';

const DB_PATH = process.env.RIGHTSDESK_DB ?? 'data/rightsdesk.db';
const KEY_DIR = process.env.RIGHTSDESK_ISSUER_KEYS ?? 'data/issuer-keys';
const PORT = Number(process.env.PORT ?? 8787);

const db = openDb(DB_PATH);
seed(db, KEY_DIR);
const app = buildApp({ db, keyDir: KEY_DIR });

const server = createServer(app.handle);
server.listen(PORT, () => {
  console.log(`[rightsdesk] api listening on http://localhost:${PORT} (db=${DB_PATH})`);
});
