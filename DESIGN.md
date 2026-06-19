# Striker — Design

**An intent-based swap protocol on Arkade, modeled on NEAR Intents, settled with recursive covenants.**

This document specifies the mechanism. The [README](./README.md) is the narrative overview.

---

## 1. Mental model

Striker is the Bitcoin-native analog of [NEAR Intents](https://docs.near-intents.org). The
correspondence is exact enough to be worth stating up front, because every design decision below
falls out of it:

| NEAR Intents                                              | Striker                                                                                    |
|-----------------------------------------------------------|--------------------------------------------------------------------------------------------|
| Solver signs a `token_diff` intent                        | Maker signs a quote message `M`, verified on-chain via `OP_CHECKSIGFROMSTACK`              |
| Solver's stable fungible balance in the Verifier contract | Maker's **recursive covenant** VTXO — balance is the VTXO value, carried forward as change |
| Per-account nonce bitmap (single-use)                     | An **epoch** (standing-order) or nonce-bitmap carried in the covenant's extension packet   |
| Global salt rotation (admin-gated bulk cancel)            | Maker **bumps its own epoch** — per-lineage, self-sovereign cancel                         |
| `execute_intents` atomic check-and-debit                  | **Arkade VTXO single-spend** — a consumed deposit can't be double-filled                   |
| Verifier contract **validates and executes**              | **Split**: the Emulator *validates* (stateless), `arkd`/Arkade *executes*                  |
| Nonce state lives in contract storage                     | State lives **on-chain in the covenant packet** — no party's database                      |

The headline difference: NEAR keeps accounting in *contract state*; Striker pushes it onto the
*UTXO set itself*. No component has to remember anything — the chain carries it.

---

## 2. Components and trust

- **Maker** — liquidity provider. Deposits an asset (e.g. USDT) into a recursive covenant VTXO and
  signs quote messages off-chain. Fully self-sovereign: can withdraw or requote at any time via a
  key path. Need not be online to be filled — a pre-signed quote plus the covenant is enough.
- **Taker / User** — wants to swap. Requests a quote from Striker, locks funds in a user covenant,
  receives the counter-asset. Can be offline during settlement.
- **Striker** — **untrusted** quote-router and matcher. Follows maker deposit lineages, collects
  quotes, matches taker orders, and constructs settlement transactions. Cannot steal or alter terms
  (the covenants + Emulator enforce them). Worst case: it goes down and users fall back to manual
  interaction.
- **Emulator** — **stateless** co-signing oracle ([arkade-os/emulator](https://github.com/arkade-os/emulator)).
  A VTXO's tapscript commits to a tweaked key `emulator_key + hash(arkade_script)`; the Emulator's
  signature is only obtainable if the candidate spend passes the committed Arkade Script. It
  validates and returns its signature; the caller settles via `arkd`. It **holds no state**, cannot
  steal (it won't sign an invalid covenant), and its only abuse is censorship — for which the
  backstop is the Arkade unilateral exit to L1.

---

## 3. The maker liquidity covenant

A single VTXO holding `balance` of the give-asset (the asset the maker is *selling*, e.g. USDT) at a
**fixed scriptPubKey** that is stable across the entire lineage.

### 3.1 What is fixed vs. mutable

- **Fixed script parameters** (baked into the script, define the address):
  `maker_pubkey`, `emulator_key`, `lineage_id` (a maker-chosen deposit id — the "original VTXO" the
  maker declares so Striker knows where to start following), `give_asset_id`.
- **Mutable state**:
    - `balance` — carried as the **native VTXO value** (introspected via `OP_INSPECTINPUTVALUE` /
      `OP_INSPECTOUTPUTVALUE`). No packet needed.
    - `epoch` — carried in an **extension packet** (`OP_INSPECTINPUTPACKET` reads the prior value,
      `OP_INSPECTPACKET` reads the new value). Putting state in the packet rather than the script
      bytecode is what keeps the scriptPubKey — and therefore the address — fixed across the lineage.

### 3.2 The quote message

```
M = sign_maker(
      lineage_id,        // which deposit this quote is scoped to
      give_asset, X,     // maker gives X of give_asset
      want_asset, Y,     // maker wants Y of want_asset ...
      want_address,      // ... paid to this address
      epoch e,           // only fillable while the covenant is at epoch e
      deadline           // hard expiry (keep short — this is the staleness window)
    )
```

The maker signs this off-chain and hands it to Striker. It is **not** posted on-chain.

### 3.3 Spend paths

**(a) Fill** — CSFS + introspection, no maker signature on the tx itself:

1. `OP_CHECKSIGFROMSTACK` verifies the maker signed `M` (against `maker_pubkey`).
2. The input packet's `epoch == e` from `M` (quote matches the live epoch).
3. An output pays `X` of `give_asset` to a recipient Striker designates (`M` does **not** bind the
   counterparty — that is the fungibility, mirroring NEAR's "signed deltas, not counterparty").
4. An output pays `Y` of `want_asset` to `want_address`.
5. **Change** output: value `= input_value − X`, scriptPubKey `==` input scriptPubKey (recursive),
   packet `epoch == e` (unchanged on a fill).
6. `deadline` not passed.

Because the change reproduces the covenant at the same epoch, a quote is a **standing order**:
fillable repeatedly (each fill draws down `balance`) until the balance drains, the deadline passes,
or the maker bumps the epoch.

**(b) Requote / cancel** — maker key path. The maker self-spends, reproduces the covenant (same
scriptPubKey, same value), and bumps the packet `epoch e → e+1`. Every epoch-`e` quote dies at once.
This is NEAR's salt rotation, except **per-lineage and maker-controlled** rather than global and
admin-gated.

**(c) Withdraw** — maker key path. Reclaim all or part of `balance` to an arbitrary address. Pulls
liquidity. (Change, if partial, reproduces the covenant.)

### 3.4 Single-use variant (optional)

The standing-order/epoch model above is the recommended v1 — a market maker fundamentally wants a
resting quote, and NEAR's per-intent single-use is a settlement-accounting artifact we don't need.

If true per-quote single-use is ever required, replace the `epoch` scalar with a **nonce bitmap** in
the packet (each fill flips one bit, asserts it was unset). This is exactly NEAR's per-account
bitmap, and is equally expressible — `counter_contract_test.go` demonstrates the state-transition
machinery. Cost: more packet state, finite slots, more complexity. Defer unless needed.

---

## 4. The user (taker) covenant

The user locks the give-side they are selling (e.g. 100 BTC) in a covenant with two paths:

**(a) Settlement** — Emulator-validated introspection: the spend is allowed only if an output pays
the user **≥ the quoted amount** of the want-asset. This lets Striker complete the swap while the
user is offline.

**(b) Refund** — user key path, **non-timelocked**. The user reclaims their funds at any time the
VTXO has not yet been consumed. The settlement-vs-refund race is resolved by Arkade single-spend
(symmetric to the maker's withdraw path); no timelock is needed because the user is spending their
*own* output back. The Arkade unilateral exit is the ultimate backstop.

---

## 5. Settlement

A single atomic transaction. Partial-fill aggregation falls out for free by including several maker
inputs.

```
inputs:
  maker covenant VTXO(s)        # one per maker contributing liquidity
  user covenant VTXO            # the taker's locked funds
outputs:
  want_asset  → user            # ≥ quote (satisfies the user covenant)
  give_asset  → maker want_addr # one per maker (satisfies each maker covenant)  [for BTC→USDT this is BTC]
  give_asset  → maker covenant  # change, reproduces each maker covenant (recursive)
  fee         → Striker         # taker-pays, basis points
```

Flow: Striker builds the tx → the Emulator validates every covenant and returns its signatures →
Striker (or the Emulator, if it is the last required signer) settles via `arkd`. Arkade's
single-spend rule is the atomic check-and-debit: any concurrent fill against the same maker VTXO
fails because the VTXO is already consumed — losing quotes simply don't settle, exactly as
overdrawn intents revert on NEAR.

---

## 6. Striker's job: lineage tracking

The maker declares its original deposit VTXO. Because every fill's change output reproduces the same
scriptPubKey, Striker walks the chain by script-match:

```
O₀  (original deposit, declared by maker)
 └─ fill → [ X→taker, Y→maker, change→O₁ (same script, epoch e) ]
      └─ fill → [ … , change→O₂ (same script, epoch e) ]
           └─ … tip = current unspent VTXO; its value = remaining balance
```

The tip's value is the live balance; the tip's packet is the live epoch. This replaces the old
"index discrete limit-order VTXOs into an orderbook" — now it's "follow each maker's deposit
lineage." Anyone can do this; it is public. Striker does it for matching, the maker does it to track
its own inventory.

**Throughput note:** fills against one deposit are lineage-sequential (each consumes the tip; the
next chains off the change). For parallel fill capacity a maker runs **multiple independent
deposits** = multiple lineages filled concurrently.

---

## 7. Cancellation & staleness

A standing quote can't be cheaply cancelled mid-flight; the levers are:

- **Short deadlines** — the primary tool. NEAR leans on this too (its routine cancel is nonce-
  deadline expiry, not the admin salt rotation). The deadline is the maker's price-staleness
  exposure window — keep it to tens of seconds.
- **Epoch bump** — one on-chain self-spend bulk-cancels all of a lineage's outstanding quotes.
- **Withdraw** — removes the liquidity entirely.

---

## 8. Arkade primitives used

All confirmed present and tested in [arkade-os/emulator](https://github.com/arkade-os/emulator):

| Primitive                                 | Opcode / mechanism                                                                                     |
|-------------------------------------------|--------------------------------------------------------------------------------------------------------|
| Maker quote verification                  | `OP_CHECKSIGFROMSTACK` (0xcc)                                                                          |
| Pay `X`/`Y` to designated outputs         | `OP_INSPECTOUTPUTVALUE` (0xcf), `OP_INSPECTOUTPUTSCRIPTPUBKEY` (0xd1)                                  |
| Read own input (value, script, outpoint)  | `OP_INSPECTINPUTVALUE` (0xc9), `OP_INSPECTINPUTSCRIPTPUBKEY` (0xca), `OP_PUSHCURRENTINPUTINDEX` (0xcd) |
| Recursive covenant (change → same script) | `OP_INSPECTOUTPUTSCRIPTPUBKEY == OP_INSPECTINPUTSCRIPTPUBKEY`                                          |
| Carry epoch / nonce state                 | extension packet via `OP_INSPECTINPUTPACKET` (0xf5) / `OP_INSPECTPACKET` (0xf4)                        |
| `balance − X`, `X · rate`                 | BigNum arithmetic — `OP_SUB`, native `OP_MUL`/`OP_DIV`/`OP_MOD`, no 32-bit cap                         |
| Asset (USDT) leg                          | asset packets/opcodes — see `asset_account_covenant_test.go`                                           |

Reference worked examples in the emulator repo: `recursive_covenant_test.go` (recursive change),
`counter_contract_test.go` (state-carrying recursion), `asset_account_covenant_test.go` (multi-party
USDT routing with balance accounting), `htlc_test.go`, `delegate_test.go`.

**Caveat:** these are enforced by the Emulator's software VM under the tweaked-key co-signing trust
model, not (yet) by on-chain Bitcoin consensus. The authoritative spec is the Arkade Script docs and
the `arkd`/`ark-lib` extension code.

---

## 9. Open questions / v2

- **Rate-based quotes.** BigNum multiplication makes `required_Y = X · rate` expressible, so a single
  signed quote could fill any `X` up to `balance` at a fixed rate (rather than a fixed `(X, Y)`
  pair). Feasible now; evaluate whether it simplifies the maker's quoting loop.
- **Multi-hop routing** (BTC → USD → EUR) by chaining settlement legs across lineages.
- **Maker-to-maker matching** — two crossing standing quotes settled directly.
- **Fee accounting / volume tiers** — XPUB registration to track trades and discount taker fees.
- **Nonce-bitmap single-use mode** — if a concrete need for single-use quotes emerges (§3.4).
- **Trust-minimized enforcement** — track whether Arkade moves covenant enforcement from the
  Emulator's software VM toward on-chain consensus.
