import { canonicalJson } from './canon.ts';
import { signBytes, verifyBytes } from './keys.ts';
import type { GrantPayloadV1 } from './types.ts';
import { GRANT_SCHEMA } from './policy.ts';
import { now, one, type Db } from '../db/store.ts';
import type { SellerKeyRow } from './types.ts';

export function canonicalGrantPayload(p: GrantPayloadV1): string {
  return canonicalJson(p);
}

export function signGrantPayload(privateKeyPem: string, p: GrantPayloadV1): string {
  return signBytes(privateKeyPem, canonicalGrantPayload(p));
}

// Verify a grant signature against the seller key version recorded in the
// registry (retired keys still verify — INV-07 historical verification).
export function verifyGrantSignature(
  db: Db, sellerId: string, keyVersion: number, payload: GrantPayloadV1, signature: string,
): { valid: boolean; reason?: string } {
  const key = one<SellerKeyRow>(db,
    'SELECT * FROM seller_keys WHERE seller_id=? AND key_version=?', sellerId, keyVersion);
  if (!key) return { valid: false, reason: 'key_version_unknown' };
  if (!verifyBytes(key.public_key_pem, canonicalGrantPayload(payload), signature)) {
    return { valid: false, reason: 'signature_invalid' };
  }
  return { valid: true };
}

export interface GrantEventPayload {
  schema: 'rightsdesk.grant-event.v1';
  seller_id: string;
  grant_id: string;
  seq: number;
  kind: 'revoked' | 'reinstated' | 'expired';
  new_status: 'revoked' | 'active' | 'expired';
  issued_at: string;
}

export function buildGrantEvent(
  sellerId: string, grantId: string, seq: number,
  kind: GrantEventPayload['kind'], newStatus: GrantEventPayload['new_status'],
): GrantEventPayload {
  return { schema: 'rightsdesk.grant-event.v1', seller_id: sellerId, grant_id: grantId, seq, kind, new_status: newStatus, issued_at: now() };
}

export function signGrantEvent(privateKeyPem: string, e: GrantEventPayload): string {
  return signBytes(privateKeyPem, canonicalJson(e));
}

export function verifyGrantEventSignature(
  db: Db, e: GrantEventPayload, signature: string, keyVersion: number,
): { valid: boolean; reason?: string } {
  const key = one<SellerKeyRow>(db,
    'SELECT * FROM seller_keys WHERE seller_id=? AND key_version=?', e.seller_id, keyVersion);
  if (!key) return { valid: false, reason: 'key_version_unknown' };
  if (!verifyBytes(key.public_key_pem, canonicalJson(e), signature)) {
    return { valid: false, reason: 'signature_invalid' };
  }
  return { valid: true };
}

export { GRANT_SCHEMA };
