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
- **Covenant leaves are exactly `[server, emulator]`** (the Renew leaf adds Striker's key in
  front, §8). If any other key comes after the emulator key, the emulator is not the finalizer and hands its signatures back to the caller,
  who can then submit them to arkd after a quote has expired.
- **Every covenant leaf except Renew is offchain-only:** the offer Fill leaves and the swap
  Fill and Refund-anyone leaves. Each starts with `OP_PUSHEXPIRY OP_DROP "type"
  OP_INSPECTINTENTMESSAGE OP_NOT OP_VERIFY OP_DROP`. The emulator signs on three paths, and two
  of them hand the signature back to the caller: `SubmitIntent` (batch intents) and
  `SubmitOnchainTx` (on-chain txs, which checks prevouts only by hash, so a batch-intent proof
  with its synthetic BIP322 prevout passes as one). A proof signed either way before expiry (or a
  deadline) can be held and settled in a batch later, because the batch path never re-runs the
  script; merely registering it also locks the VTXO against every other spend. The intent check
  stops the first path; `OP_PUSHEXPIRY` stops the second, because only the offchain and intent
  paths know the VTXO's expiry ("OP_PUSHEXPIRY expiry not set"). What remains is `SubmitTx`,
  which validates, signs, submits and finalizes in one call. `30-emulator-late` settles a held
  on-chain-signed proof after expiry against an intent-only gate, and shows the full gate
  refusing it. The swap covenant missed the gate entirely at first (review, 2026-11-18).

## 3. Signed quote

```
Quote {                 // 40 bytes, five u64 LE fields (< 2^63)
  rate_num, rate_den  // buy_amount ≥ sell_amount × rate_num / rate_den
  floor               // remaining sell-side balance must stay ≥ floor
  min_fill            // smallest sell amount per fill
  expiry              // unix seconds, checked with OP_CHECKTIME
}
tag = "striker/quote/v2" ‖ maker_pubkey(32) ‖ epoch(u64 LE) ‖ asset_id(34) ‖ side(1)
```

- The maker signs off-chain: BIP340 over `tagged_hash(tag, quote)`. Everything that ties a
  quote to one covenant — protocol version, maker key, epoch, the traded asset and the side
  (0 = maker sells BTC, 1 = maker sells the asset) — is in the tag, not in the message. Each
  Fill leaf carries `SHA256(tag)` for its own side as a 32-byte constant, rebuilds the tagged
  hash (`DUP CAT SWAP CAT SHA256`) and checks it with `OP_CHECKSIGFROMSTACK` against the maker
  key. A quote signed for another epoch, another asset or the other side therefore fails as a
  bad signature; the message carries only the five numbers. Asset ids are serialized as the SDK
  does (txid ‖ u16 LE gidx).
- Fields stay u64: a u32 expiry would stop working in 2038 (BIN2NUM reads the top bit as a
  sign), and u32 rate or amount fields would cap rates and balances for other asset decimals;
  the saving would be 16–32 WU per maker input.
- Fields are u63 in practice: BIN2NUM reads a set top bit as a sign, and a negative floor,
  `min_fill` or rate would void its check (a negative `rate_num` sells for nothing). The
  signer refuses such values and the Fill leaf range-checks each field (`rate_num`, `rate_den`,
  `min_fill` > 0; `floor` by its top byte, since `00…00 80` is negative zero and reads as 0; a
  negative expiry already fails), so a third-party signer that skips the rule can't be filled
  on such a quote.
- **Floor instead of maximum.** "Up to X" could be reused on every chained change VTXO. A
  balance floor bounds what a chain of partial fills can take from *one* VTXO, with no extra
  state. It is not a cumulative cap: two VTXOs at the same offer address can each be filled
  down to the floor, and a fill in the other direction refills the balance, after which the
  same quote applies again. Every fill is still at the maker's signed rate. The maker bot keeps
  one VTXO per offer address (consolidating through the Owner leaf, or bumping the epoch, before
  quoting after a deposit) and sizes quotes against that one balance.
- **Expiry.** `<expiry> OP_CHECKTIME OP_NOT OP_VERIFY` means "valid only before expiry",
  judged by the emulator host's wall clock. The emulator already co-signs every spend, so this
  adds no new trust. It holds only together with the offchain-only gate (§2).
- **Epoch.** It is part of the covenant script (inside each Fill leaf's `SHA256(tag)` constant,
  so the address changes with it). A self-spend into a covenant with `epoch+1`
  cancels every outstanding quote at once.

## 4. Offer covenant

One VTXO holds the maker's liquidity, and it may carry **both** assets: sats plus demo USD.
Payments flow into the change output instead of a separate maker output. The maker never
funds new dust, and proceeds can immediately back offers on the other side.

**Leaves**

| Leaf | Spend condition |
|---|---|
| Fill sell-BTC | Valid quote for this side (signature over the side's tag, expiry) + the fill rules below |
| Fill sell-asset | Same, the other direction |
| Owner | Maker key: withdraw, re-price, epoch bump |
| Renew | Striker only (`[striker, arkd, emulator]`): batch registration only, script and value preserved. Proven on a separate test covenant; the prototype adds it to the offer tree. |
| Exit (L1) | Maker key + CSV |

**Fill rules** for maker input `i`, change at its paired output (fixed index pairing, so two
makers can never count one output):

```
change.script == input.script                    // same covenant, same epoch (OP_TUNNEL)
sold     = input.sell_bal − change.sell_bal
received = change.buy_bal − input.buy_bal
sold     ≥ quote.min_fill
received × rate_den ≥ sold × rate_num            // rounded in the maker's favour
rate_num, rate_den, min_fill > 0; floor < 2^63  // range checks (fields are u63)
change.sell_bal ≥ quote.floor
all other assets preserved exactly            // OP_TUNNEL flags 5, traded token excepted
```

- `floor` on the sats side must be ≥ dust, and `min_fill` > 0.
- The change is the output with the same index as the maker input (`PUSHCURRENTINPUTINDEX`).
  The spike's attack transactions that tried to make two makers count one output were refused.
- `OP_INSPECT*ASSET*` take the asset txid byte-reversed relative to the SDK's `AssetId.txid`.
- One Fill leaf per side: the emulator packet carries only the executed leaf's script, so each
  leaf holds one direction's arithmetic and the asset id once (parked on the altstack for the
  two lookups and the `OP_TUNNEL` exception). Each Fill leaf in the spike is 219 bytes with a
  104-byte witness (was one 644-byte two-direction leaf with a 212-byte witness). Owner leaf
  `[maker, arkd]` (epoch bump and withdrawal need no emulator). Exit leaf maker + CSV 1536 s.

Balances are sats (`OP_INSPECTINPUTVALUE` / `OP_INSPECTOUTPUTVALUE`) or asset amounts
(`OP_INSPECT*ASSET*`). The covenant never looks at taker outputs, so any number of takers
can share one maker fill (§7).

## 5. Swap covenant (simple flow)

A deposit address made for one order. The user pays it from any Ark wallet (e.g.
arkade.money, which sends both BTC and assets).

Parameters: `receive_address`, `refund_address`, `fee_address`, `sell_asset`, `buy_asset`,
`min_rate` (buy units per sell unit, **net of the fee**), `fee_bps`, `deadline` (≈ 10 min),
`refund_pubkey`, optional `want` (exact-out amount).

- `min_rate` works like Uniswap's `amountOutMinimum`: it is what the user gets per unit given
  up, fee included. Striker sets `min_rate = maker_rate × (1 − fee) × (1 − slippage)`.

- Output positions: swap input `i` of `n` pays receive at output `i` and any exact-out refund at
  `i + n`. The fee output index is the only witness item.
- The fee is in sats: `ceil((input − D) · bps)` for BTC → token, taken out of the deposit, and
  `ceil(floor(U · min_rate) · bps)` for token → BTC, paid by the maker on top of the user's sats.
  Either way the user's side of the check is net: `tokens ≥ (input − D) · min_rate`, or
  `sats received ≥ U · min_rate`.
- A fee below 330 sats must go to the fee key's `OP_RETURN <key>` sub-dust form; arkd
  rejects other outputs below dust.
- Exact-out fixes `max_spend = floor(want / min_rate)` (rounded in the user's favour, fee
  included on the BTC side) and the fee in the script. Every unspent sat goes back; a
  remainder below dust as the refund key's `OP_RETURN <key>` sub-dust output.
  A deposit below `max_spend` only fills if a maker accepts the better rate; otherwise it refunds
  after the deadline.

| Leaf | Spend condition |
|---|---|
| Fill | Offchain only, before the deadline. The output to `receive_address` carries ≥ `input × min_rate` of `buy_asset` (net of fee), plus dust funded from the input. Exact-out orders return unused input to `refund_address` in the same transaction. |
| Refund (anyone) | Offchain only, after the deadline (`OP_CHECKTIME`). Everything goes to `refund_address`. |
| Refund (key) | `[refund_pubkey, arkd]`, any time: the user cancels. No emulator needed. |
| Exit (L1) | `refund_pubkey` + CSV |

- Using a minimum *rate* instead of a minimum amount handles users who send a little more or less than asked.
  The covenant reads the deposit amount from the coin. The emulator rejects a forged sats
  value; a forged token amount is caught only by arkd's asset validation (§10).
- A BTC deposit that also carries an asset can't fill (`INSPECTINASSETCOUNT == 0` fails). A
  fill that leaves the asset out of the packet to pass that check is rejected by arkd. The
  deposit refunds after the deadline with the asset intact.
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
  signs. Measured with the spike scripts: **1 maker + 59 takers**, or **19 makers + 1 taker**,
  per tx. Each maker input costs ≈ 1 950 WU (the 219-byte Fill leaf and 104-byte witness travel
  in the OP_RETURN emulator packet at 4 WU/byte, plus input and change), each plain-wallet taker
  ≈ 630 WU; a 1 maker + 1 taker fill is ~3 000 WU. The emulator also caps a request at 64
  intent-gated inputs and 200 `OP_CHECKSIGFROMSTACK` checks, neither of which binds.
- One emulator `SubmitTx` (script, sign, arkd submit and finalize) takes p50 22–30 ms (p95 25–34 ms)
  for a single-input self-spend on a fresh arkd v0.9.25 stack, flat with chain depth. On a stack
  with many earlier runs it rose to p50 ~60–80 ms. A 1 maker + 1 taker fill with an asset packet
  measured p50 ~80 ms on such a stack. The cause is arkd's postgres event store: it loads an
  off-chain tx's events with `SELECT payload FROM watermill_offchain_tx WHERE payload->>'Id' = $1`,
  and that column has no index, so every lookup scans and parses the whole table (~9 µs per event,
  3 events per tx, about one lookup per event). At 1 461 events a lookup took 13.4 ms; with an
  expression index on `(payload->>'Id')` it took 0.12 ms. Latency therefore grows linearly with
  arkd's lifetime tx count on the regtest stack. Production arkd is assumed to run a setup without
  this; worth checking if fill latency on a real deployment looks off.
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
  That key must be stable: rotating it means every owner re-deposits. SDK ≥ 0.5.4 exports a
  deterministic `TreeSignerSession` (constructed from a secret), so the pinned key is stable;
  a fresh session is still built per batch, since musig2 nonces must never be reused.
- The Renew leaf is `[striker, arkd, emulator ⊕ renewScript]`: only Striker can produce a
  registrable renewal proof (arkd refuses one without Striker's signature, `missing signature`),
  so nobody else can register a renewal and lock the VTXO against fills. Striker also signs the
  forfeit in the batch. The leaf is batch-only, so key order doesn't matter for `SubmitTx`
  finalization; in the batch the emulator signs the proof and forfeit and returns them, and
  Striker's batch handler submits them. This is a trusted role: Striker could refuse to renew,
  but can't move funds.
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
- **Fallback: a fee-capped Renew leaf** (`OP_TUNNEL` flags 5 plus `out.value ≥ in.value − maxFee`,
  and exactly two proof outputs so the slack can only go to arkd as fee, never to an extra
  output; with the leaf pinned to Striker's key, only Striker could make it overpay).
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
| Filling an expired quote | `OP_CHECKTIME` (emulator clock) | None in Striker; the emulator operator's clock decides expiry and deadlines |
| Filling a superseded but unexpired quote | Striker policy | **Bounded by quote lifetime** |
| Emergency cancel | Owner leaf epoch bump or withdraw | None |
| Price improvement kept by Striker | Visible in witness, checked by the web app | Execution quality only |
| Striker or emulator offline | Swap refunds after the deadline; owner leaves | Liveness only |
| Arkade offline | L1 exit leaves (owner key + CSV) | None, if the owner saved the exit data (the VTXO's virtual-tx ancestry) while Arkade was up; the SDK's exit-data capture does this, the spike's exit fetched it from the indexer. Assets on L1: open (§14) |
| arkd changes its fee program or dust limit | L1 exit leaves | Exact-value spends (fills, refunds, renewals) stop working until covenants are rebuilt; funds stay recoverable |
| Asset amounts forged, omitted or over-claimed in a tx | arkd asset validation: each input's packet claims must equal the VTXO's assets exactly (`OP_TUNNEL` and asset introspection only see the tx's own packet) | None in Striker; trust in arkd |

arkd checks the packet against the spent VTXOs in both directions (spike `50-asset-claims`).
Every asset an input holds must be claimed for that input at exactly the held amount. Every
claim must name an asset the input holds. Outputs get only the assets the packet declares, and
anything undeclared is burned. So inside a tx the emulator co-signs, an input's packet claims
*are* its assets. The swap covenant's "no assets on a BTC deposit" check and the offer
covenant's `OP_TUNNEL` "other assets preserved" are sound, given arkd.

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
- Default quote lifetime for maker bots.
- External wallet signing API.
- Assets after an L1 exit. The exit spend can carry the asset packet on to the owner's output
  (`40-renew` does), and Bitcoin accepts it, but nothing in the stack indexes L1 asset
  transfers (arkd only tracks coins it signed or watched), so it is unclear how the owner
  would use or re-board those units. Needs an answer from Arkade before mainnet.

## 15. Spike results

All 57 tests pass on a fresh regtest stack (arkd v0.9.25 with a standalone signer and postgres+redis,
upstream emulator v0.0.10-rc.0, `@arkade-os/sdk` 0.5.6); see `spike/`.

| §13 item | Result |
|---|---|
| 1 Quote validity | ✔ bad signature, wrong epoch, expired and underpaying fills refused |
| 2 Late submission | ⚠ possible via batch intents, via the emulator's on-chain endpoint and via leaves with a key after the emulator; closed by the `OP_PUSHEXPIRY` + intent gate and `[server, emulator]` leaves (§2) |
| 3 Floor | ✔ holds across 3 chained partial fills; `min_fill` enforced |
| 4 Epoch bump | ✔ owner-leaf self-spend cancels all old quotes |
| 5 Two-asset offer VTXO | ✔ fills in both directions, payments land in the change |
| 6 Two makers, several takers | ✔ index pairing blocks shared-output attacks; 59 takers per maker, 19 makers per tx (one-direction 219-byte Fill leaves, 40-byte quote) |
| 7 Dust | ✔ exact sats both ways; maker never pays taker dust and vice versa |
| 8 Swap covenant | ✔ fill at/above `min_rate` (net of fee), fee, exact-out, deadline refund, key refund, uneven amounts; Fill and Refund-anyone refuse batch intents |
| 9 Renew leaf | ✔ exact-value renewal settles fee-free through a real batch inside the fee window; the fee-capped variant also renews sats + USD through a batch |
| 10 Chain depth | ✔ no limit (1 000 deep), ~30 ms per fill |
| 11 L1 exit | ✔ 3 unroll packages (~0.7 k sats) + owner-only exit after the CSV, carrying the asset packet; L1 asset recovery is open (§14) |
