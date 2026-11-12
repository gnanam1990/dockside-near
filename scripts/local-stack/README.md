# Local stack (simulated chain)

Runs the real control API with every trade module on one machine, for the web UI and its browser tests.
Decision record: [ADR-0010](../../docs/adr/0010-product-ui-wiring-and-local-stack.md).

**The chain is simulated**: the compiled escrow wasm on the M02 host behind the M05 JSON-RPC server. Nothing here
touches NEAR testnet, and no result from it is a testnet result.

```sh
pnpm install && pnpm run build && pnpm run contract:build
DOCKSIDE_ORIGIN=http://127.0.0.1:4391 pnpm run stack            # API :8791, control/relayer :8792
DOCKSIDE_API_URL=http://127.0.0.1:8791 DOCKSIDE_RELAYER_URL=http://127.0.0.1:8792 \
  pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
```

Environment: `DOCKSIDE_STACK_API_PORT`, `DOCKSIDE_STACK_CONTROL_PORT`, `DOCKSIDE_ORIGIN` (must equal the web
origin), `DOCKSIDE_STACK_DATA_DIR` (default: a fresh temporary directory), `DOCKSIDE_DESTINATION_CHANGE_DELAY_MS`
(the destination-change delay new proposals bind; default one day, minimum one minute; the browser tests use one
minute).

Control port (loopback only; never expose it):

| Route | What it does |
|---|---|
| `GET /control/info` | organisations, service enrollment ids, policy id, contract, accounts (including `supplierAlt`, a second supplier-owned account), the bound destination-change delay and the chain clock offset |
| `POST /control/invitations {org, capability}` | the organisation administrator creates an invitation (one-time secret returned) |
| `POST /control/grants {org, invitationId}` | the administrator grants after the person accepted in their own browser session |
| `POST /control/fund {tradeId, from, amountYocto}` | the funder's simulated wallet sends the `fund` deposit |
| `POST /control/funder-call {from, call}` | the funder's simulated wallet submits a `request_refund` / `revoke_refund` call the API prepared for it (funder returns) |
| `POST /control/chain-time {advanceMs}` | simulated chain only: block time moves forward (at most 7 days per call) so a contract timelock can elapse; the API, worker and sessions keep the wall clock |
| `POST /control/faults {statusDown?, down?, dropSendResponses?, hideAllReceipts?}` | chain fault switches |
| `GET /relay/v1/status`, `POST /relay/v1/calls {call}` | relayer for party calls (the web server proxies `/relay`) |

Services inside the process: ManifestAttestor and deterministic-policy signers (isolated child processes), the
M05 outbox worker and reconciler, three organisation administrators. Human trade roles are only ever enrolled
through invitations accepted in the browser.
