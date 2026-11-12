-- 0009 key-rebinding revisions (M14).
--
-- A key-rebinding revision is a successor trade revision that changes only bound key versions
-- and public keys. Its party consents and revocations are journaled in release_signatures like
-- destination-change consents; the escrow contract remains the authority (it re-verifies every
-- signature, the anchoring party key, the delay and the value lock). SQLite cannot widen a CHECK
-- constraint in place, so the append-only table is rebuilt with the two new kinds and its
-- append-only triggers are recreated. No row changes.

DROP TRIGGER release_signatures_no_update;
DROP TRIGGER release_signatures_no_delete;

CREATE TABLE release_signatures_m14 (
  id                 TEXT    PRIMARY KEY,
  trade_id           TEXT    NOT NULL,
  intent_id          TEXT,
  kind               TEXT    NOT NULL CHECK (kind IN (
    'BUYER_APPROVAL', 'CANCEL_CONSENT', 'CANCEL_CONSENT_REVOKE', 'ABANDON',
    'DESTINATION_CONSENT', 'DESTINATION_REVOKE', 'KEY_REBINDING_CONSENT', 'KEY_REBINDING_REVOKE')),
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

INSERT INTO release_signatures_m14
  (id, trade_id, intent_id, kind, signer_role, signer_principal, key_version_id, digest, payload_json,
   signature, expires_at, recorded_at)
SELECT id, trade_id, intent_id, kind, signer_role, signer_principal, key_version_id, digest, payload_json,
   signature, expires_at, recorded_at
FROM release_signatures;

DROP TABLE release_signatures;
ALTER TABLE release_signatures_m14 RENAME TO release_signatures;

CREATE TRIGGER release_signatures_no_update BEFORE UPDATE ON release_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER release_signatures_no_delete BEFORE DELETE ON release_signatures
BEGIN SELECT RAISE(ABORT, 'append-only'); END;
