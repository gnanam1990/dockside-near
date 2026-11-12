-- 0007 unexpected-asset recovery journal (M11).
--
-- The escrow contract is the authority for every UNEXPECTED_ASSET_RECOVERY: it checks the
-- claimed sender's own transaction, the governing trade's bound risk/policy key, the 72-hour
-- challenge window, challenges, revocations and the compiled NEP-141 adapter, and it locks the
-- asset once execution is submitted. These tables are the API's append-only record of what it
-- prepared, which read-only validation it observed and which signatures it verified, plus the
-- durable execution journal: the signed transaction and its hash are written (SUBMITTING)
-- before any broadcast, and every later decision reconciles that original transaction.

CREATE TABLE asset_recovery_requests (
  recovery_id       TEXT    PRIMARY KEY,
  asset_index       INTEGER NOT NULL CHECK (asset_index >= 0),
  trade_id          TEXT    NOT NULL,
  trade_revision    INTEGER NOT NULL CHECK (trade_revision >= 1),
  standard          TEXT    NOT NULL CHECK (standard IN ('NEP-141', 'NEP-171', 'NEP-245')),
  asset_contract    TEXT    NOT NULL,
  amount            TEXT    NOT NULL,
  claimed_sender    TEXT    NOT NULL,
  evidence_json     TEXT    NOT NULL,
  evidence_digest   TEXT    NOT NULL,
  request_json      TEXT    NOT NULL,
  request_digest    TEXT    NOT NULL UNIQUE,
  prepared_by       TEXT    NOT NULL,
  prepared_at       INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX asset_recovery_requests_asset ON asset_recovery_requests (asset_index, prepared_at);

CREATE TABLE asset_recovery_validations (
  id                TEXT    PRIMARY KEY,
  recovery_id       TEXT    NOT NULL,
  report_json       TEXT    NOT NULL,
  report_digest     TEXT    NOT NULL UNIQUE,
  verdict           TEXT    NOT NULL CHECK (verdict IN ('SAFE', 'UNSAFE')),
  observed_by       TEXT    NOT NULL,
  observed_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE asset_recovery_signatures (
  id                TEXT    PRIMARY KEY,
  recovery_id       TEXT    NOT NULL,
  trade_id          TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('APPROVAL', 'CHALLENGE', 'REVOKE')),
  signer_role       TEXT    NOT NULL CHECK (signer_role IN ('BUYER', 'SUPPLIER', 'RISK_RESOLVER')),
  signer_principal  TEXT    NOT NULL,
  key_version_id    TEXT    NOT NULL,
  digest            TEXT    NOT NULL,
  payload_json      TEXT    NOT NULL,
  signature         TEXT    NOT NULL,
  recorded_at       INTEGER NOT NULL,
  UNIQUE (recovery_id, kind, signer_role, digest)
) STRICT;

CREATE TABLE asset_recovery_operations (
  operation_id         TEXT    PRIMARY KEY,
  recovery_id          TEXT    NOT NULL,
  asset_index          INTEGER NOT NULL CHECK (asset_index >= 0),
  asset_contract       TEXT    NOT NULL,
  recipient            TEXT    NOT NULL,
  amount               TEXT    NOT NULL,
  call_json            TEXT    NOT NULL,
  operation_digest     TEXT    NOT NULL,
  state                TEXT    NOT NULL CHECK (state IN (
    'QUEUED', 'SUBMITTING', 'UNKNOWN', 'PROCESSING', 'RECOVERED', 'FAILED', 'NOT_SUBMITTED', 'REVIEW')),
  version              INTEGER NOT NULL DEFAULT 0,
  signer_id            TEXT,
  tx_hash              TEXT    UNIQUE,
  signed_tx            TEXT,
  ref_block_height     INTEGER,
  token_balance_before TEXT,
  last_reason          TEXT,
  next_check_at        INTEGER NOT NULL,
  checks               INTEGER NOT NULL DEFAULT 0,
  requested_by         TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;

CREATE INDEX asset_recovery_operations_recovery ON asset_recovery_operations (recovery_id, created_at);

-- One unresolved execution per asset record: a second submit cannot be queued beside a live one.
CREATE UNIQUE INDEX asset_recovery_operations_live ON asset_recovery_operations (asset_index)
  WHERE state NOT IN ('RECOVERED', 'FAILED', 'NOT_SUBMITTED');

-- The transaction identity is written once, before broadcast, and never replaced.
CREATE TRIGGER asset_recovery_operations_tx_once BEFORE UPDATE OF tx_hash, signed_tx, signer_id ON asset_recovery_operations
WHEN OLD.tx_hash IS NOT NULL AND (NEW.tx_hash IS NOT OLD.tx_hash OR NEW.signed_tx IS NOT OLD.signed_tx OR NEW.signer_id IS NOT OLD.signer_id)
BEGIN SELECT RAISE(ABORT, 'transaction identity is write-once'); END;

-- Database-enforced state machine. RECOVERED, FAILED and NOT_SUBMITTED are terminal; REVIEW has
-- no outgoing transition here (no operator action can force an outcome).
CREATE TRIGGER asset_recovery_operations_legal BEFORE UPDATE OF state ON asset_recovery_operations
WHEN NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'QUEUED' AND NEW.state IN ('SUBMITTING', 'NOT_SUBMITTED')) OR
  (OLD.state = 'SUBMITTING' AND NEW.state IN ('UNKNOWN', 'PROCESSING', 'RECOVERED', 'FAILED', 'NOT_SUBMITTED', 'REVIEW')) OR
  (OLD.state = 'UNKNOWN' AND NEW.state IN ('PROCESSING', 'RECOVERED', 'FAILED', 'NOT_SUBMITTED', 'REVIEW')) OR
  (OLD.state = 'PROCESSING' AND NEW.state IN ('UNKNOWN', 'RECOVERED', 'FAILED', 'REVIEW'))
)
BEGIN SELECT RAISE(ABORT, 'illegal asset recovery transition'); END;

CREATE TRIGGER asset_recovery_operations_submit_needs_tx BEFORE UPDATE OF state ON asset_recovery_operations
WHEN NEW.state IN ('SUBMITTING', 'UNKNOWN', 'PROCESSING') AND NEW.tx_hash IS NULL
BEGIN SELECT RAISE(ABORT, 'a submitted operation needs its persisted transaction'); END;

CREATE TRIGGER asset_recovery_operations_no_delete BEFORE DELETE ON asset_recovery_operations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE asset_recovery_observations (
  id            TEXT    PRIMARY KEY,
  operation_id  TEXT    NOT NULL REFERENCES asset_recovery_operations (operation_id),
  source        TEXT    NOT NULL CHECK (source IN ('CONTRACT', 'TX_STATUS', 'TOKEN', 'BROADCAST')),
  fact_json     TEXT    NOT NULL,
  observed_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX asset_recovery_observations_op ON asset_recovery_observations (operation_id, observed_at);

CREATE TRIGGER asset_recovery_requests_no_update BEFORE UPDATE ON asset_recovery_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_requests_no_delete BEFORE DELETE ON asset_recovery_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_validations_no_update BEFORE UPDATE ON asset_recovery_validations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_validations_no_delete BEFORE DELETE ON asset_recovery_validations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_signatures_no_update BEFORE UPDATE ON asset_recovery_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_signatures_no_delete BEFORE DELETE ON asset_recovery_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_observations_no_update BEFORE UPDATE ON asset_recovery_observations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER asset_recovery_observations_no_delete BEFORE DELETE ON asset_recovery_observations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
