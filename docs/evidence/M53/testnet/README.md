# Attack console on NEAR testnet

The demo trade `trd_0f0efb61b5d32937af351ca9a5cba150` on `gnanam1990-dock-escrow3.testnet` (audited M50 build, code
hash `ACFe6Us2mTm8ms2VYgC1PTG4VrMmMHzNhT99tcxk2sq`) holds 2 test USDC: funded, approved, and blocked by an active
deterministic-policy hold. The attacker account `gnanam1990-dock-attacker.testnet` has only a function-call key for the
escrow with a 0.5 NEAR gas allowance and no role in the trade.

| # | Attack | Method | Result | Transaction |
|---|---|---|---|---|
| 1 | Change the payout account | `propose_destination_change` | `SIGNATURE_INVALID` | [ANnXUPm2…](https://testnet.nearblocks.io/txns/ANnXUPm26E6RdVgFMHRTAVjfXdu34cpixJPNymZSTBbW) |
| 2 | Release during the hold | `execute_release` | `HOLD_ACTIVE` | [2nSav2YP…](https://testnet.nearblocks.io/txns/2nSav2YPSVfxYqKy1QUQMeFn1TBZmKLXAiPZG55Pz6sC) |
| 3 | Approve with the wrong key | `resolve_hold` | `SIGNATURE_INVALID` | [E1V8fn7v…](https://testnet.nearblocks.io/txns/E1V8fn7vWciwofM8txDCqadYde1MLwadAsmeDVT3BtFB) |
| 4 | Replay the accepted approval | `approve_release` | `INVALID_STATE` | [DAnUWids…](https://testnet.nearblocks.io/txns/DAnUWidsR3oHhY3GkdwFMhhRuG7Se81bMFaZ3jTcHVA2) |
| 5 | Refund to a stranger | `request_refund` | `NOTHING_ELIGIBLE` | [WzvZPmuN…](https://testnet.nearblocks.io/txns/WzvZPmuNwtB2oB4w7MkMZLhojrpQdSdjgjE3tuwy5Jf) |

Every attempt recorded the trade ledger before and after: funded 2000000, reserved 2000000, released 0, refunded 0 in
both, `fundsUnchanged: true`. All five transaction records, with block hashes, are in
`site/proof/attack/attack-demo.json`; `run-record.json` and `journey.json` here are the demo trade's own run record.
