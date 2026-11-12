-- 0006 refund request journal (M10).
--
-- The escrow contract is the authority for every refund intent: it recomputes the eligible
-- amount and source bucket from its own ledger, checks the reason row, clocks, signatures and
-- caller, and holds the value lock. These rows are the API's append-only record of what it
-- prepared and which signatures it verified before relaying, so the second signer of a
-- MUTUAL_CANCEL or PERMANENT_HOLD row can review the exact payload the first signer signed.

CREATE TABLE refund_requests (
  refund_intent_id  TEXT    PRIMARY KEY,
  trade_id          TEXT    NOT NULL,
  trade_revision    INTEGER NOT NULL CHECK (trade_revision >= 1),
  reason            TEXT    NOT NULL CHECK (reason IN (
    'TRADE_EXPIRY', 'INSPECTION_FAIL', 'PERMANENT_HOLD', 'MUTUAL_CANCEL',
    'PARTIAL_FUNDING_RETURN', 'EXCESS_FUNDING_RETURN')),
  funder            TEXT    NOT NULL,
  amount_yocto      TEXT    NOT NULL,
  source_bucket     TEXT    NOT NULL CHECK (source_bucket IN ('PARTIAL', 'AVAILABLE', 'QUARANTINED')),
  initiator_role    TEXT    NOT NULL CHECK (initiator_role IN ('BUYER', 'SUPPLIER', 'FUNDER', 'RISK_RESOLVER')),
  request_json      TEXT    NOT NULL,
  request_digest    TEXT    NOT NULL UNIQUE,
  prepared_by       TEXT    NOT NULL,
  prepared_at       INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX refund_requests_trade ON refund_requests (trade_id, prepared_at);

CREATE TABLE refund_signatures (
  id                TEXT    PRIMARY KEY,
  refund_intent_id  TEXT    NOT NULL,
  trade_id          TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('REQUEST', 'COSIGN', 'REVOKE', 'DISPUTE', 'AUTHORIZE')),
  signer_role       TEXT    NOT NULL CHECK (signer_role IN ('BUYER', 'SUPPLIER', 'RISK_RESOLVER')),
  signer_principal  TEXT    NOT NULL,
  key_version_id    TEXT    NOT NULL,
  digest            TEXT    NOT NULL,
  payload_json      TEXT    NOT NULL,
  signature         TEXT    NOT NULL,
  recorded_at       INTEGER NOT NULL,
  UNIQUE (refund_intent_id, kind, signer_role, digest)
) STRICT;

CREATE TRIGGER refund_requests_no_update BEFORE UPDATE ON refund_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER refund_requests_no_delete BEFORE DELETE ON refund_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER refund_signatures_no_update BEFORE UPDATE ON refund_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER refund_signatures_no_delete BEFORE DELETE ON refund_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
