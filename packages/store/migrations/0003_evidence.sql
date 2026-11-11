-- 0003 evidence, inspection and holds (M03).
-- Evidence items, manifest revisions, attestations, inspections and hold records are
-- append-only: corrections are new rows (a new item version, a new manifest revision, a
-- resolution row), never in-place edits. Triggers enforce this at the database layer.

CREATE TABLE evidence_policies (
  policy_id      TEXT    NOT NULL,
  revision       INTEGER NOT NULL,
  digest         TEXT    NOT NULL,
  policy_json    TEXT    NOT NULL,
  registered_at  INTEGER NOT NULL,
  PRIMARY KEY (policy_id, revision)
) STRICT;

CREATE TABLE evidence_trades (
  trade_id         TEXT    PRIMARY KEY,
  trade_revision   INTEGER NOT NULL,
  terms_digest     TEXT    NOT NULL,
  terms_json       TEXT    NOT NULL,
  policy_id        TEXT    NOT NULL,
  policy_revision  INTEGER NOT NULL,
  bound_at         INTEGER NOT NULL,
  FOREIGN KEY (policy_id, policy_revision) REFERENCES evidence_policies (policy_id, revision)
) STRICT;

CREATE TABLE evidence_items (
  item_id              TEXT    PRIMARY KEY,
  trade_id             TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  slot_id              TEXT    NOT NULL,
  version              INTEGER NOT NULL,
  predecessor_item_id  TEXT    REFERENCES evidence_items (item_id),
  original_digest      TEXT    NOT NULL,
  byte_length          INTEGER NOT NULL,
  declared_mime        TEXT,
  detected_mime        TEXT    NOT NULL,
  content_class        TEXT    NOT NULL,
  issued_at            INTEGER NOT NULL,
  fresh_until          INTEGER NOT NULL,
  uploader_principal_id TEXT   NOT NULL,
  facts_json           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX evidence_items_one_successor ON evidence_items (predecessor_item_id)
  WHERE predecessor_item_id IS NOT NULL;
CREATE INDEX evidence_items_trade ON evidence_items (trade_id, slot_id);

CREATE TABLE evidence_manifests (
  trade_id            TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  revision            INTEGER NOT NULL CHECK (revision >= 1),
  digest              TEXT    NOT NULL,
  slots_json          TEXT    NOT NULL,
  change_kind         TEXT    NOT NULL CHECK (change_kind IN ('ADD', 'REPLACE', 'REMOVE')),
  slot_id             TEXT    NOT NULL,
  item_id             TEXT    NOT NULL REFERENCES evidence_items (item_id),
  actor_principal_id  TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (trade_id, revision)
) STRICT;

CREATE TABLE evidence_quarantine (
  id                  TEXT    PRIMARY KEY,
  trade_id            TEXT    NOT NULL,
  slot_id             TEXT    NOT NULL,
  reason              TEXT    NOT NULL,
  detail              TEXT    NOT NULL,
  original_digest     TEXT,
  observed_bytes      INTEGER NOT NULL,
  actor_principal_id  TEXT    NOT NULL,
  created_at          INTEGER NOT NULL
) STRICT;

CREATE TABLE manifest_attestations (
  id                 TEXT    PRIMARY KEY,
  trade_id           TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  manifest_revision  INTEGER NOT NULL,
  manifest_digest    TEXT    NOT NULL,
  digest             TEXT    NOT NULL UNIQUE,
  payload_json       TEXT    NOT NULL,
  signature          TEXT    NOT NULL,
  key_version_id     TEXT    NOT NULL,
  issued_at          INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  recorded_at        INTEGER NOT NULL,
  FOREIGN KEY (trade_id, manifest_revision) REFERENCES evidence_manifests (trade_id, revision)
) STRICT;

CREATE TABLE inspection_attestations (
  id                 TEXT    PRIMARY KEY,
  trade_id           TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  attestation_id     TEXT    NOT NULL REFERENCES manifest_attestations (id),
  manifest_revision  INTEGER NOT NULL,
  manifest_digest    TEXT    NOT NULL,
  decision           TEXT    NOT NULL CHECK (decision IN ('PASS', 'FAIL', 'REVIEW')),
  reason_codes_json  TEXT    NOT NULL,
  digest             TEXT    NOT NULL UNIQUE,
  payload_json       TEXT    NOT NULL,
  signature          TEXT    NOT NULL,
  issued_at          INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  recorded_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE hold_records (
  id               TEXT    PRIMARY KEY,
  trade_id         TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  reason_code      TEXT    NOT NULL,
  issuer_role      TEXT    NOT NULL CHECK (issuer_role IN ('POLICY_SETTER', 'RISK_RESOLVER')),
  rule_id          TEXT,
  manifest_digest  TEXT,
  issued_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  set_digest       TEXT    NOT NULL UNIQUE,
  payload_json     TEXT    NOT NULL,
  signature        TEXT    NOT NULL,
  recorded_at      INTEGER NOT NULL,
  CHECK (issuer_role <> 'POLICY_SETTER' OR rule_id IS NOT NULL)
) STRICT;

-- At most one resolution per hold; only the risk/policy principal resolves.
CREATE TABLE hold_resolutions (
  hold_id          TEXT    PRIMARY KEY REFERENCES hold_records (id),
  resolver_role    TEXT    NOT NULL CHECK (resolver_role = 'RISK_RESOLVER'),
  resolution_code  TEXT    NOT NULL,
  evidence_digest  TEXT    NOT NULL,
  digest           TEXT    NOT NULL UNIQUE,
  payload_json     TEXT    NOT NULL,
  signature        TEXT    NOT NULL,
  resolved_at      INTEGER NOT NULL
) STRICT;

-- A buyer may ask for review; a request carries no authority over the hold.
CREATE TABLE hold_resolution_requests (
  id                    TEXT    PRIMARY KEY,
  hold_id               TEXT    NOT NULL REFERENCES hold_records (id),
  requested_by          TEXT    NOT NULL,
  note                  TEXT    NOT NULL,
  created_at            INTEGER NOT NULL
) STRICT;

-- Model review output. It is advisory by construction: no column links it to a hold,
-- an attestation or a signature, and the authority column can only say ADVISORY_ONLY.
CREATE TABLE advisory_findings (
  id                   TEXT    PRIMARY KEY,
  trade_id             TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  manifest_revision    INTEGER NOT NULL,
  source               TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('RECORDED', 'MALFORMED', 'TIMEOUT', 'FAILED')),
  suggestion           TEXT,
  confidence_permille  INTEGER,
  summary              TEXT,
  raw_digest           TEXT,
  authority            TEXT    NOT NULL CHECK (authority = 'ADVISORY_ONLY'),
  created_at           INTEGER NOT NULL
) STRICT;

CREATE TRIGGER evidence_policies_no_update BEFORE UPDATE ON evidence_policies
BEGIN SELECT RAISE(ABORT, 'evidence_policies is append-only'); END;
CREATE TRIGGER evidence_policies_no_delete BEFORE DELETE ON evidence_policies
BEGIN SELECT RAISE(ABORT, 'evidence_policies is append-only'); END;
CREATE TRIGGER evidence_trades_no_update BEFORE UPDATE ON evidence_trades
BEGIN SELECT RAISE(ABORT, 'evidence_trades is append-only'); END;
CREATE TRIGGER evidence_trades_no_delete BEFORE DELETE ON evidence_trades
BEGIN SELECT RAISE(ABORT, 'evidence_trades is append-only'); END;
CREATE TRIGGER evidence_items_no_update BEFORE UPDATE ON evidence_items
BEGIN SELECT RAISE(ABORT, 'evidence_items is append-only'); END;
CREATE TRIGGER evidence_items_no_delete BEFORE DELETE ON evidence_items
BEGIN SELECT RAISE(ABORT, 'evidence_items is append-only'); END;
CREATE TRIGGER evidence_manifests_no_update BEFORE UPDATE ON evidence_manifests
BEGIN SELECT RAISE(ABORT, 'evidence_manifests is append-only'); END;
CREATE TRIGGER evidence_manifests_no_delete BEFORE DELETE ON evidence_manifests
BEGIN SELECT RAISE(ABORT, 'evidence_manifests is append-only'); END;
CREATE TRIGGER evidence_quarantine_no_update BEFORE UPDATE ON evidence_quarantine
BEGIN SELECT RAISE(ABORT, 'evidence_quarantine is append-only'); END;
CREATE TRIGGER evidence_quarantine_no_delete BEFORE DELETE ON evidence_quarantine
BEGIN SELECT RAISE(ABORT, 'evidence_quarantine is append-only'); END;
CREATE TRIGGER manifest_attestations_no_update BEFORE UPDATE ON manifest_attestations
BEGIN SELECT RAISE(ABORT, 'manifest_attestations is append-only'); END;
CREATE TRIGGER manifest_attestations_no_delete BEFORE DELETE ON manifest_attestations
BEGIN SELECT RAISE(ABORT, 'manifest_attestations is append-only'); END;
CREATE TRIGGER inspection_attestations_no_update BEFORE UPDATE ON inspection_attestations
BEGIN SELECT RAISE(ABORT, 'inspection_attestations is append-only'); END;
CREATE TRIGGER inspection_attestations_no_delete BEFORE DELETE ON inspection_attestations
BEGIN SELECT RAISE(ABORT, 'inspection_attestations is append-only'); END;
CREATE TRIGGER hold_records_no_update BEFORE UPDATE ON hold_records
BEGIN SELECT RAISE(ABORT, 'hold_records is append-only'); END;
CREATE TRIGGER hold_records_no_delete BEFORE DELETE ON hold_records
BEGIN SELECT RAISE(ABORT, 'hold_records is append-only'); END;
CREATE TRIGGER hold_resolutions_no_update BEFORE UPDATE ON hold_resolutions
BEGIN SELECT RAISE(ABORT, 'hold_resolutions is append-only'); END;
CREATE TRIGGER hold_resolutions_no_delete BEFORE DELETE ON hold_resolutions
BEGIN SELECT RAISE(ABORT, 'hold_resolutions is append-only'); END;
CREATE TRIGGER advisory_findings_no_update BEFORE UPDATE ON advisory_findings
BEGIN SELECT RAISE(ABORT, 'advisory_findings is append-only'); END;
CREATE TRIGGER advisory_findings_no_delete BEFORE DELETE ON advisory_findings
BEGIN SELECT RAISE(ABORT, 'advisory_findings is append-only'); END;
