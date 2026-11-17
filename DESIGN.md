# Striker design (v2)

Status: draft. Spike done (§15); its findings are folded in below. The first PoC is archived at `archive/poc-v1`.

Striker is an intent-based swap layer for Arkade. Makers rest signed offers; takers get the
best price from an aggregated book and settle atomically in one Arkade transaction. Striker
routes, batches and renews, and charges takers a fee. It never holds funds, and it cannot
change trade terms.

The pitch against plain Arkade intents: an aggregated book visible to everyone, quotes that
makers sign off-chain without a transaction per requote, several takers batched against one
maker, and a send-to-address flow that works from any Ark wallet.

## 1. Requirements

**Maker**
- M1 Create offers with a rate and a maximum amount.
- M2 Update and cancel offers (CRUD).
- M3 See the whole orderbook, including other makers.
- M4 Never lose money: no theft, no over-fill, no filling of cancelled or stale offers, no
  paying the taker's dust.

**Taker**
- T1 The latest price, as fast as possible.
- T2 The whole orderbook, to judge depth.
- T3 The best rate.
- T4 Fast execution.
- T5 Fund from any Arkade VTXO, without depositing into a covenant first.
- T6 Dust handling: bought tokens arrive on an output carrying dust that the taker pays from
  their own sats. A taker can't accidentally sell the sats they need for that dust. A taker
  who spends a whole token VTXO gets its dust back on top of the BTC they bought.

**UX**
- U1 Simple flow: "buy $X of sats" or "buy X sats for $". Striker computes the other side,
  the user picks a slippage (0 %, 0.1 %, 0.5 %, 1 %, …) and is shown an address to pay.
- U2 Advanced flow: an exchange-style UI with a connected wallet and limit orders (good-till-
  cancelled, good-till-time, post-only, fill-or-kill, immediate-or-cancel).

**Decided for v2 prototype**
- TypeScript again. Rust only after the design survives the spike.
- Mutinynet. BTC ↔ demo USD (8 decimals), the existing demo asset.
- Takers pay the fee; makers trade for free.
- Inputs are Ark VTXOs only. On-chain and Lightning funding are out of scope.

## 2. Building blocks

Everything is built from three primitives.

| Block | Used by | Who protects the user |
|---|---|---|
| **Offer covenant**: a resting balance that fills against maker-signed quotes | Makers, advanced-flow limit orders | Covenant |
| **Swap covenant**: a one-shot deposit address with a minimum rate and a refund | Simple flow (U1) | Covenant |
| **Direct fill**: the taker signs the whole transaction from any VTXO | Connected-wallet market orders (T5) | Taker's own SIGHASH_ALL signature |

A taker's limit order is an offer covenant owned by the taker. No extra script is needed.

Every covenant VTXO follows the emulator's dual-VM model:

- **Covenant leaves** are a 2-of-2 between `arkd_signer` and `emulator_key` tweaked by the
  Arkade script hash. The emulator signs only if the Arkade Script passes. They are valid off-chain only.
- **An exit leaf** is plain tapscript, owner key + CSV, executable on L1 without the emulator.
  arkd only accepts seconds-based CSV (a multiple of 512, ≥ `unilateralExitDelay`).
- **Covenant leaves are exactly `[server, emulator]`.** If any other key comes after the
  emulator key, the emulator is not the finalizer and hands its signatures back to the caller,
  who can then submit them to arkd after a quote has expired.
- **Every Fill leaf is offchain-only.** It starts with `"type" OP_INSPECTINTENTMESSAGE OP_NOT
  OP_VERIFY OP_DROP`. Without this gate, an intent proof signed before expiry can be settled
  in a batch at any later time, because the batch path never re-runs the script. Offchain
  fills are validated, signed, submitted and finalized in a single emulator `SubmitTx` call.

## 3. Signed quote

```
Quote {
  maker_pubkey        // redundant with the script key; may be dropped
  epoch               // must equal the covenant's epoch
  sell_asset, buy_asset   // asset IDs; "BTC" = sats
  rate_num, rate_den  // buy_amount ≥ sell_amount × rate_num / rate_den
  floor               // remaining sell-side balance must stay ≥ floor
  min_fill            // smallest sell amount per fill
  expiry              // unix seconds, checked with OP_CHECKTIME
}
// optionally a second leg (bid + ask) under one signature
```

- The maker signs off-chain: BIP340 over `tagged_hash("striker/quote/v2", quote)`, with the
  version in the tag. The covenant rebuilds the tagged hash and checks it with
  `OP_CHECKSIGFROMSTACK`. Spike layout: 148 bytes, u64 LE fields (< 2^63), BTC = 34 zero bytes.
  A direction byte instead of two 34-byte asset IDs would roughly halve the script size.
- **Floor instead of maximum.** "Up to X" could be reused on every chained change VTXO. A
  fixed balance floor caps the total across any chain of partial fills with no extra state.
- **Expiry.** `<expiry> OP_CHECKTIME OP_NOT OP_VERIFY` means "valid only before expiry",
  judged by the emulator host's wall clock. The emulator already co-signs every spend, so this
  adds no new trust. It holds only together with the offchain-only gate (§2).
- **Epoch.** It is part of the covenant script. A self-spend into a covenant with `epoch+1`
  cancels every outstanding quote at once.

## 4. Offer covenant

One VTXO holds the maker's liquidity, and it may carry **both** assets: sats plus demo USD.
Payments flow into the change output instead of a separate maker output. The maker never
funds new dust, and proceeds can immediately back offers on the other side.

**Leaves**

| Leaf | Spend condition |
|---|---|
| Fill | Valid quote (signature, epoch, expiry) + the fill rules below |
| Owner | Maker key: withdraw, re-price, epoch bump |
| Renew | Anyone (Striker as delegate): batch registration only, script and value preserved |
| Exit (L1) | Maker key + CSV |

**Fill rules** for maker input `i`, change at its paired output (fixed index pairing, so two
makers can never count one output):

```
change.script == input.script                    // same covenant, same epoch
sold     = input.sell_bal − change.sell_bal
received = change.buy_bal − input.buy_bal
sold     ≥ quote.min_fill
received × rate_den ≥ sold × rate_num            // rounded in the maker's favour
change.sell_bal ≥ quote.floor
all other assets preserved exactly            // OP_TUNNEL flags 5, traded token excepted
```

- `floor` on the sats side must be ≥ dust, and `min_fill` > 0.
- The change is the output with the same index as the maker input (`PUSHCURRENTINPUTINDEX`).
  The spike's attack transactions that tried to make two makers count one output were refused.
- `OP_INSPECT*ASSET*` take the asset txid byte-reversed relative to the SDK's `AssetId.txid`.
- The Fill leaf in the spike is 644 bytes. Owner leaf `[maker, arkd]` (epoch bump and
  withdrawal need no emulator). Exit leaf maker + CSV 1536 s.

Balances are sats (`OP_INSPECTINPUTVALUE` / `OP_INSPECTOUTPUTVALUE`) or asset amounts
(`OP_INSPECT*ASSET*`). The covenant never looks at taker outputs, so any number of takers
can share one maker fill (§7).

## 5. Swap covenant (simple flow)

A deposit address made for one order. The user pays it from any Ark wallet (e.g.
arkade.money, which sends both BTC and assets).

Parameters: `receive_address`, `refund_address`, `fee_address`, `sell_asset`, `buy_asset`,
`min_rate` (buy units per sell unit: quoted rate minus slippage), `fee_bps`, `deadline`
(≈ 10 min), `refund_pubkey`, optional `want` (exact-out amount).

- Output positions: swap input `i` of `n` pays receive at output `i` and any exact-out refund at
  `i + n`. The fee output index is the only witness item.
- The fee is in sats: `ceil((input − D) · bps)` for BTC → token, taken from the deposit, and
  `ceil(floor(U · min_rate) · bps)` for token → BTC, taken from the bought sats.
- A fee below 330 sats must go to the fee key's `OP_RETURN <key>` sub-dust form; arkd
  rejects other outputs below dust.
- Exact-out fixes the maximum sell amount and the fee in the script. A BTC remainder below dust
  is forfeited. A deposit that is too small can't fill and refunds after the deadline.

| Leaf | Spend condition |
|---|---|
| Fill | Before the deadline. The output to `receive_address` carries ≥ `input × min_rate` of `buy_asset` (net of fee), plus dust funded from the input. Exact-out orders return unused input to `refund_address` in the same transaction. |
| Refund (anyone) | After the deadline (`OP_CHECKTIME`). Everything goes to `refund_address`. |
| Refund (key) | `[refund_pubkey, arkd]`, any time: the user cancels. No emulator needed. |
| Exit (L1) | `refund_pubkey` + CSV |

- Using a minimum *rate* instead of a minimum amount handles users who send a little more or less than asked.
  The covenant reads the deposit amount from the coin. The emulator rejects a forged sats
  value; a forged token amount is caught only by arkd's asset validation (§10).
- **Refund key:** the Striker web page generates `refund_pubkey` in the browser and asks the
  user to save it. Without it, the funds are still refunded while Arkade is up. The key only
  matters for an L1 exit if Arkade disappears inside the deadline window.
- **Price improvement:** the covenant enforces only the minimum, like Uniswap's
  `amountOutMinimum` + `deadline`. Striker passes improvement to the user and charges only
  `fee_bps`. The maker's signed rate is in the fill transaction's witness, so anyone can check
  maker rate against user rate. The web app shows both.

## 6. Dust rule

Quoted amounts never include carrier dust. Every output's dust is paid by whoever owns that
output. The dust value comes from arkd's `/v1/info` at runtime (currently 330 sats on mainnet and Mutinynet).

| Taker action | Taker outputs |
|---|---|
| Sell Y of S sats for stables | stables + **D** (taker's sats) · BTC change `S − Y − D − fee` (dropped and sold if below dust) |
| Spend a whole token VTXO, buy X sats | BTC `X + D` (own dust returned) |
| Spend part of a token VTXO, buy X sats | BTC `X` (≥ dust) · token change + `D` |

Maker side: the change carries the same dust as the input, so the fill arithmetic cancels
it out (§4).

## 7. Settlement and batching

- Striker streams the book (all live quotes plus offer VTXOs) over SSE/WebSocket. Clients
  compute the top of the book locally (T1, T2). Anyone can check each offer against Arkade.
- **Batching:** Striker collects orders for a short window (~100–300 ms) and settles many
  takers against one maker VTXO, or several makers, in one transaction. This is how
  contention on a single maker VTXO is solved. It is the core of Striker's value.
- Swap-covenant takers don't sign anything, so batching them is easy. Direct-fill takers must
  each sign the final transaction. If someone misses the signing timeout, the batch is
  rebuilt without them.
- Batch size is bounded by arkd's `maxTxWeight` (40 000 WU), checked after the emulator
  signs. Measured with the spike scripts: 1 maker + 56 takers, or 9 makers + 1 taker, per tx.
  Each maker input costs ≈ 4 090 WU (scripts and witnesses are in the OP_RETURN emulator
  packet at 4 WU/byte), each plain-wallet taker ≈ 630 WU. A smaller Fill script raises the
  maker count. The emulator also caps a request at 64 intent-gated inputs and 200
  `OP_CHECKSIGFROMSTACK` checks.
- One emulator `SubmitTx` (script, sign, arkd submit and finalize) takes p50 15–25 ms, flat
  with chain depth.
- When a maker VTXO is spent by a competing transaction, the single-spend rule rejects the
  loser. Striker re-sweeps and retries.
- Chained fills inherit the inputs' earliest VTXO expiry. Renewal is covered in §8.
- arkd has no limit on off-chain chain depth (1 000 chained fills accepted without a batch).
  Depth costs at exit time instead: unrolling a VTXO at depth d publishes d ark txs plus d
  checkpoints, each needing a fee bump.

## 8. Renewal (VTXO expiry)

VTXOs expire with their batch. Off-chain transactions don't reset expiry; only joining a new
batch does. Covenant VTXOs have no single owner to sign that, so they carry a **Renew** leaf,
based on the emulator's non-interactive delegate pattern (`test/delegate_test.go`):

- `OP_INSPECTINTENTMESSAGE` limits the leaf to batch-registration intents, with no on-chain
  outputs and Striker as the only cosigner.
- `OP_TUNNEL` forces the paired output to keep the same script, value and assets.
- The leaf also checks `OP_PUSHEXPIRY <window> OP_SUB OP_CHECKTIME OP_VERIFY`, so renewal is
  only possible inside the window, and pins Striker's tree-signer key as the only cosigner.
  That key must be stable: rotating it means every owner re-deposits. SDK 0.4.79 only
  offers random signer sessions, so Striker needs a deterministic one.
- Striker acts as delegate and renews offer covenants before expiry, and also after N fills,
  since renewal resets chain depth to 1 and keeps L1 exits cheap. Swap covenants are short-lived and normally settle or
  refund before needing renewal.
- **Fees: renewal is free inside the server's renewal window.** arkd's intent fee program
  charges an off-chain VTXO input 0.2 % only while it still has a long life left:
  `inputType == 'vtxo' && expiry - now() > W ? amount * 0.002 : 0.0`. W is 2 505 216 s
  (≈ 29 days) on mainnet and 518 656 s (≈ 6 days) on Mutinynet, and `txFeeRate` is 0 on both
  (checked against `/v1/info`, 2026-11-17). So Striker renews only within the last W seconds
  before expiry, and `OP_TUNNEL`'s exact-value rule holds. Striker reads the fee program at
  runtime and skips renewal if it would cost anything.
- **Fallback: a fee-capped Renew leaf** (`OP_TUNNEL` flags 5 plus `out.value ≥ in.value − maxFee`).
  arkd's fee is `Σin − Σout`, so an exact-value renewal fails as soon as a server charges
  anything (spike: `INTENT_INSUFFICIENT_FEE … got 0 min expected 200`). A change to the fee
  program would otherwise strand covenant VTXOs. The spike renewed a sats + USD covenant through
  a real batch this way.

## 9. Fees

Takers pay `fee_bps` as an explicit output to Striker in every settlement. Makers pay
nothing. In swap covenants the fee is part of the covenant check. In direct fills it is in
the transaction the taker signs.

## 10. Trust model

| Risk | Protected by | Trust in Striker |
|---|---|---|
| Theft, over-fill, wrong asset, underpayment | Covenant + quote signature | None |
| Filling an expired quote | `OP_CHECKTIME` (emulator clock) | None |
| Filling a superseded but unexpired quote | Striker policy | **Bounded by quote lifetime** |
| Emergency cancel | Owner leaf epoch bump or withdraw | None |
| Price improvement kept by Striker | Visible in witness, checked by the web app | Execution quality only |
| Striker or emulator offline | Swap refunds after the deadline; owner leaves | Liveness only |
| Arkade offline | L1 exit leaves (owner key + CSV) | None |
| Asset amounts forged or dropped from a tx | arkd asset validation (`OP_TUNNEL` and asset introspection only see the tx's own packet) | None in Striker; trust in arkd |

The quote lifetime is the maker's choice of how much to trust Striker. A maker bot re-signs
every few seconds at no cost.

## 11. Order types

| Feature | Enforced by |
|---|---|
| Limit price | Script (quote rate) |
| Good-till-cancelled | Script (long expiry); cancel with an epoch bump or withdraw |
| Good-till-time | Script (`OP_CHECKTIME`) |
| Fill-or-kill | Atomic transaction |
| Immediate-or-cancel | Client sweeps what's available, then stops |
| Min fill size | Script (`min_fill`) |
| Post-only | Striker rule: reject orders that would cross |

Breaking a rule that only Striker enforces can execute an order in an unwanted way. It can't
make anyone lose funds outside their own signed terms.

## 12. Wallet

- Simple flow: no wallet needed. The user pays from any Ark wallet.
- Advanced flow: our in-browser **hot** wallet, clearly labelled as such.
  - A passkey is the default (WebAuthn PRF output encrypts or derives the seed). Synced
    passkeys double as recovery.
  - A mandatory seed-phrase backup prompt. A password fallback where PRF is unsupported.
- Later: external wallet connectors (e.g. inscrib3). It is still unclear what signing API
  Arkade wallets expose.

## 13. Spike plan

Before any service code, prove the covenants against the emulator and arkd on regtest:

1. **Quote validity:** CSFS signature, epoch match, expiry rejects late fills and accepts timely ones.
2. **Late submission:** a transaction co-signed just before expiry and submitted to arkd later.
   Does the emulator submit itself, or can a signed transaction be held?
3. **Floor:** holds across three chained partial fills. `min_fill` is enforced.
4. **Epoch bump** via the owner leaf cancels all outstanding quotes.
5. **Two-asset offer VTXO:** sats plus demo USD on one covenant VTXO (expected to work). Fills in both directions.
6. **Two makers, several takers, one transaction:** index pairing prevents counting one output twice. Measure the size limit.
7. **Dust:** sell everything but dust, buy back with a whole token VTXO, exact sats both ways.
   A transaction where the taker pays the maker's dust is rejected.
8. **Swap covenant:** fill at or above `min_rate`, exact-out with unused input returned,
   refund after the deadline, key refund.
9. **Renew leaf:** Striker renews an offer covenant through a batch. Off-chain misuse is rejected.
10. **Off-chain chain depth:** how many chained unconfirmed fills arkd accepts.
11. **L1 exit:** unroll an offer covenant and spend the exit leaf.

## 14. Open questions

- Signing-round timeout for direct-fill batching.
- Whether arkd rejects an asset left out of a tx's asset claim entirely (the swap covenant's
  "no assets on a BTC deposit" check relies on it).
- Shrinking the Fill script (direction byte, one-direction leaves) to fit more makers per tx.
- Default quote lifetime for maker bots.
- External wallet signing API.

## 15. Spike results

All 35 tests pass on regtest (arkd v0.9.16, emulator v0.0.9-rc.2-striker.1); see `spike/`.

| §13 item | Result |
|---|---|
| 1 Quote validity | ✔ bad signature, wrong epoch, expired and underpaying fills refused |
| 2 Late submission | ⚠ possible via batch intents and via leaves with a key after the emulator; closed by the offchain-only gate and `[server, emulator]` leaves (§2) |
| 3 Floor | ✔ holds across 3 chained partial fills; `min_fill` enforced |
| 4 Epoch bump | ✔ owner-leaf self-spend cancels all old quotes |
| 5 Two-asset offer VTXO | ✔ fills in both directions, payments land in the change |
| 6 Two makers, several takers | ✔ index pairing blocks shared-output attacks; 56 takers per maker, 9 makers per tx |
| 7 Dust | ✔ exact sats both ways; maker never pays taker dust and vice versa |
| 8 Swap covenant | ✔ fill at/above `min_rate`, fee, exact-out, deadline refund, key refund |
| 9 Renew leaf | ✔ through a real batch with the fee-capped variant; exact-value needs a fee-free window (blocked only by regtest's 1 % fee) |
| 10 Chain depth | ✔ no limit (1 000 deep), 15–25 ms per fill |
| 11 L1 exit | ✔ 3 unroll packages (~0.7 k sats) + 146 vB owner-only exit after the CSV |
