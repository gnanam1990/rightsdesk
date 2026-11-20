// Bounded input validation for untrusted HTTP payloads.
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_STRING = 8192;
const MAX_ARRAY = 256;

export function reqString(v: unknown, field: string, max = MAX_STRING): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ValidationError(`field "${field}" must be a non-empty string (<= ${max} chars)`);
  }
  return v;
}

export function optString(v: unknown, field: string, max = MAX_STRING): string | null {
  if (v === undefined || v === null) return null;
  return reqString(v, field, max);
}

export function reqStringArray(v: unknown, field: string, max = MAX_ARRAY): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) {
    throw new ValidationError(`field "${field}" must be a non-empty array (<= ${max})`);
  }
  for (const item of v) reqString(item, field, 256);
  return v as string[];
}

export function reqInt(v: unknown, field: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ValidationError(`field "${field}" must be an integer in [${min}, ${max}]`);
  }
  return v;
}

export function reqIso(v: unknown, field: string): string {
  const s = reqString(v, field, 64);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ValidationError(`field "${field}" must be an ISO-8601 timestamp`);
  return new Date(t).toISOString();
}

export function reqObject(v: unknown, field: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ValidationError(`field "${field}" must be an object`);
  }
  return v as Record<string, unknown>;
}

export function reqSha256(v: unknown, field: string): string {
  const s = reqString(v, field, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new ValidationError(`field "${field}" must be a sha256 hex digest`);
  return s;
}
