import { now, one, type Db } from './db/store.ts';
import { generateEd25519 } from './domain/keys.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Deterministic seed: one platform org, one seller org (Meridian Charts),
// one newsroom org (The Chronicle) with the five newsroom/seller roles.
export interface SeedResult {
  sellerId: string;
  sellerKeyVersion: number;
  users: Record<string, string>;
}

export function seed(db: Db, keyDir?: string): SeedResult {
  if (one(db, 'SELECT id FROM orgs WHERE id = ?', 'org_platform')) {
    return existingSeed(db);
  }
  const t = now();
  const insOrg = db.prepare('INSERT INTO orgs (id, kind, name, created_at) VALUES (?,?,?,?)');
  insOrg.run('org_platform', 'platform', 'RightsDesk Ops', t);
  insOrg.run('org_seller', 'seller', 'Meridian Charts', t);
  insOrg.run('org_newsroom', 'newsroom', 'The Chronicle', t);

  const insUser = db.prepare('INSERT INTO users (id, org_id, display_name, role, created_at) VALUES (?,?,?,?,?)');
  insUser.run('usr_operator', 'org_platform', 'Ops Verifier', 'operator', t);
  insUser.run('usr_seller', 'org_seller', 'Riya Seller', 'seller_agent', t);
  insUser.run('usr_editor', 'org_newsroom', 'Eddie Editor', 'editor', t);
  insUser.run('usr_budget', 'org_newsroom', 'Bea Budget', 'budget_holder', t);
  insUser.run('usr_officer', 'org_newsroom', 'Ravi Rights', 'rights_officer', t);
  insUser.run('usr_publisher', 'org_newsroom', 'Pia Publisher', 'publisher', t);

  db.prepare(`INSERT INTO sellers (id, org_id, agreement_ref, status, created_at)
    VALUES ('sel_meridian', 'org_seller', 'AGR-2026-001', 'pending_review', ?)`).run(t);

  // Issuer key custody: private key goes to the issuer key dir (seller-side
  // service); only the public key is recorded in the registry.
  const kp = generateEd25519();
  if (keyDir) {
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, 'sel_meridian_v1.pem'), kp.privateKeyPem, { mode: 0o600 });
  }
  db.prepare(`INSERT INTO seller_keys (seller_id, key_version, public_key_pem, status, created_at)
    VALUES ('sel_meridian', 1, ?, 'active', ?)`).run(kp.publicKeyPem, t);

  return { sellerId: 'sel_meridian', sellerKeyVersion: 1, users: seedUsers() };
}

function seedUsers() {
  return {
    operator: 'usr_operator', seller: 'usr_seller', editor: 'usr_editor',
    budget: 'usr_budget', officer: 'usr_officer', publisher: 'usr_publisher',
  };
}

function existingSeed(db: Db): SeedResult {
  const k = one<{ key_version: number }>(
    db, `SELECT key_version FROM seller_keys WHERE seller_id='sel_meridian' ORDER BY key_version`);
  return { sellerId: 'sel_meridian', sellerKeyVersion: k?.key_version ?? 1, users: seedUsers() };
}
