import { randomBytes } from 'node:crypto';

export function rid(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function token(): string {
  return randomBytes(24).toString('base64url');
}
