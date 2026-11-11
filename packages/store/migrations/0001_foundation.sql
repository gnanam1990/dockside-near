-- 0001 foundation (M00): one-time nonces, idempotency records, append-only audit log.

CREATE TABLE nonces (
  scope        TEXT    NOT NULL,
  nonce        TEXT    NOT NULL,
  consumed_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (scope, nonce)
) STRICT;

CREATE TABLE idempotency_keys (
  scope           TEXT    NOT NULL,
  idem_key        TEXT    NOT NULL,
  request_digest  TEXT    NOT NULL,
  response_json   TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, idem_key)
) STRICT;

CREATE TABLE audit_events (
  seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id                   TEXT    NOT NULL UNIQUE,
  schema_version       INTEGER NOT NULL,
  event_type           TEXT    NOT NULL,
  organization_id      TEXT,
  actor_principal_id   TEXT,
  actor_key_version_id TEXT,
  session_id           TEXT,
  subject_type         TEXT    NOT NULL,
  subject_id           TEXT    NOT NULL,
  correlation_id       TEXT    NOT NULL,
  source               TEXT    NOT NULL,
  observed_at          INTEGER NOT NULL,
  recorded_at          INTEGER NOT NULL,
  payload_json         TEXT    NOT NULL,
  prev_hash            TEXT    NOT NULL,
  event_hash           TEXT    NOT NULL UNIQUE
) STRICT;

CREATE INDEX audit_events_subject ON audit_events (subject_type, subject_id);
CREATE INDEX audit_events_org ON audit_events (organization_id, seq);

-- Append-only: facts are never overwritten or removed.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
