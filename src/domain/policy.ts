import { reqIso, reqString, reqStringArray, ValidationError } from './validate.ts';

export const POLICY_VERSION = 'rightsdesk.policy.v1';
export const TERMS_SCHEMA_VERSION = 'rightsdesk.terms.v1';
export const GRANT_SCHEMA = 'rightsdesk.grant.v1';

// Machine-readable clause vocabulary the evaluator understands. Anything else
// in terms_schema.clauses is "unsupported" and must route to a rights officer —
// never silently ignored.
export const SUPPORTED_CLAUSES = new Set([
  'sublicensing', 'archival', 'syndication', 'revocable',
  'embargo_until', 'credit_required', 'indemnity', 'audit_rights',
]);

export interface TermsSchema {
  edition_set: string[];
  channel_set: string[];
  territory_set: string[];
  purposes: string[];
  attribution: string;
  valid_from: string;
  valid_until: string;
  clauses: Record<string, unknown>;
}

// Bounded machine-readable schema: required scope sets plus optional clauses.
export function parseTermsSchema(raw: unknown): TermsSchema {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('terms_schema must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (JSON.stringify(o).length > 8192) throw new ValidationError('terms_schema exceeds 8KiB bound');
  const schema: TermsSchema = {
    edition_set: reqStringArray(o.edition_set, 'terms_schema.edition_set', 32),
    channel_set: reqStringArray(o.channel_set, 'terms_schema.channel_set', 32),
    territory_set: reqStringArray(o.territory_set, 'terms_schema.territory_set', 64),
    purposes: reqStringArray(o.purposes, 'terms_schema.purposes', 32),
    attribution: reqString(o.attribution, 'terms_schema.attribution', 512),
    valid_from: reqIso(o.valid_from, 'terms_schema.valid_from'),
    valid_until: reqIso(o.valid_until, 'terms_schema.valid_until'),
    clauses: {},
  };
  if (schema.valid_from >= schema.valid_until) {
    throw new ValidationError('terms_schema.valid_from must be before valid_until');
  }
  if (o.clauses !== undefined) {
    if (o.clauses === null || typeof o.clauses !== 'object' || Array.isArray(o.clauses)) {
      throw new ValidationError('terms_schema.clauses must be an object');
    }
    const keys = Object.keys(o.clauses as Record<string, unknown>);
    if (keys.length > 64) throw new ValidationError('terms_schema.clauses exceeds 64 keys');
    schema.clauses = o.clauses as Record<string, unknown>;
  }
  return schema;
}

export function unsupportedClauses(schema: TermsSchema | { clauses: Record<string, unknown> }): string[] {
  return Object.keys(schema.clauses).filter(k => !SUPPORTED_CLAUSES.has(k)).sort();
}
