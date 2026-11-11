# Pull Request Body Template

## Outcome

State the user-visible outcome and module. Do not claim runtime behavior without evidence.

## Identity

- Repository and base SHA
- Head SHA and dirty-tree state
- Module and owned requirement/test IDs
- Contract code hash or built artifact digest when applicable

## Boundary

- Included behavior
- Explicit exclusions
- Real, testnet, dry, simulated, mocked, blocked, and not-run dependencies

## Evidence

- Commands, exit codes, and counts
- Red and green behavior evidence
- Persistence/restart and failure-path results
- UI/accessibility evidence when applicable
- Security/privacy review

## Risks and rollback

- Remaining gates
- Data/contract migration
- Rollback and reconciliation plan
- External actions performed under separate authorization

## Review checklist

- Core contract and state semantics preserved
- No secret or private evidence committed
- No dry/testnet result presented as funded mainnet
- No unrelated changes or weakened assertions
- Required checks green; merge still requires separate authorization
