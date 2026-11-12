-- 0009 organization settings, signed audit export keys and NEAR account links (M17).
--
-- organization_settings: append-only revisions of an organisation's editable settings (retention).
-- Each change is a new revision written with compare-and-swap on the previous revision number, the
-- acting principal and key version, and the SHA-256 of the canonical settings document.
--
-- evidence_policy_owners: the organisation that first registered an EvidencePolicy id owns its later
-- revisions. Registration of a revision by another organisation is refused at the API.
--
-- audit_export_keys: the deployment operator's dedicated audit-export signing keys. The private key
-- stays in an isolated signer process; this table holds only the public key, the signed enrollment
-- statement (proof of possession) and the lifecycle. A key is ACTIVE, RETIRED (superseded by a newer
-- key; signatures made before retired_at still verify) or REVOKED (no signature verifies).
--
-- near_account_links / near_account_checks: a principal's NEAR account bound by a NEP-413 wallet
-- signature plus a chain observation (view_access_key) that the signing key is a full-access key of
-- that account. Every observation is appended; the link row carries the latest result.

CREATE TABLE organization_settings (
  organization_id           TEXT    NOT NULL,
  revision                  INTEGER NOT NULL CHECK (revision >= 1),
  settings_json             TEXT    NOT NULL,
  digest                    TEXT    NOT NULL,
  changed_by_principal_id   TEXT    NOT NULL,
  changed_by_key_version_id TEXT    NOT NULL,
  changed_at                INTEGER NOT NULL,
  PRIMARY KEY (organization_id, revision)
) STRICT;

CREATE TRIGGER organization_settings_no_update BEFORE UPDATE ON organization_settings
BEGIN SELECT RAISE(ABORT, 'organization_settings is append-only'); END;
CREATE TRIGGER organization_settings_no_delete BEFORE DELETE ON organization_settings
BEGIN SELECT RAISE(ABORT, 'organization_settings is append-only'); END;

CREATE TABLE evidence_policy_owners (
  policy_id                  TEXT    PRIMARY KEY,
  organization_id            TEXT    NOT NULL,
  registered_by_principal_id TEXT,
  registered_at              INTEGER NOT NULL
) STRICT;

CREATE TABLE audit_export_keys (
  key_id                TEXT    PRIMARY KEY,
  public_key            TEXT    NOT NULL UNIQUE,
  origin                TEXT    NOT NULL,
  network               TEXT    NOT NULL,
  custody_kind          TEXT    NOT NULL,
  statement_json        TEXT    NOT NULL,
  statement_digest      TEXT    NOT NULL,
  statement_signature   TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED', 'REVOKED')),
  enrolled_at           INTEGER NOT NULL,
  retired_at            INTEGER,
  revoked_at            INTEGER,
  revoke_reason         TEXT
) STRICT;

CREATE UNIQUE INDEX audit_export_keys_one_active ON audit_export_keys (origin) WHERE status = 'ACTIVE';

CREATE TABLE near_account_challenges (
  id                TEXT    PRIMARY KEY,
  principal_id      TEXT    NOT NULL,
  key_version_id    TEXT    NOT NULL,
  organization_id   TEXT    NOT NULL,
  account_id        TEXT    NOT NULL,
  origin            TEXT    NOT NULL,
  message           TEXT    NOT NULL,
  nonce             TEXT    NOT NULL UNIQUE,
  digest_hex        TEXT    NOT NULL,
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('PENDING', 'CONSUMED')),
  consumed_at       INTEGER
) STRICT;

CREATE TABLE near_account_links (
  id                TEXT    PRIMARY KEY,
  principal_id      TEXT    NOT NULL,
  organization_id   TEXT    NOT NULL,
  key_version_id    TEXT    NOT NULL,
  account_id        TEXT    NOT NULL,
  public_key        TEXT    NOT NULL,
  network           TEXT    NOT NULL,
  challenge_id      TEXT    NOT NULL UNIQUE,
  signature         TEXT    NOT NULL,
  status            TEXT    NOT NULL CHECK (status IN ('VERIFIED', 'KEY_NOT_FOUND', 'NOT_FULL_ACCESS')),
  permission        TEXT,
  block_height      INTEGER,
  linked_at         INTEGER NOT NULL,
  last_checked_at   INTEGER NOT NULL,
  UNIQUE (principal_id, account_id, public_key)
) STRICT;

CREATE TABLE near_account_checks (
  id                TEXT    PRIMARY KEY,
  link_id           TEXT    NOT NULL REFERENCES near_account_links(id),
  result            TEXT    NOT NULL CHECK (result IN ('VERIFIED', 'KEY_NOT_FOUND', 'NOT_FULL_ACCESS')),
  permission        TEXT,
  block_height      INTEGER,
  checked_by        TEXT    NOT NULL,
  checked_at        INTEGER NOT NULL
) STRICT;

CREATE TRIGGER near_account_checks_no_update BEFORE UPDATE ON near_account_checks
BEGIN SELECT RAISE(ABORT, 'near_account_checks is append-only'); END;
