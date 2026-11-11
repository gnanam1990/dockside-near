-- 0004 release intents, buyer approvals, pre-submit exits and destination changes (M04).
-- The escrow contract is the authority; these rows are the service journal that prepares,
-- verifies and relays signed payloads and mirrors contract observations. Facts are append-only;
-- the one mutable row per intent carries an optimistic version and is guarded by a partial unique
-- index so a trade can never have two live value locks, even across connections.

-- Successor trade revisions activated through the destination-change protocol.
CREATE TABLE evidence_trade_successors (
  trade_id        TEXT    NOT NULL REFERENCES evidence_trades (trade_id),
  trade_revision  INTEGER NOT NULL CHECK (trade_revision >= 2),
  terms_digest    TEXT    NOT NULL UNIQUE,
  terms_json      TEXT    NOT NULL,
  activated_at    INTEGER NOT NULL,
  PRIMARY KEY (trade_id, trade_revision)
) STRICT;

CREATE TABLE release_intents (
  intent_id          TEXT    PRIMARY KEY,
  trade_id           TEXT    NOT NULL,
  trade_revision     INTEGER NOT NULL,
  idempotency_key    TEXT,
  request_digest     TEXT,
  request_json       TEXT,
  buyer_signature    TEXT,
  amount_yocto       TEXT    NOT NULL,
  slices_json        TEXT    NOT NULL,
  destination        TEXT    NOT NULL,
  profile            TEXT    NOT NULL CHECK (profile = 'DIRECT_TESTNET'),
  state              TEXT    NOT NULL CHECK (state IN (
    'PREPARED', 'EXPIRED_UNSIGNED', 'VALUE_LOCKED', 'DIRECT_TESTNET_AUTHORIZED',
    'FUNDED_AUTHORIZATION_REQUIRED', 'FUNDED_AUTHORIZED', 'SUBMITTING', 'PROCESSING', 'UNKNOWN',
    'REVIEW', 'RECONCILING', 'ADJUDICATION', 'PAID', 'REFUNDED', 'FAILED',
    'CANCELLED_PRE_SUBMIT', 'ABANDONED_PRE_SUBMIT', 'SUPERSEDED_PRE_SUBMIT')),
  live               INTEGER NOT NULL CHECK (live IN (0, 1)),
  version            INTEGER NOT NULL CHECK (version >= 1),
  contract_version   INTEGER,
  predecessor_id     TEXT REFERENCES release_intents (intent_id),
  prepared_by        TEXT,
  intent_expires_at  INTEGER NOT NULL,
  prepared_expires_at INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;

-- One live value lock per trade (INV-06, INV-09, INV-12).
CREATE UNIQUE INDEX release_intents_one_live ON release_intents (trade_id) WHERE live = 1;
CREATE UNIQUE INDEX release_intents_idempotency ON release_intents (trade_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE release_intent_events (
  id           TEXT    PRIMARY KEY,
  intent_id    TEXT    NOT NULL REFERENCES release_intents (intent_id),
  from_state   TEXT,
  to_state     TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  source       TEXT    NOT NULL CHECK (source IN ('SERVICE', 'CONTRACT_OBSERVATION')),
  detail_json  TEXT    NOT NULL,
  recorded_at  INTEGER NOT NULL,
  UNIQUE (intent_id, version)
) STRICT;

-- Child identities correlated to a release intent (attempts now; quotes in the funded profile).
CREATE TABLE release_children (
  child_id     TEXT    PRIMARY KEY,
  intent_id    TEXT    NOT NULL REFERENCES release_intents (intent_id),
  kind         TEXT    NOT NULL CHECK (kind IN ('ATTEMPT', 'QUOTE')),
  ordinal      INTEGER NOT NULL,
  recorded_at  INTEGER NOT NULL,
  UNIQUE (intent_id, kind, ordinal)
) STRICT;

-- Verified signatures the service relayed: approvals, CANCEL consents/revocations, ABANDON,
-- destination consents/revocations.
CREATE TABLE release_signatures (
  id                 TEXT    PRIMARY KEY,
  trade_id           TEXT    NOT NULL,
  intent_id          TEXT,
  kind               TEXT    NOT NULL CHECK (kind IN (
    'BUYER_APPROVAL', 'CANCEL_CONSENT', 'CANCEL_CONSENT_REVOKE', 'ABANDON',
    'DESTINATION_CONSENT', 'DESTINATION_REVOKE')),
  signer_role        TEXT    NOT NULL,
  signer_principal   TEXT    NOT NULL,
  key_version_id     TEXT    NOT NULL,
  digest             TEXT    NOT NULL,
  payload_json       TEXT    NOT NULL,
  signature          TEXT    NOT NULL,
  expires_at         INTEGER NOT NULL,
  recorded_at        INTEGER NOT NULL,
  UNIQUE (digest, signer_role)
) STRICT;

CREATE TRIGGER evidence_trade_successors_no_update BEFORE UPDATE ON evidence_trade_successors
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER evidence_trade_successors_no_delete BEFORE DELETE ON evidence_trade_successors
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_intents_no_delete BEFORE DELETE ON release_intents
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_intents_identity_immutable BEFORE UPDATE ON release_intents
WHEN OLD.intent_id IS NOT NEW.intent_id OR OLD.trade_id IS NOT NEW.trade_id
  OR OLD.trade_revision IS NOT NEW.trade_revision OR OLD.request_digest IS NOT NEW.request_digest
  OR OLD.amount_yocto IS NOT NEW.amount_yocto OR OLD.slices_json IS NOT NEW.slices_json
  OR OLD.destination IS NOT NEW.destination OR OLD.predecessor_id IS NOT NEW.predecessor_id
  OR OLD.created_at IS NOT NEW.created_at
  OR (OLD.buyer_signature IS NOT NULL AND OLD.buyer_signature IS NOT NEW.buyer_signature)
BEGIN SELECT RAISE(ABORT, 'release intent identity is immutable'); END;
CREATE TRIGGER release_intent_events_no_update BEFORE UPDATE ON release_intent_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_intent_events_no_delete BEFORE DELETE ON release_intent_events
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_children_no_update BEFORE UPDATE ON release_children
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_children_no_delete BEFORE DELETE ON release_children
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_signatures_no_update BEFORE UPDATE ON release_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_signatures_no_delete BEFORE DELETE ON release_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
