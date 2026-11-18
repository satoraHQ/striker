# Striker

Intent-based swaps on Arkade: makers rest signed quotes on offer covenants, users swap from any
Ark wallet through a one-shot deposit address, and Striker batches and fills them atomically.
See [DESIGN.md](./DESIGN.md) for the design and [spike/](./spike) for the covenant spike.

## Prototype

| Package | What |
|---|---|
| `packages/core` | Covenants (offer with Renew leaf, swap), signed quotes, tx builder, the settlement planner that fills swap deposits against an offer VTXO, and the HTTP API types. Runs in Node and the browser. |
| `apps/striker` | Striker server: book of live quotes (`GET /v1/book`, SSE `/v1/book/stream`), swap addresses (`POST /v1/swaps`), a settlement loop that fills deposits against the best offer and refunds after the deadline, and the renew delegate. |
| `apps/maker` | Maker bot: keeps one offer VTXO funded, re-signs both sides around a reference price (Binance, then Kraken and Coinbase) every few seconds. |
| `apps/web` | The simple flow as a PWA: pick an amount and slippage, get a deposit address (verified locally against the terms), pay it from any Ark wallet. |

Run it on the regtest stack:

```sh
npm install
npm run regtest -- start            # arkd + emulator + explorer + arkade wallet
npm run dev                         # funds a dev maker, starts Striker (:7090), the maker bot and the web app
npm run dev -- faucet <ark address> # regtest sats + $500 demo USD for a wallet to swap from
```

### Tests

```sh
npm run check   # types, all packages and tests
npm test        # offline unit and property tests (core quote/pricing/settlement, web units and verification)
npm run e2e     # on the regtest stack: core settlement txs, Striker + maker end to end, renewal,
                # then the web app in Chromium (Playwright): real swaps paid from a wallet, refunds,
                # tampered-terms rejection, validation, offline state, PWA, phone layout
npm run spike   # covenant spike
```

The browser suite alone: `npm run e2e -w apps/web` (first time: `npx playwright install --with-deps chromium`).
It builds the app, serves it with `vite preview` on :5183 and starts its own Striker (:7190) and maker.
Test wallets have keys derived from their names and are funded from a bank wallet that tops up from
the regtest faucet and issues the demo USD ([scripts/testnet.ts](./scripts/testnet.ts)).

## History

The first TypeScript PoC is archived at the `archive/poc-v1` tag (`git switch --detach archive/poc-v1`).
Earlier milestones remain tagged (`poc-three-message-baseline`, `poc-intent-v1-working`,
`slippage-orders-v1.1-working`, `usd8-dynamic-v1-working`, `covenant-maintenance-v1-working`, …).
