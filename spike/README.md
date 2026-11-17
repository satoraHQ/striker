# v2 covenant spike

Proves the covenants in `DESIGN.md` §13 against arkd + the pinned emulator on regtest.

```sh
npm run regtest -- start     # arkd v0.9.16 + emulator v0.0.9-rc.2-striker.1
npm run spike                # all spike tests
node --import tsx --test spike/00-smoke.test.ts
```

`harness.ts` holds the shared helpers (wallets, faucet, demo USD, covenant trees, submit,
`refused`). Each area owns its own module and test file. Test key indices are allocated so
parallel suites never share wallets:

| Keys | Area | Files |
|---|---|---|
| 10–19 | harness smoke | `00-smoke.test.ts` |
| 20–39 | offer covenant (§13 1, 3, 4, 5, 6) | `offer.ts`, `10-offer*.test.ts` |
| 40–59 | emulator behaviour: late submission, chain depth (§13 2, 10) | `30-emulator*.test.ts` |
| 60–79 | swap covenant + taker dust (§13 7, 8) | `swap.ts`, `20-swap*.test.ts` |
| 80–99 | renewal + L1 exit (§13 9, 11) | `renew.ts`, `40-renew*.test.ts` |

## Findings

- arkd rejects block-based CSV exit leaves (`INVALID_VTXO_SCRIPT: CSV block type not allowed`).
  Exit leaves must use seconds (multiple of 512).
