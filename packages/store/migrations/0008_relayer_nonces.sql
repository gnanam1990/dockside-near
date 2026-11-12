-- M15: relayer access-key nonces.
-- Several journaled engines (release/refund outbox, asset recovery) and several worker processes
-- sign with one relayer access key. A nonce is handed out here, under the relayer's signer lease,
-- above both the chain's access-key nonce and every nonce already handed out, so two submitters
-- never sign the same nonce and a transaction that was persisted but never broadcast never has its
-- nonce reused. Values are decimal strings (NEAR nonces are u64).
CREATE TABLE relayer_nonces (
  signer_id   TEXT    NOT NULL,
  public_key  TEXT    NOT NULL,
  last_nonce  TEXT    NOT NULL CHECK (last_nonce GLOB '[0-9]*' AND length(last_nonce) BETWEEN 1 AND 20),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (signer_id, public_key)
);

-- Nonces only move forward (compare as numbers: length first, then digits).
CREATE TRIGGER relayer_nonces_forward_only
BEFORE UPDATE OF last_nonce ON relayer_nonces
WHEN length(NEW.last_nonce) < length(OLD.last_nonce)
  OR (length(NEW.last_nonce) = length(OLD.last_nonce) AND NEW.last_nonce <= OLD.last_nonce)
BEGIN
  SELECT RAISE(ABORT, 'relayer nonce must increase');
END;

CREATE TRIGGER relayer_nonces_no_delete
BEFORE DELETE ON relayer_nonces
BEGIN
  SELECT RAISE(ABORT, 'relayer nonces are append-only');
END;
