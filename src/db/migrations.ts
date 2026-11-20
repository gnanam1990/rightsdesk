export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('platform','seller','newsroom')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('operator','seller_agent','editor','budget_holder','rights_officer','publisher')),
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE sellers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  agreement_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_review','verified','suspended')) DEFAULT 'pending_review',
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE seller_keys (
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  key_version INTEGER NOT NULL,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','retired')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (seller_id, key_version)
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE asset_revisions (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  revision INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  predecessor_sha256 TEXT,
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, revision),
  UNIQUE (asset_id, content_sha256)
);
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  asset_revision INTEGER NOT NULL,
  seller_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  terms_text TEXT NOT NULL,
  terms_sha256 TEXT NOT NULL,
  terms_schema TEXT NOT NULL,
  price_atomic INTEGER NOT NULL,
  asset_symbol TEXT NOT NULL,
  rail TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','withdrawn')) DEFAULT 'published',
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, asset_revision, revision)
);
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  offer_id TEXT,
  offer_revision INTEGER,
  terms_sha256 TEXT,
  asset_id TEXT NOT NULL,
  asset_revision INTEGER NOT NULL,
  asset_sha256 TEXT NOT NULL,
  edition TEXT NOT NULL,
  channel TEXT NOT NULL,
  territory_set TEXT NOT NULL,
  purpose TEXT NOT NULL,
  attribution_text TEXT NOT NULL,
  control_evidence_ref TEXT,
  control_evidence_digest TEXT,
  intended_at TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'specified',
  created_at TEXT NOT NULL
);
CREATE INDEX intents_buyer ON intents(buyer_org_id, status);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  offer_revision INTEGER NOT NULL,
  buyer_org_id TEXT NOT NULL,
  intent_id TEXT,
  approved_by TEXT NOT NULL,
  price_cap_atomic INTEGER NOT NULL,
  agreed_price_atomic INTEGER NOT NULL,
  payment_ref TEXT,
  payment_status TEXT,
  checkout_provider TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK(status IN
    ('order_authorized','checkout_pending','payment_unknown','paid_awaiting_grant','grant_active','cancelled'))
    DEFAULT 'order_authorized',
  created_at TEXT NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  buyer_org_id TEXT NOT NULL,
  asset_sha256 TEXT NOT NULL,
  edition_set TEXT NOT NULL,
  channel_set TEXT NOT NULL,
  territory_set TEXT NOT NULL,
  purposes TEXT NOT NULL,
  attribution TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired','quarantined')) DEFAULT 'active',
  payload_json TEXT NOT NULL,
  signed_payload_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  issuer_key_version INTEGER NOT NULL,
  status_seq INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX grants_buyer ON grants(buyer_org_id, status);
CREATE TABLE grant_events (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  new_status TEXT,
  signature TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (grant_id, seq)
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  grant_id TEXT,
  grant_seq INTEGER,
  status_watermark INTEGER,
  policy_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('allow','deny','review_required')),
  reason_codes TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  expires_at TEXT,
  actor_id TEXT NOT NULL,
  UNIQUE (intent_id, artifact_hash, grant_id, grant_seq)
);
CREATE INDEX decisions_intent ON decisions(intent_id, evaluated_at);
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','released','blocked')) DEFAULT 'draft',
  created_at TEXT NOT NULL
);
CREATE TABLE publication_receipts (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (publication_id, artifact_hash)
);
CREATE TABLE control_declarations (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subject_kind, subject_id, version)
);
CREATE TABLE grant_quarantine (
  id TEXT PRIMARY KEY,
  grant_id TEXT,
  order_id TEXT,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX outbox_pending ON outbox(status, next_attempt_at);
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, endpoint)
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  reason_code TEXT,
  external_ref TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
`,
  },
];
