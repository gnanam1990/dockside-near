-- 0005 durable economic-operation journal, transactional outbox, fenced worker leases and
-- reconciliation (M05).
--
-- Every external economic operation (direct release, escrow refund) is written here, together
-- with its outbox row, in one transaction before anything is submitted. Workers mutate
-- worker-owned rows only under the current epoch of a fenced lease. Observations, transitions,
-- dispositions, incidents, freezes and operator requests are append-only facts. The legal
-- state machine is data (operation_transition_rules) and a trigger refuses any other change, so
-- no code path, operator or ad-hoc UPDATE can promote REVIEW/ADJUDICATION to a terminal state,
-- release a lock without a terminal disposition, or submit an operation twice.

CREATE TABLE operation_transition_rules (
  kind        TEXT NOT NULL CHECK (kind IN ('RELEASE', 'REFUND')),
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  PRIMARY KEY (kind, from_state, to_state)
) STRICT;

INSERT INTO operation_transition_rules (kind, from_state, to_state) VALUES
  -- release intent (TDD section 11); QUEUED/WITHDRAWN are the journal's pre-submit states
  ('RELEASE', 'QUEUED', 'SUBMITTING'),
  ('RELEASE', 'QUEUED', 'WITHDRAWN'),
  ('RELEASE', 'SUBMITTING', 'PROCESSING'),
  ('RELEASE', 'SUBMITTING', 'UNKNOWN'),
  ('RELEASE', 'SUBMITTING', 'FAILED'),
  ('RELEASE', 'UNKNOWN', 'PROCESSING'),
  ('RELEASE', 'UNKNOWN', 'PAID'),
  ('RELEASE', 'UNKNOWN', 'REFUNDED'),
  ('RELEASE', 'UNKNOWN', 'FAILED'),
  ('RELEASE', 'UNKNOWN', 'REVIEW'),
  ('RELEASE', 'UNKNOWN', 'RECONCILING'),
  ('RELEASE', 'PROCESSING', 'PAID'),
  ('RELEASE', 'PROCESSING', 'REFUNDED'),
  ('RELEASE', 'PROCESSING', 'FAILED'),
  ('RELEASE', 'PROCESSING', 'REVIEW'),
  ('RELEASE', 'REVIEW', 'RECONCILING'),
  ('RELEASE', 'REVIEW', 'ADJUDICATION'),
  ('RELEASE', 'RECONCILING', 'PROCESSING'),
  ('RELEASE', 'RECONCILING', 'PAID'),
  ('RELEASE', 'RECONCILING', 'REFUNDED'),
  ('RELEASE', 'RECONCILING', 'FAILED'),
  ('RELEASE', 'RECONCILING', 'REVIEW'),
  ('RELEASE', 'ADJUDICATION', 'RECONCILING'),
  ('RELEASE', 'ADJUDICATION', 'REVIEW'),
  -- escrow refund (TDD section 12)
  ('REFUND', 'QUEUED', 'EXECUTING'),
  ('REFUND', 'QUEUED', 'WITHDRAWN'),
  ('REFUND', 'EXECUTING', 'PROCESSING'),
  ('REFUND', 'EXECUTING', 'UNKNOWN'),
  ('REFUND', 'EXECUTING', 'REFUNDED'),
  ('REFUND', 'EXECUTING', 'FAILED'),
  ('REFUND', 'EXECUTING', 'REVIEW'),
  ('REFUND', 'UNKNOWN', 'PROCESSING'),
  ('REFUND', 'UNKNOWN', 'REFUNDED'),
  ('REFUND', 'UNKNOWN', 'FAILED'),
  ('REFUND', 'UNKNOWN', 'REVIEW'),
  ('REFUND', 'UNKNOWN', 'RECONCILING'),
  ('REFUND', 'PROCESSING', 'REFUNDED'),
  ('REFUND', 'PROCESSING', 'FAILED'),
  ('REFUND', 'PROCESSING', 'REVIEW'),
  ('REFUND', 'REVIEW', 'RECONCILING'),
  ('REFUND', 'REVIEW', 'ADJUDICATION'),
  ('REFUND', 'RECONCILING', 'PROCESSING'),
  ('REFUND', 'RECONCILING', 'REFUNDED'),
  ('REFUND', 'RECONCILING', 'FAILED'),
  ('REFUND', 'RECONCILING', 'REVIEW'),
  ('REFUND', 'ADJUDICATION', 'RECONCILING'),
  ('REFUND', 'ADJUDICATION', 'REVIEW');

CREATE TABLE economic_operations (
  operation_id      TEXT    PRIMARY KEY,
  kind              TEXT    NOT NULL CHECK (kind IN ('RELEASE', 'REFUND')),
  trade_id          TEXT    NOT NULL,
  subject_id        TEXT    NOT NULL,
  operation_digest  TEXT    NOT NULL UNIQUE,
  material_json     TEXT    NOT NULL,
  call_json         TEXT    NOT NULL,
  recipient         TEXT    NOT NULL,
  amount_yocto      TEXT    NOT NULL,
  buckets_json      TEXT    NOT NULL,
  ledger_before_json TEXT   NOT NULL,
  state             TEXT    NOT NULL CHECK (state IN (
    'QUEUED', 'WITHDRAWN', 'SUBMITTING', 'EXECUTING', 'PROCESSING', 'UNKNOWN', 'REVIEW',
    'RECONCILING', 'ADJUDICATION', 'PAID', 'REFUNDED', 'FAILED')),
  lock_held         INTEGER NOT NULL CHECK (lock_held IN (0, 1)),
  version           INTEGER NOT NULL CHECK (version >= 1),
  submit_count      INTEGER NOT NULL DEFAULT 0 CHECK (submit_count IN (0, 1)),
  tx_hash           TEXT    UNIQUE,
  tx_signer         TEXT,
  signed_tx         TEXT,
  tx_ref_height     INTEGER,
  attempt_id        TEXT,
  disposition_id    TEXT,
  review_seq        INTEGER,
  checks            INTEGER NOT NULL DEFAULT 0,
  next_check_at     INTEGER NOT NULL,
  deadline_at       INTEGER NOT NULL,
  watch_until       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;

-- One operation per subject unless it was withdrawn before any effect (INV-06).
CREATE UNIQUE INDEX economic_operations_one_per_subject ON economic_operations (kind, subject_id)
  WHERE state <> 'WITHDRAWN';
-- One lock-holding release operation per trade (INV-09, INV-12).
CREATE UNIQUE INDEX economic_operations_one_release_lock ON economic_operations (trade_id)
  WHERE lock_held = 1 AND kind = 'RELEASE';
CREATE INDEX economic_operations_due ON economic_operations (next_check_at) WHERE lock_held = 1;

CREATE TABLE operation_transitions (
  id            TEXT    PRIMARY KEY,
  operation_id  TEXT    NOT NULL REFERENCES economic_operations (operation_id),
  from_state    TEXT,
  to_state      TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  cause         TEXT    NOT NULL,
  lease_name    TEXT,
  lease_epoch   INTEGER,
  evidence_json TEXT    NOT NULL,
  recorded_at   INTEGER NOT NULL,
  UNIQUE (operation_id, version)
) STRICT;

CREATE TABLE outbox (
  outbox_id     TEXT    PRIMARY KEY,
  operation_id  TEXT    NOT NULL UNIQUE REFERENCES economic_operations (operation_id),
  effect        TEXT    NOT NULL CHECK (effect IN ('SUBMIT')),
  status        TEXT    NOT NULL CHECK (status IN ('PENDING', 'DONE')),
  available_at  INTEGER NOT NULL,
  deliveries    INTEGER NOT NULL DEFAULT 0,
  done_by       TEXT,
  done_epoch    INTEGER,
  created_at    INTEGER NOT NULL,
  done_at       INTEGER
) STRICT;

CREATE TABLE worker_leases (
  lease_name   TEXT    PRIMARY KEY,
  holder       TEXT    NOT NULL,
  epoch        INTEGER NOT NULL CHECK (epoch >= 1),
  expires_at   INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL
) STRICT;

-- Normalized facts with provenance (NFR-06). A duplicate delivery of the same raw fact joins.
CREATE TABLE operation_observations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id  TEXT    NOT NULL UNIQUE,
  operation_id    TEXT    NOT NULL REFERENCES economic_operations (operation_id),
  source          TEXT    NOT NULL CHECK (source IN (
    'CONTRACT', 'LEDGER', 'TX_STATUS', 'RECEIPT', 'PROVIDER', 'REFUND_AUTHORITY')),
  subject         TEXT    NOT NULL,
  observed_at     INTEGER NOT NULL,
  recorded_at     INTEGER NOT NULL,
  freshness_ms    INTEGER NOT NULL,
  confidence      TEXT    NOT NULL CHECK (confidence IN ('AUTHORITATIVE', 'ATTRIBUTED', 'UNAVAILABLE')),
  revision        INTEGER,
  correlation_id  TEXT    NOT NULL,
  raw_digest      TEXT    NOT NULL,
  fact_json       TEXT    NOT NULL,
  lease_epoch     INTEGER,
  UNIQUE (operation_id, source, raw_digest)
) STRICT;

-- Terminal economic disposition: the evidence set and exact ledger delta that justified it.
CREATE TABLE operation_dispositions (
  disposition_id  TEXT    PRIMARY KEY,
  operation_id    TEXT    NOT NULL UNIQUE REFERENCES economic_operations (operation_id),
  outcome         TEXT    NOT NULL CHECK (outcome IN ('PAID', 'REFUNDED', 'FAILED', 'WITHDRAWN')),
  basis           TEXT    NOT NULL,
  evidence_json   TEXT    NOT NULL,
  ledger_after_json TEXT  NOT NULL,
  recorded_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE reconciliation_incidents (
  incident_id    TEXT    PRIMARY KEY,
  trade_id       TEXT    NOT NULL,
  operation_id   TEXT    REFERENCES economic_operations (operation_id),
  kind           TEXT    NOT NULL CHECK (kind IN (
    'CONTRADICTION', 'POST_FAILED_EVIDENCE', 'CONSERVATION', 'DESTINATION_MISMATCH',
    'SHORT_REFUND', 'EXCESS_REFUND', 'DEADLINE_EXCEEDED')),
  detail_json    TEXT    NOT NULL,
  frozen_json    TEXT    NOT NULL,
  dedupe_key     TEXT    NOT NULL UNIQUE,
  opened_at      INTEGER NOT NULL
) STRICT;

-- A frozen trade admits no new intent, approval, submit, activation or refund relay.
CREATE TABLE trade_freezes (
  trade_id     TEXT    NOT NULL,
  cause_id     TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  frozen_at    INTEGER NOT NULL,
  PRIMARY KEY (trade_id, cause_id)
) STRICT;

-- Operator requests: they can ask for reconciliation, open adjudication, name an evidence source
-- or freeze a trade. There is deliberately no request kind that asserts an outcome.
CREATE TABLE operator_requests (
  request_id     TEXT    PRIMARY KEY,
  operation_id   TEXT    REFERENCES economic_operations (operation_id),
  trade_id       TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN (
    'REQUEST_RECONCILIATION', 'OPEN_ADJUDICATION', 'IDENTIFY_SOURCE', 'FREEZE_TRADE')),
  actor_principal TEXT   NOT NULL,
  actor_key_version TEXT NOT NULL,
  detail_json    TEXT    NOT NULL,
  requested_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE operator_request_consumptions (
  request_id   TEXT    PRIMARY KEY REFERENCES operator_requests (request_id),
  consumed_at  INTEGER NOT NULL,
  lease_epoch  INTEGER
) STRICT;

/* ------------------------------- guards ------------------------------- */

CREATE TRIGGER economic_operations_no_delete BEFORE DELETE ON economic_operations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER economic_operations_identity_immutable BEFORE UPDATE ON economic_operations
WHEN OLD.operation_id IS NOT NEW.operation_id OR OLD.kind IS NOT NEW.kind
  OR OLD.trade_id IS NOT NEW.trade_id OR OLD.subject_id IS NOT NEW.subject_id
  OR OLD.operation_digest IS NOT NEW.operation_digest OR OLD.material_json IS NOT NEW.material_json
  OR OLD.call_json IS NOT NEW.call_json OR OLD.recipient IS NOT NEW.recipient
  OR OLD.amount_yocto IS NOT NEW.amount_yocto OR OLD.buckets_json IS NOT NEW.buckets_json
  OR OLD.ledger_before_json IS NOT NEW.ledger_before_json OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS NOT NEW.tx_hash)
  OR (OLD.signed_tx IS NOT NULL AND OLD.signed_tx IS NOT NEW.signed_tx)
  OR (OLD.tx_ref_height IS NOT NULL AND OLD.tx_ref_height IS NOT NEW.tx_ref_height)
  OR (OLD.attempt_id IS NOT NULL AND OLD.attempt_id IS NOT NEW.attempt_id)
  OR (OLD.disposition_id IS NOT NULL AND OLD.disposition_id IS NOT NEW.disposition_id)
  OR NEW.submit_count < OLD.submit_count
BEGIN SELECT RAISE(ABORT, 'economic operation identity is immutable'); END;

CREATE TRIGGER economic_operations_legal_transition BEFORE UPDATE OF state ON economic_operations
WHEN NEW.state IS NOT OLD.state AND NOT EXISTS (
  SELECT 1 FROM operation_transition_rules r
  WHERE r.kind = NEW.kind AND r.from_state = OLD.state AND r.to_state = NEW.state)
BEGIN SELECT RAISE(ABORT, 'illegal economic operation transition'); END;

CREATE TRIGGER economic_operations_version_step BEFORE UPDATE ON economic_operations
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'economic operation version must advance by one'); END;

-- A terminal state needs its recorded disposition; the lock is released only at a terminal state.
CREATE TRIGGER economic_operations_terminal_needs_disposition BEFORE UPDATE ON economic_operations
WHEN NEW.state IN ('PAID', 'REFUNDED', 'FAILED', 'WITHDRAWN') AND NEW.state IS NOT OLD.state AND NOT EXISTS (
  SELECT 1 FROM operation_dispositions d
  WHERE d.disposition_id = NEW.disposition_id AND d.operation_id = NEW.operation_id AND d.outcome = NEW.state)
BEGIN SELECT RAISE(ABORT, 'terminal state requires an evidence disposition'); END;

CREATE TRIGGER economic_operations_lock_only_at_terminal BEFORE UPDATE ON economic_operations
WHEN NEW.lock_held = 0 AND NEW.state NOT IN ('PAID', 'REFUNDED', 'FAILED', 'WITHDRAWN')
BEGIN SELECT RAISE(ABORT, 'the value lock is released only by a terminal disposition'); END;

CREATE TRIGGER economic_operations_terminal_releases_lock BEFORE UPDATE ON economic_operations
WHEN NEW.lock_held = 1 AND NEW.state IN ('PAID', 'REFUNDED', 'FAILED', 'WITHDRAWN')
BEGIN SELECT RAISE(ABORT, 'a terminal operation holds no lock'); END;

-- Submission is possible only from the queued state, and only once.
CREATE TRIGGER economic_operations_submit_once BEFORE UPDATE OF submit_count ON economic_operations
WHEN NEW.submit_count <> OLD.submit_count AND NOT (OLD.state = 'QUEUED' AND NEW.state IN ('SUBMITTING', 'EXECUTING'))
BEGIN SELECT RAISE(ABORT, 'an economic operation is submitted at most once, from QUEUED'); END;

CREATE TRIGGER economic_operations_insert_queued BEFORE INSERT ON economic_operations
WHEN NEW.state <> 'QUEUED' OR NEW.lock_held <> 1 OR NEW.submit_count <> 0 OR NEW.version <> 1
BEGIN SELECT RAISE(ABORT, 'economic operations start QUEUED with the lock held'); END;

CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER outbox_done_is_final BEFORE UPDATE ON outbox
WHEN OLD.status = 'DONE' OR OLD.operation_id IS NOT NEW.operation_id OR OLD.effect IS NOT NEW.effect
BEGIN SELECT RAISE(ABORT, 'outbox delivery is final'); END;

CREATE TRIGGER worker_leases_epoch_monotonic BEFORE UPDATE ON worker_leases
WHEN NEW.epoch < OLD.epoch OR (NEW.epoch = OLD.epoch AND NEW.holder IS NOT OLD.holder)
BEGIN SELECT RAISE(ABORT, 'lease epochs are monotonic and fenced'); END;
CREATE TRIGGER worker_leases_no_delete BEFORE DELETE ON worker_leases
BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER operation_transitions_no_update BEFORE UPDATE ON operation_transitions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_transitions_no_delete BEFORE DELETE ON operation_transitions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_observations_no_update BEFORE UPDATE ON operation_observations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_observations_no_delete BEFORE DELETE ON operation_observations
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_dispositions_no_update BEFORE UPDATE ON operation_dispositions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_dispositions_no_delete BEFORE DELETE ON operation_dispositions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER reconciliation_incidents_no_update BEFORE UPDATE ON reconciliation_incidents
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER reconciliation_incidents_no_delete BEFORE DELETE ON reconciliation_incidents
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER trade_freezes_no_update BEFORE UPDATE ON trade_freezes
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER trade_freezes_no_delete BEFORE DELETE ON trade_freezes
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operator_requests_no_update BEFORE UPDATE ON operator_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operator_requests_no_delete BEFORE DELETE ON operator_requests
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operator_request_consumptions_no_update BEFORE UPDATE ON operator_request_consumptions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operator_request_consumptions_no_delete BEFORE DELETE ON operator_request_consumptions
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_transition_rules_no_update BEFORE UPDATE ON operation_transition_rules
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_transition_rules_no_delete BEFORE DELETE ON operation_transition_rules
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER operation_transition_rules_no_insert BEFORE INSERT ON operation_transition_rules
BEGIN SELECT RAISE(ABORT, 'transition rules are fixed by migration'); END;
