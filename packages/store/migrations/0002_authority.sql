-- 0002 authority (M01): organizations, principals, versioned keys, role grants,
-- proof-of-possession challenges, one-time invitations, PoP sessions,
-- service enrollments (ManifestAttestor / deterministic policy) and recoveries.

CREATE TABLE organizations (
  id                       TEXT    PRIMARY KEY,
  name                     TEXT    NOT NULL,
  status                   TEXT    NOT NULL CHECK (status IN ('ACTIVE','FROZEN')),
  bootstrap_principal_id   TEXT    NOT NULL,
  created_at               INTEGER NOT NULL
) STRICT;

CREATE TABLE principals (
  id               TEXT    PRIMARY KEY,
  organization_id  TEXT    NOT NULL REFERENCES organizations(id),
  kind             TEXT    NOT NULL CHECK (kind IN ('HUMAN','SERVICE')),
  display_name     TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('PENDING_GRANT','ACTIVE','SUSPENDED')),
  enrolled_via     TEXT    NOT NULL CHECK (enrolled_via IN ('BOOTSTRAP','INVITATION','SERVICE_ENROLLMENT')),
  enrollment_session_id TEXT,
  created_at       INTEGER NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX principals_org ON principals (organization_id);

CREATE TABLE key_versions (
  id               TEXT    PRIMARY KEY,
  principal_id     TEXT    NOT NULL REFERENCES principals(id),
  version          INTEGER NOT NULL CHECK (version >= 1),
  public_key       TEXT    NOT NULL UNIQUE,
  status           TEXT    NOT NULL CHECK (status IN ('PENDING_PROOF','PENDING_ACTIVATION','ACTIVE','SUPERSEDED','SUSPENDED','REVOKED')),
  custody_kind     TEXT,
  custody_ref      TEXT,
  not_before       INTEGER,
  created_at       INTEGER NOT NULL,
  proven_at        INTEGER,
  activated_at     INTEGER,
  superseded_at    INTEGER,
  suspended_at     INTEGER,
  revoked_at       INTEGER,
  revoke_reason    TEXT,
  UNIQUE (principal_id, version)
) STRICT;

CREATE TABLE role_grants (
  id                       TEXT    PRIMARY KEY,
  organization_id          TEXT    NOT NULL REFERENCES organizations(id),
  principal_id             TEXT    NOT NULL REFERENCES principals(id),
  capability               TEXT    NOT NULL,
  status                   TEXT    NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  granted_by_principal_id  TEXT,
  granted_session_id       TEXT,
  invitation_id            TEXT,
  created_at               INTEGER NOT NULL,
  revoked_at               INTEGER
) STRICT;
CREATE UNIQUE INDEX role_grants_active ON role_grants (principal_id, capability) WHERE status = 'ACTIVE';

CREATE TABLE proof_challenges (
  id               TEXT    PRIMARY KEY,
  purpose          TEXT    NOT NULL,
  domain           TEXT    NOT NULL CHECK (domain IN ('POP_CHALLENGE','SERVICE_POP_CHALLENGE')),
  origin           TEXT    NOT NULL,
  organization_id  TEXT,
  principal_id     TEXT,
  key_version_id   TEXT,
  related_id       TEXT,
  public_key       TEXT    NOT NULL,
  payload_json     TEXT    NOT NULL,
  digest_hex       TEXT    NOT NULL,
  nonce            TEXT    NOT NULL UNIQUE,
  issued_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('PENDING','CONSUMED')),
  consumed_at      INTEGER
) STRICT;

CREATE TABLE invitations (
  id                     TEXT    PRIMARY KEY,
  organization_id        TEXT    NOT NULL REFERENCES organizations(id),
  capability             TEXT    NOT NULL,
  secret_hash            TEXT    NOT NULL UNIQUE,
  status                 TEXT    NOT NULL CHECK (status IN ('PENDING','ACCEPTED','GRANTED','REVOKED')),
  created_by_principal_id TEXT   NOT NULL,
  created_session_id     TEXT    NOT NULL,
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  accepted_principal_id  TEXT,
  accepted_session_id    TEXT,
  accepted_at            INTEGER,
  granted_at             INTEGER
) STRICT;

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  token_hash       TEXT    NOT NULL UNIQUE,
  principal_id     TEXT    NOT NULL REFERENCES principals(id),
  key_version_id   TEXT    NOT NULL REFERENCES key_versions(id),
  organization_id  TEXT    NOT NULL REFERENCES organizations(id),
  challenge_id     TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoke_reason    TEXT
) STRICT;
CREATE INDEX sessions_key ON sessions (key_version_id);

CREATE TABLE service_enrollments (
  id                 TEXT    PRIMARY KEY,
  organization_id    TEXT    NOT NULL REFERENCES organizations(id),
  principal_id       TEXT    NOT NULL UNIQUE REFERENCES principals(id),
  service_id         TEXT    NOT NULL,
  capability         TEXT    NOT NULL CHECK (capability IN ('MANIFEST_ATTEST','DETERMINISTIC_POLICY_SET','EXECUTOR')),
  scope_json         TEXT    NOT NULL,
  scope_digest       TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('PENDING_PROOF','ACTIVE','REVOKED')),
  created_by         TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (organization_id, service_id)
) STRICT;

CREATE TABLE recoveries (
  id                     TEXT    PRIMARY KEY,
  organization_id        TEXT    NOT NULL REFERENCES organizations(id),
  principal_id           TEXT    NOT NULL REFERENCES principals(id),
  new_key_version_id     TEXT    NOT NULL REFERENCES key_versions(id),
  suspended_key_ids_json TEXT    NOT NULL,
  status                 TEXT    NOT NULL CHECK (status IN ('PENDING_PROOF','WAITING','COMPLETED','CANCELLED')),
  requested_by           TEXT    NOT NULL,
  requested_session_id   TEXT    NOT NULL,
  requested_at           INTEGER NOT NULL,
  not_before             INTEGER NOT NULL,
  completed_by           TEXT,
  completed_at           INTEGER,
  cancelled_at           INTEGER
) STRICT;
