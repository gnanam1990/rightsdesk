import { generateKeyPairSync, sign, verify } from 'node:crypto';

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// Sign raw bytes (callers pass canonical payload bytes) -> base64url signature.
export function signBytes(privateKeyPem: string, data: string | Buffer): string {
  return sign(null, Buffer.from(data), privateKeyPem).toString('base64url');
}

export function verifyBytes(publicKeyPem: string, data: string | Buffer, signatureB64: string): boolean {
  try {
    return verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signatureB64, 'base64url'));
  } catch {
    return false;
  }
}

// Short fingerprint for display/evidence (not a security boundary).
export function keyFingerprint(publicKeyPem: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
}
