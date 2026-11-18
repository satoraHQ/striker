# v2 covenant spike

Proves the covenants in `DESIGN.md` §13 against arkd + the upstream emulator on regtest.
57/57 green on a fresh arkd **v0.9.25** (standalone signer, postgres + redis), upstream emulator
**ghcr.io/arkade-os/emulator:v0.0.10-rc.0**, `@arkade-os/sdk` **0.5.6**, arkade-regtest `7c91a6b`.

```sh
npm run regtest -- start            # pulls the images named in .env.regtest
CHAIN_DEPTH=200 npm run spike       # all spike tests, sequential (--test-concurrency=1)
node --import tsx --test spike/00-smoke.test.ts
```

`harness.ts` holds the shared helpers (wallets, faucet, demo USD, covenant trees, submit,
`refused`/`rejectedWith`). Each area owns its own module and test file. Test key indices are
allocated so parallel suites never share wallets:

| Keys | Area | Files |
|---|---|---|
| 10–19 | harness smoke | `00-smoke.test.ts` |
| 20–39 | offer covenant (§13 1, 3, 4, 5, 6) | `offer.ts`, `10-offer*.test.ts` |
| 40–59 | emulator behaviour: late submission, chain depth (§13 2, 10) | `30-emulator*.test.ts` |
| 60–79 | swap covenant + taker dust (§13 7, 8) | `swap.ts`, `20-swap*.test.ts` |
| 80–99 | renewal + L1 exit (§13 9, 11) | `renew.ts`, `40-renew*.test.ts` |
| 100–109 | asset claims vs arkd (§14) | `asset-claims.ts`, `50-asset-claims.test.ts` |

## Findings

- arkd rejects block-based CSV exit leaves (`INVALID_VTXO_SCRIPT: CSV block type not allowed`).
  Exit leaves must use seconds (multiple of 512).

### Stack and SDK (v0.0.9-rc.2-striker.1 → upstream v0.0.10-rc.0, SDK 0.4.79 → 0.5.6)

- **The checkpoint-signature fix is upstream now.** Our local patch (`docker/emulator-checkpoints.patch`,
  built into `striker-emulator:v0.0.9-rc.2-striker.1`) is in v0.0.10-rc.0: the emulator submits
  unsigned checkpoints to arkd and merges arkd's signatures for `FinalizeTx`, so reusable taker
  covenants work on the stock image. The Dockerfile, patch and `.dockerignore` are gone and
  `scripts/regtest.mjs` no longer builds a local image.
- **Covenant failures are no longer logged; they come back in the HTTP error.** The SDK throws
  `Failed to submit <tx|intent> to emulator: {"code":9,"message":"emulate offchain tx ark_txid=…:
  input i: failed to execute arkade script: script=1 opcode=OP_X position=n: <reason>"}` (intents:
  `emulate batch registration proof_txid=…`). Code 9 is gRPC `FailedPrecondition` (a well-formed
  script whose check fails). arkd rejections relayed through the emulator keep arkd's own status
  text (`TX_TOO_LARGE (46): …`, `ASSET_VALIDATION_FAILED (33): …`, `prevout tx value mismatch …`).
  All the docker-log scraping helpers are gone; `harness.ts` parses the returned message once
  (`rejectionOf`) and `refused(fn, /opcode or reason/)` / `rejectedWith(text, fn)` assert on it.
  Only the batch-registration path still *also* logs `arkade script execution failed`.
- **The emulator now names the opcode on a final-stack-check failure** (emulator #188): a leaf that
  ends by leaving a false value on the stack reports e.g. `opcode=OP_GREATERTHANOREQUAL …: final
  script validation failed: false stack entry at end of script execution`, not a bare
  `script returned early`. The swap fee check and the fee-capped renew cap assert on this.
- **arkd ≥ 0.9.22 finalizes an offchain tx inside `submitTx`** when the checkpoints arrive already
  signed ("one shot"), and then refuses a separate `FinalizeTx`. The plain-arkd path
  (`submitToArkd` in the harness) therefore only calls `finalizeTx` when arkd did *not* finalize on
  submit (detected by comparing the returned checkpoint signatures against the ones we sent).
- **SDK 0.5.6** (latest; its changelog pins arkd 0.9.25). Ported: `Intent` → `Proof` and
  `intentTapLeafScript` → `proofTapLeafScript` (both deprecated aliases); the SDK now ships a
  fetch-based `EventSource` (`resolveEventSource`), so the hand-rolled SSE shims in `renew.ts` /
  `emulator-behaviour.ts` are gone; `TreeSignerSession` constructs from a secret, giving the Renew
  leaf its stable pinned cosigner without a fork (a fresh session per batch — nonces must not be
  reused); `createArkadeBatchHandler`'s signer arg is `Identity | undefined`, `undefined` for a
  server+emulator-only leaf (no keyless-identity shim); `Wallet.offchainTapscript` yields the
  wallet's forfeit leaf directly; `VirtualCoin.isPreconfirmed` replaced `virtualStatus.state`.

### Offer covenant (§13 items 1, 3, 4, 5, 6, maker side of 7) — `offer.ts`, `10-offer.test.ts`, `10-offer-batch.test.ts`

Tree: leaf 0 Fill sell-BTC `[arkd, emu⊕fill₀]`, leaf 1 Fill sell-USD `[arkd, emu⊕fill₁]`, leaf 2 Owner
`[maker, arkd]`, leaf 3 Exit `maker + CSV 1536 s`.
Quote: 40 bytes, `rate_num(8) ‖ rate_den(8) ‖ floor(8) ‖ min_fill(8) ‖ expiry(8)`, u64 LE < 2^63 (so
`BIN2NUM` reads them positive). Signature: BIP340 over `tagged_hash(tag, quote)` with
`tag = "striker/quote/v2" ‖ maker(32) ‖ epoch(u64 LE) ‖ usd_asset(34, as the SDK serializes it: txid ‖
u16 LE gidx) ‖ side(1)`: version, maker, epoch, asset and side are bound by the tag, so the message
carries only the five numbers and each leaf's `SHA256(tag)` constant is what a wrong-epoch, wrong-asset or
wrong-side quote fails against. Witness: `[signature, quote]`. Fill script (219 B per side):
offchain-only gate (`"type" INSPECTINTENTMESSAGE NOT VERIFY DROP`, see the emulator findings) → tagged
hash rebuilt in-script (`<SHA256(tag)> DUP CAT SWAP CAT SHA256 <maker> CHECKSIGFROMSTACK VERIFY`) →
`SIZE 40 EQUALVERIFY` → `expiry BIN2NUM CHECKTIME NOT VERIFY` → the USD id (`txid gidx`) pushed once
onto the altstack → `sold = sell_in − sell_out` from `INSPECTINPUTVALUE`/`INSPECTOUTPUTVALUE` or
`INSPECTINASSETLOOKUP`/`INSPECTOUTASSETLOOKUP` at `PUSHCURRENTINPUTINDEX` (change at the output with
the input's index; the asset lookups copy the id back to the altstack with `2DUP TOALTSTACK TOALTSTACK`)
→ `sell_out ≥ floor` → `sold ≥ min_fill` → `received = buy_out − buy_in` → `received × rate_den ≥ sold ×
rate_num` (BigNum `MUL`, the quote consumed by the last two `SUBSTR`s so nothing is left to drop) →
`<i> 5 <usd from altstack> 1 TUNNEL` (same script = same covenant, epoch and side set; every non-USD
asset preserved exactly). The previous single two-direction leaf (644 B, 148-byte quote with
`maker ‖ epoch ‖ sell_asset ‖ buy_asset` in the message and an `IF/ELSE` on `sell_asset == BTC`) is in
git history before this change.

- **Everything in §3/§4 works on the stack, both directions on one sats + USD VTXO,
  payments landing in the change.** Refusals carry distinct texts in the returned error: bad
  signature, and a quote signed for another epoch, another USD asset or the other side → `signature
  verification failed` (the tag binds them); expired, underpaid by one unit, floor crossed, below
  `min_fill`, dust shifted → `OP_VERIFY failed`. The side binding matters: a genuine sell-USD quote
  (`rate 1/100 000`) presented on the sell-BTC leaf would otherwise sell BTC for 1/100 000 of the
  price. Floor holds across three chained partial fills and exactly onto the floor is allowed. Epoch
  bump = Owner-leaf self-spend into the epoch+1 tree through arkd alone (no emulator); the old quotes
  then fail the signature check, epoch+1 quotes fill. `refused()` checks the message is a covenant
  execution failure (`failed to execute arkade script`) and carries the expected opcode/reason, so
  a transport or arkd error can't masquerade as a covenant refusal.
- **`INSPECT*ASSET*` want the asset txid byte-reversed** relative to `AssetId.txid` / the
  serialized id (probe: raw → lookup misses, reversed → hit). Same as the archived PoC did.
- **"All other asset balances preserved" is `OP_TUNNEL` flags 5 with USD as the one exception.**
  Script can't loop over assets; TUNNEL compares the whole declared asset set of the pair, so it
  also stops a taker from parking a junk asset on the maker's change. It reads packet declarations,
  so (as the swap/renew findings say) conservation itself is arkd's job.
- **Dust (maker side):** moving 330 sats from the maker's change to the taker's output is refused
  in both directions. Any sat leaving the maker counts as `sold` and must be paid at the rate;
  buying the dust at the quoted rate is just a larger fill. The maker never funds taker dust.
- **Index pairing holds.** Two VTXOs of one offer (identical script) + one taker, output 0 built so
  that *both* inputs' balance arithmetic passes against it: (a) taker keeps the second balance at
  output 1 → `input 1: … OP_VERIFY failed`; (b) a decoy at output 1 with exactly a valid change's
  balances but the taker's script → `input 1: … does not preserve source script`,
  i.e. the TUNNEL script check is the last line of defence. Honest 2 makers + 2 takers (one
  selling BTC, one selling USD) in one tx: 5 510 WU (was ~9 900).
- **Size (arkd `maxTxWeight` 40 000, `txFeeRate` 0):** 1 maker + 1 taker fill 2 966–3 018 WU
  (was 5 106–5 158); each extra plain-wallet taker **630 WU** (input + sig + output + packet
  entries); each extra maker **1 950 WU** (was 4 090: 219 B script + 104 B witness in the
  OP_RETURN at 4 WU/B, plus input and change). Measured to arkd's refusal: **1 maker + 59 takers**
  accepted (39 510 WU), 60 refused `TX_TOO_LARGE` (was 56/57); **19 makers + 1 taker** accepted
  (38 078 WU), 20 refused (was 9/10; 20 before the quote-field range checks added 16 B per leaf). The emulator's CSFS budget (50/input, 200/request) and its
  64 intent-gated inputs per request are not binding. The shrink came from: one leaf per side (no
  `IF/ELSE`, no second direction's arithmetic; the emulator packet carries only the executed
  leaf's script, and the 4-leaf tree costs no extra control-block bytes over the 3-leaf one);
  maker, epoch, asset and side moved from the message into the signature tag (−108 quote bytes,
  −3 byte-compares against baked constants); `SHA256(tag)` pushed once and doubled with `DUP CAT`
  (−30 B); the USD id pushed once and kept on the altstack (−3 × 34 B); the rate check consuming
  the quote so no `2DROP DROP`. Rejected: u32 `expiry`/`epoch` (16 WU per maker; expiry would
  read negative from 2038), u32 rate/amount fields (caps rates for other asset decimals), passing
  the quote as separate witness items (the taker could re-split the signed bytes unless every
  field's `SIZE` is checked, which costs more than the `SUBSTR`s), signing the raw `SHA256(tag) ‖
  quote` without the outer hash (saves 3 B, leaves the BIP340 tagged-hash convention), dropping the
  `SIZE 40` check (saves 5 B; trailing signed bytes would be harmless but the format would not be
  strict). Fill latency measured in `10-offer.test.ts` (emulator `submitTx` alone, after
  `attachPrevArkTxs`): p50 ~80 ms, p95 ~90 ms for a 2-input fill with an asset packet, with the
  asset-claims suite running on the same stack; the ~30 ms figure in the emulator findings is a
  single-input self-spend.
- **Plain wallet takers:** `identity.sign(arkTx, [i])` + `identity.sign(checkpoint_i, [0])`
  before `emulator.submitTx`, input leaf = the coin's `forfeitTapLeafScript`. `attachPrevArkTxs`
  takes one txid *per input* (positional), not a set.
- **arkd's indexer pages at 100 and `pageIndex` is 1-based** (0 and 1 return the same page;
  `page.total` counts from 1). The harness `coinsAt` walks 1..total and dedupes by outpoint, so it
  no longer truncates at 100; `walletCoins` adds the wallet's tap leaves on top (the SDK wallet's
  own `getVtxos` is a 20 s-polled snapshot that doesn't see emulator-side spends, so every suite
  reads coins from the indexer instead). The per-wallet tap leaves come from
  `Wallet.offchainTapscript` (`.forfeit()`), not from reading a live vtxo.
- **The faucet CLI wallet ran dry mid-spike** (1.9 M sats → 0 with several suites drawing from
  it). The offer suites now reuse their deterministic wallets (`ensureFunded` tops up only the
  shortfall), reuse one demo USD across runs (`demoUsd`) and reclaim every leftover offer VTXO
  through the Owner leaf at start (`sweepOffer`, 30 inputs per tx) — which doubles as the Owner
  withdraw test. Refilling the faucet needs an on-chain `faucet` + `ark settle` batch round.
- **For DESIGN.md (all folded in):** (1) §3: version, maker, epoch, asset and side live in the
  signature tag; the message is the five numbers. (2) §4: one Fill leaf per side. (3) §4: "other
  balances ≥ input" → "preserved exactly" (`OP_TUNNEL` with the traded token excepted). (4) §4:
  `floor` on the sats side must be ≥ dust or the change can't exist; `min_fill` must be > 0
  (sold = 0 would let anyone re-chain the VTXO for free). (5) §4: the Fill leaf needs the
  offchain-only gate from the emulator findings. (6) §7: "several makers" means ≤ 20 per tx,
  "many takers" ≤ 59.

### Swap covenant + taker dust (§13 items 7, 8) — `swap.ts`, `20-swap.test.ts`

- **All of §5 works on the pinned stack.** Leaves: Fill (covenant), Refund-anyone (covenant),
  Refund-key (`[refund_pubkey, arkd]` plain collaborative leaf), Exit (`refund_pubkey` + 1536 s
  CSV). Fill scripts are 210–292 bytes, the refund script 50.
- **Refund-key doesn't need the emulator.** A plain `[refund_pubkey, arkd]` multisig leaf is
  spent through arkd's own `submitTx`/`finalizeTx`, so a user can cancel even when the emulator
  is down. The covenant leaves need the emulator; the exit leaf needs neither.
- **The covenant reads the input amount from the coin itself**, so users can send more or
  less than quoted. Lying about the amount fails at two different layers:
  sats via `INSPECTINPUTVALUE` (the emulator rejects a forged PSBT prevout before running any
  script: `prevout tx value mismatch for input 0: got 299000, expected 300000`); tokens via
  `INSPECTINASSETLOOKUP`, which only reads the packet's *declared* amount. The emulator runs the
  script on an under-declared packet and co-signs it. Only arkd catches it
  (`ASSET_INPUT_INVALID: input 0 owns asset … but amount mismatch`). Covenant safety here
  depends on arkd's asset validation, not on the emulator.
- **Output pairing.** For a swap input at index i in a tx with n inputs: receive at output i,
  exact-out refund at output i+n. The fee output index is the only witness item; two swaps
  sharing a fee output only shortchange Striker. Two deposits can't share one receive output
  (refused: `OP_EQUALVERIFY failed vin=1`); two deposits plus a maker fill fine in one tx.
- **arkd rejects outputs below dust unless the script is `OP_RETURN`** (`AMOUNT_TOO_LOW: output
  #3 amount is below dust limit (300 < 330) but is not using OP_RETURN output script`). The fee
  check therefore accepts the fee key's P2TR *or* its subdust form `OP_RETURN <key>` (the
  SDK's `subdustPkScript`). In practice any fee under 330 sats goes to a subdust VTXO.
- **Fee is always in sats.** BTC→token: `ceil((input − D)·bps/1e4)` taken from the input.
  Token→BTC: `ceil(floor(U·min_rate)·bps/1e4)`, i.e. computed at the *min* rate, taken from
  the bought sats. A token-denominated fee would need its own carrier dust paid by someone.
- **Exact-out** bakes `max_sell = ceil(want/min_rate)` and a fixed fee into the script. BTC
  remainders below dust can't get an output and are forfeited, at most D−1 sats. Token
  remainders return with D of the user's own carrier (§6 row 3), so receive = `want + c − D`.
  If the user underpays, exact-out can't fill and refunds after the deadline.
- **Taker dust holds both ways, exact to the sat.** Selling 200 000 sats gives one
  output of exactly 330 sats + `(S − 330 − F1)·rate` USD. Paying that whole VTXO into a
  USD→BTC swap returns exactly `S − F1 − F2` sats: the taker's own 330 back on top. A fill
  where the maker funds its USD carrier from the taker's dust is refused (`OP_VERIFY failed`).
- **Refund-anyone uses `OP_TUNNEL` flags 6** (value + assets) on the paired output, plus a
  refund-script check. One tx refunds a token deposit and a wrong-asset BTC deposit at once.
  Skimming one sat is refused (`selected output does not preserve source value`).
- **The emulator error tells you which check failed**, given how the script is laid out. The
  leaf uses different opcodes on purpose: deadline → `OP_NUMEQUALVERIFY failed`, destination →
  `OP_EQUALVERIFY failed`, rate/amount → `OP_VERIFY failed`, exact-out refund → `script
  returned early`, fee (last check) → `false stack entry`. Covenant refusals carry `failed to
  execute arkade script`; arkd rejections relayed through the emulator carry arkd's own status
  (`ASSET_INPUT_INVALID`, `prevout tx value mismatch`, …). The harness `refused()` asserts the
  former, `rejectedWith(text)` the latter.
- **A plain wallet can co-sign a covenant fill.** Use the wallet's `forfeitTapLeafScript`,
  `identity.sign(arkTx, [i])`, *and* sign its checkpoint (`identity.sign(cp, [0])`) before
  submitting to the emulator. As finalizer, the emulator requires all non-arkd checkpoint
  signatures up front. `walletCoins()` reads the indexer, because wallet state lags custom
  txs; it also belongs in the harness.
- **arkade.money-style funding is a plain `wallet.send` to the covenant address.** With
  assets, the SDK attaches a 330-sat carrier (`ASSET_CARRIER_SATS`). The covenant returns it
  on top as the taker's dust.

### Emulator behaviour: late submission, chain depth, tx size (§13 items 2, 10) — `emulator-behaviour.ts`, `30-emulator*.test.ts`

Source refs: emulator = `github.com/arkade-os/emulator` tag v0.0.10-rc.0, arkd = tag v0.9.25.
Line numbers below are from v0.0.9-rc.2 unless noted; the offchain/intent/finalize logic that the
late-submission findings rest on is unchanged in v0.0.10-rc.0 (the service was refactored to split
script execution from signing — `pkg/emulator/service.go`, `internal/application/{service,signer,
finalize}.go` — but `SubmitTx` still submits-and-finalizes in one call, `SubmitIntent` still returns
the signed proof without registering it, and `SubmitFinalization` still signs forfeits without
re-running the script).

- **`OP_CHECKTIME` uses the emulator host's wall clock**, read once per input when the
  engine is built (`time.Now().Unix()`; the opcode pushes `timestamp <= now`). It is checked
  only when the emulator signs. arkd's clock plays
  no part in the offchain path. No skew bound exists between emulator replicas (same key, other
  host) or towards arkd. The regtest containers share the host clock.
- **Offchain, emulator as finalizer: no late submission.** `SubmitTx`
  (`internal/application/service.go:128`) runs the script and signs, then submits to arkd
  and finalizes within the same call (`:182`, `:228`). The comment there says this is
  deliberate, so the tx can't be held pending. The caller receives only arkd's final tx. The
  emulator finalizes when its tweaked key is the last non-arkd key in the leaf
  (`internal/application/finalize.go:81-104`). Our `[server, emulator]` leaf always takes
  this path. A tx built before expiry and submitted 2 s after it is refused
  (`30-emulator-late.test.ts`).
- **Offchain, emulator not last (`[server, emulator, user]`): late submission works.**
  `service.go:158` returns the emulator's signatures without contacting arkd. Test: the user
  got signatures before expiry and submitted to arkd directly 3 s after it. arkd accepted.
  Rule: **never put a non-arkd key after the emulator key in a covenant leaf.**
- **Batch intents: late submission works, with no time limit.** `SubmitIntent`
  (`pkg/emulator/intent.go:267`) runs the script on the intent proof and *returns* the signed
  proof. It never registers it. `SubmitFinalization` (`finalization.go:18`) signs forfeits
  "if the proof contains our signature" and does not re-run the script. The only time bound is
  the intent's `expire_at`, which the client chooses, and `0` means never. Both the emulator
  (`intent.go:486`) and arkd (`internal/core/application/service.go:1665`) skip the check when
  it is 0, and the SDK itself sends 0. Test: a proof for the expiry covenant, signed before
  expiry, was registered and settled in a batch 20 s after expiry. The output goes wherever
  the proof says, so any "before expiry/deadline" leaf whose script can be satisfied by an
  intent proof is vulnerable: offer Fill, swap Fill. A held proof can also lock the VTXO
  into a batch, since arkd refuses offchain spends of registered VTXOs (`VTXO_ALREADY_REGISTERED`).
- **Fix (tested): make Fill leaves offchain-only.** Prefix the script with
  `"type" OP_INSPECTINTENTMESSAGE OP_NOT OP_VERIFY OP_DROP`. A miss pushes `[<> , 0]`
  (`pkg/arkade/intent_message.go:99`), so the prefix passes offchain and fails on any intent.
  The emulator then refuses to sign an intent even before expiry, and offchain fills still
  work. This is the inverse of the Renew leaf's gate. `OP_INSPECTVERSION` is not a
  substitute: arkd's `intent.Verify` doesn't check the proof's tx version.
- **`SubmitOnchainTx`** (`pkg/emulator/onchain.go:16`) also returns a signed PSBT without
  broadcasting it. Our covenant leaves include arkd's key, and arkd co-signs only through its
  offchain and batch flows, so this is not a usable path for them.
- **Chain depth: no limit.** 1000 chained covenant self-spends (VTXO → tx1 → … → tx1000, no
  batch) were all accepted. The tip stays `preconfirmed`. arkd tracks `Depth` only to place DAG
  markers every 100 (`internal/core/domain/marker.go:7`, `application/service.go:1133-1158`).
  No setting caps depth, pending txs or checkpoints. **Latency** of one emulator `SubmitTx`
  (run script + sign + arkd submit + finalize, local docker): p50 ~30 ms, p95 ~34 ms, max ~37 ms,
  flat across depth (measured to 200; 1 000 still accepted). The v0.9.25 stack (standalone signer,
  postgres + redis) is ~15 ms slower per call than the v0.9.16 single-process one (p50 15–18 ms).
  Fetching the previous ark tx from the indexer adds ~6 ms.
  The real cost of depth is the L1 exit: unrolling a depth-d VTXO publishes d ark txs plus d
  checkpoints, each needing an anchor bump.
- **Tx size (arkd `maxTxWeight` 40 000, checked on the final signed tx after the emulator
  signed, `service.go:1101`):** 1 covenant input → **228** outputs (39 844 WU). Trivial
  covenant inputs → 1 output: **85** inputs (39 964 WU, ~470 WU/input, emulator 0.9 s).
  Arkade scripts and witnesses travel in the OP_RETURN emulator packet, so they cost 4 WU/byte.
  The 219-byte offer Fill leaf plus its 104-byte witness costs ≈ 1 290 WU on top, which comes to
  1 950 WU per maker input and 19 maker inputs per tx (measured in `10-offer-batch.test.ts`).
- **Emulator compute limits are per input and per request** (`pkg/arkade/compute_limits.go`):
  per input `CHECKSIG*`/`CHECKSIGFROMSTACK` 50, `INSPECTINTENTMESSAGE` 16, `ECMUL` 50, etc.,
  and ×4 per request (`requestInputBudget`). Measured: a tx can have at most **64**
  intent-gated inputs (`exceeded request execution limit of 64 vin=64`). CSFS quote checks
  cap at 200 per tx. Weight binds first for realistic fills.
- Running the `30-emulator*` files in parallel (`node --test` default) can fail on concurrent
  faucet `ark send` calls. `npm run spike` uses `--test-concurrency=1`.

### Renew leaf + L1 exit (§13 items 9, 11) — `renew.ts`, `40-renew.test.ts`

Tree: leaf 0 covenant placeholder `[arkd, emu⊕fill]`, leaf 1 Renew `[arkd, emu⊕renew]`,
leaf 2 Owner `[owner, arkd]`, leaf 3 Exit `owner + CSV 1536 s`. Renew script (delegate style,
emulator `test/delegate_test.go`): `PUSHEXPIRY <window> SUB CHECKTIME VERIFY`, then
`INSPECTINTENTMESSAGE` gates `type == "register"`, `onchain_output_indexes == "[]"`,
`cosigners_public_keys.0 == <Striker tree-signer key>`, no `.1`; then
`PUSHCURRENTINPUTINDEX 1SUB 7 0 TUNNEL` (script + value + assets on proof output i−1).

- **Renewal by a third party works end to end.** Striker (a key with no funds and no leaf
  in the covenant) built the intent proof, got it co-signed by the emulator (`submitIntent`),
  registered it with arkd, cosigned the vtxo tree and finalized through the emulator
  (`arkade.createArkadeBatchHandler` + `Batch.join`). The renewed VTXO is a batch leaf with the
  same script, same 42 USD, and a later expiry; the old one shows `settledBy = commitment`.
  One round takes ~27 s on regtest. The forfeit is signed by arkd + emulator; the delegate's
  `Identity.sign` must be a no-op (`SingleKey.sign` throws when its key is not in the leaf).
- **Covenant refusals, all from the emulator** (`selected output does not preserve source
  value|script|assets`): value − 1, another script, 41 instead of 42 USD. Off-chain spend
  through the Renew leaf: `OP_VERIFY failed` (the `type` gate). Renewal before the window
  (`window` 1024 s on an 86 400 s VTXO): refused by `CHECKTIME`. Wrong cosigner or a second
  cosigner in the message: refused.
- **`OP_PUSHEXPIRY` returns the indexer's `expiresAt`** (unix seconds), checked to the second
  with a `PUSHEXPIRY EQUAL` leaf fed the expected value as witness; off by one is refused.
- **`OP_TUNNEL`'s asset flag is packet-local** (`pkg/arkade/tunnel.go:102`): it compares the
  asset packet's declared input/output amounts for this vin/vout. A proof that *omits the
  asset packet* passes the covenant (both sides empty) and is co-signed by the emulator. arkd
  refuses it: `ASSET_VALIDATION_FAILED: asset packet not found` (`pkg/ark-lib/asset/
  tx_validation.go:33`, "reject transaction spending asset vtxos without asset packet").
  Same class as the swap finding above: asset conservation is arkd's job, not the covenant's.
- **Exact-value renewal settles fee-free through a real batch.** `.env.regtest` now sets the
  Mutinynet-style fee program
  `ARK_OFFCHAIN_INPUT_FEE=inputType == 'vtxo' && expiry - now() > 518656.0 ? amount * 0.002 : 0.0`
  (mainnet uses `2505216.0`; it is POSTed to arkd's `/v1/admin/intentFees` at
  `npm run regtest -- start` by `.cache/arkade-regtest/lib/setup/arkd.mjs` `applyArkdFees`, from the
  arkd container env `ARK_OFFCHAIN_INPUT_FEE`). With the 86 400 s regtest vtxo-tree expiry every
  VTXO is inside the ~6-day window, so `offchainInput` evaluates to 0. The emulator co-signs the
  exact-value proof, `registerIntent` accepts it for 0 fee, and the delegate drives a real batch to
  a commitment — `Intent.fee = Σinputs − Σoutputs = 0`, which an exact-value `OP_TUNNEL` output can
  pay. The test reads the program from `/v1/info` with the SDK `Estimator`; **should the program
  ever charge** (e.g. the stock `amount * 0.01`), the proof still passes the covenant and the test
  records arkd's `INTENT_INSUFFICIENT_FEE (31): got 0 min expected 200` instead. The CEL variables
  are `amount`, `expiry`, `birth`, `weight`, `inputType` and `now()` (arkd `pkg/ark-lib/arkfee/celenv`);
  the `Estimator` evaluates the program correctly (0 near expiry, ~40 sats for a 30-day VTXO).
- **Fee-capped variant (tested through a real batch):** `TUNNEL` flags 5 (script + assets)
  plus `out.value ≥ in.value − maxFee` via `INSPECTOUTPUTVALUE`/`INSPECTINPUTVALUE`. The test
  deducts max(arkd's required fee, 200) sats so a real fee is paid under a `maxFee` 250 cap even
  when arkd asks for 0; deducting 251 is refused by the covenant
  (`opcode=OP_GREATERTHANOREQUAL …: false stack entry`). This is the shape to use if a server ever
  charges for renewal; the cap must be an absolute number baked into the script (bps would need
  `MUL`/`DIV`, which the emulator has, but the fee program can change under the covenant anyway).
- **SDK 0.5.6 ships a Node `EventSource`.** `resolveEventSource` falls back to a built-in
  fetch-based SSE client when `globalThis.EventSource` is absent (Node has none without
  `--experimental-eventsource`), so the hand-rolled shims were removed; `getEventStream` and
  `Wallet.settle` work out of the box.
- **SDK 0.5.4+ exports a deterministic `TreeSignerSession`** (constructed from a 32-byte secret),
  so the Renew leaf's pinned cosigner is a stable key with no fork. A *fresh* session is built per
  batch (`delegate.session()`), because a session's musig2 nonces must never be reused — reusing
  one across the exact-value and fee-capped renewals in the suite fails with
  `INVALID_TREE_NONCES (60): missing musig2 nonce for txid …`.
- **L1 exit works with only the owner key.** `Unroll.Session` (SDK) + an `OnchainWallet` as
  P2A bumper unrolled a pre-confirmed covenant VTXO whose chain was
  `ARK → CHECKPOINT → ARK → CHECKPOINT → TREE → COMMITMENT`: **3 1C1P packages** (tree leaf
  124 vB, checkpoint 241 vB, ark tx 295 vB, each with a 153 vB fee child), one block each,
  ~0.7–0.8 k sats at regtest's floor fee rate, ~35 s with a block every 3 s. The exit leaf spend is a
  146 vB tx. Before the CSV delay bitcoind says `non-BIP68-final`; after advancing MTP by
  1536 s (`setmocktime` + 12 blocks, `advanceMedianTime()`) it confirms and the indexer marks
  the VTXO `isUnrolled`. Seconds-based CSV counts from the MTP of the block *before* the one
  confirming the ark tx, so on mainnet the exit needs ≥ 1536 s of chain time after the last
  package confirms. The ark tx needs no CSV: it spends the checkpoint through the pre-signed
  leaf, the checkpoint's 1536 s path is arkd's.
- **Exit cost is dominated by chain depth, and the regtest faucet is deep.** A VTXO freshly
  sent by the faucet sat on a chain of **102 virtual txs** (every `ark send` chains the
  faucet's change), i.e. ~100 packages to exit. The test calls `wallet.settle()` first to get a
  batch leaf. For Striker this means: offer VTXOs that have been filled many times without a
  renewal are expensive to exit; renewal through a batch resets the depth to 1 (tree leaf).

### Asset claims vs arkd (§14 open question) — `asset-claims.ts`, `50-asset-claims.test.ts`

Question: covenants only see the tx's own asset packet (emulator `pkg/arkade/asset_opcodes.go:423-543`
for `INSPECTINASSET*`, `tunnel.go:102-127` for `OP_TUNNEL`). Does arkd stop a tx from leaving an
input's asset out of it? **Yes, in every variant.** `asset-claims.ts` builds offchain txs with the
asset packet written out by hand. Each variant runs twice: a plain wallet input straight to arkd
(`submitTx`, no emulator), and an accept-all covenant input (`[1]`) through the emulator, which
co-signs and relays arkd's refusal. The two paths return identical texts. The emulator has no asset
validation of its own (no `ValidateAssetTransaction` in its tree).

| Variant | arkd v0.9.25 answer |
|---|---|
| (a) input holds A+B, packet lists only A | `ASSET_NOT_FOUND (34): input 0 owns asset <B> but it's not present in the packet` |
| (b) asset input, no packet at all (plain offchain tx) | `ASSET_VALIDATION_FAILED (33): asset packet not found in tx <txid>` |
| (c) packet present (only an issuance group), no group lists the input | `ASSET_NOT_FOUND (34): input 0 owns asset <B> but it's not present in the packet` |
| (c′) B's group exists but lists only another input | `ASSET_INPUT_INVALID (35): input 0 owns asset <B> but it's not present in the asset group inputs` |
| (d) declared 1 001, held 1 000 | `ASSET_INPUT_INVALID (35): input 0 owns asset <A> but amount mismatch: 1001 != 1000` |
| (d′) claim on an input holding no assets | `ASSET_INPUT_INVALID (35): asset input 1 references input 1 which does not contain any assets` |
| (d′) claim of A on an input holding only B | `ASSET_INPUT_INVALID (35): asset input 0 references input with asset <A> but asset not found in tx input 0` |
| (e) outputs declare more than the inputs | reissuance: `CONTROL_ASSET_INVALID (37): asset <A> does not have a control asset` |
| (e) outputs declare less than the inputs, or a group has no outputs | **accepted, the rest is burned.** Output got 400 of 1 000 A and none of 2 000 B |

Source (arkd tag v0.9.25, `97386cb`; the emulator's `go.mod` pins ark-lib to the same commit, so
both sides parse the packet identically):
- `internal/core/application/service.go:823-826`: an input's held assets come from arkd's own
  VTXO record (`vtxo.Assets`), not from the PSBT. `:1110` validates offchain txs, `:2458` intent
  proofs (the inputs are shifted by the toSpend input, `:2124`, `:2226`).
- `pkg/ark-lib/asset/tx_validation.go`: `:38` no packet while spending asset VTXOs. `:201-238`
  `validateInputAssets`: every held asset must have a group (`:204`), that group must list the
  input (`:228`), and the amount must be equal (`:218`). `:297-364` `validateGroupInputs`, the
  reverse direction: every group input must hold assets (`:321`) and that asset (`:351`) at
  exactly that amount (`:336`). Intent-type inputs are refused offchain (`:305`). There is **no**
  sum(in) = sum(out) check. `asset_group.go:79-92` treats sum(out) > sum(in) as a reissuance
  (`tx_validation.go:91` requires the control asset in the packet), and sum(out) < sum(in) is
  simply allowed.
- `packet.go:94-100`: one group per asset id. `asset_input.go:223-230` and `asset_output.go:191-197`:
  unique vin / vout within a group. A packet therefore can't count one holding twice.
- `internal/core/application/utils.go:343-370`: output VTXOs get exactly the declared group
  outputs. There is no implicit carry-over. An asset left off every output is gone (burned),
  never silently carried.

**Soundness.** Together these mean that in any tx arkd accepts, the packet's claims for input i
are *exactly* the assets VTXO i holds: same set, same amounts. Output j holds exactly what the
packet declares for j. Packet-local introspection is therefore ground truth once arkd has accepted.
- **Swap BTC-sell "no assets on the deposit" (`INSPECTINASSETCOUNT == 0`): sound.** A deposit of
  20 000 sats + 500 B into a BTC→A swap: the honest packet (B declared) is refused by the covenant
  (`OP_VERIFY failed`). The attack, leaving B out so the count reads 0, passes the covenant and the
  emulator co-signs it. arkd then rejects it with `ASSET_NOT_FOUND (34): input 0 owns asset <B> but
  it's not present in the packet`. A pure-sats deposit of the same swap fills. The dirty deposit
  refunds after the deadline via refund-anyone with its 500 B intact. The token-sell path's
  `INSPECTINASSETCOUNT == 1` + `INSPECTINASSETLOOKUP` rests on the same rules.
- **Offer "other assets preserved" (`<i> 5 <A> 1 TUNNEL`): sound.** It was tested as the bare
  clause (`tunnelExcept`), not `offer.ts`. Moving declared B to a taker is refused by the covenant
  (`selected output does not preserve source assets`). Burning B by omitting it on both sides passes
  `TUNNEL` (0 = 0) and is rejected by arkd (`ASSET_NOT_FOUND (34)`). Stealing B (omitted on the input,
  declared on the taker's output) passes `TUNNEL` and is rejected by arkd with `ASSET_INPUT_INVALID (35):
  … not present in the asset group inputs`. It would also need the control asset (sum(out) > sum(in)).
  A self-spend that keeps B and changes A is accepted.
- No failing attack exists, so no covenant change is needed. The residual dependency is unchanged
  (DESIGN §10): conservation is arkd's check, not the emulator's. An arkd that skipped it could
  burn or re-assign assets in its own index, but assets are an arkd-index concept to begin with.
- Side note for builders: burns are free and silent. A tx that under-declares outputs loses the
  difference, with no error. The spike's `buildTx` / `split` derive the change remainder
  explicitly; Striker's tx builders must too.

## Review (2026-11-18)

Three independent reviews of the design and spike (Codex GPT-6.1 Terra, Claude Fable 5, Kimi K3),
each asking whether anyone can make a maker or taker lose money. Fixed in this branch:

- **Swap Fill and Refund-anyone lacked the offchain-only gate** (all three). A fill co-signed
  as a batch intent before the deadline could be held and settled after it, at the old rate,
  and a registered intent locks the deposit against both refund paths. Both leaves now start
  with the gate; `20-swap` shows the emulator refusing them at the gate's `OP_VERIFY` (byte 7),
  including an intent with an on-chain output.
- **Quote fields ≥ 2^63 read as negative** (Kimi). The offer Fill leaf range-checks `rate_num`,
  `rate_den`, `min_fill` (> 0) and `floor` (≥ 0); `10-offer` signs quotes with the top bit set in
  each field and they are refused. Costs 16 B per leaf: 19 makers per tx instead of 20.
- **`min_rate` was gross of the fee on token → BTC** (Terra). It is now net in both directions,
  and exact-out spends `floor(want / min_rate)`, rounded in the user's favour.
- **`planFill` rounded and branched differently from the script** (Fable, Kimi, Terra): refused
  fills, no underpayment. Fixed, with uneven-amount and improved-rate exact-out tests.
- **Fee-capped Renew leaf slack** (all three): exactly two proof outputs, so the slack can only
  go to arkd as fee; `40-renew` shows an extra output being refused.
- **Anyone could register a Renew intent** (Fable, Kimi) and lock the VTXO against fills. The
  Renew leaf is now `[striker, arkd, emulator]`: arkd refuses a proof without Striker's
  signature, and Striker signs the forfeit in the batch.
- **The L1 exit did not show the asset** (Terra): the exit spend now carries the asset packet.
  How those units are used afterwards is open (DESIGN.md §14).

A follow-up review of these fixes (Codex GPT-6.1 Terra) found:

- **The intent-only gate could be bypassed through the emulator's on-chain endpoint.**
  `SubmitOnchainTx` runs scripts without an intent message and checks prevouts only by hash, so
  it signs a batch-intent proof (with its synthetic BIP322 prevout) that `SubmitIntent` refuses.
  `30-emulator-late` settles such a held proof 3 s after expiry. The gate is now
  `OP_PUSHEXPIRY OP_DROP` + the intent check: the on-chain path has no VTXO expiry
  (`OP_PUSHEXPIRY expiry not set`). All offer and swap Fill leaves and the swap Refund-anyone
  leaf use it; `10-offer` and `20-swap` check the on-chain endpoint too.
- **A sub-dust exact-out remainder was forfeited**, breaking the net `min_rate` on small
  orders. Every unspent sat now returns, below dust as the refund key's `OP_RETURN` output.
- **`floor` = `00…00 80` (negative zero) read as 0.** The floor is checked by its top byte.
- **`planFill` kept exact-out price improvement from the user**; the unsold tokens now come back.

Documented rather than changed: the floor bounds one VTXO, not the offer (DESIGN.md §3); the
real offer tree has no Renew leaf yet (prototype); the emulator operator's clock decides expiry; offline exit needs saved exit data (DESIGN.md §10).

## Regtest housekeeping

- The harness refills the regtest CLI faucet (on-chain faucet → boarding → `ark settle`) when
  `ark send` would run dry.
- The L1 exit test advances chain time by ~27 min per run (CSV 1536 s). bitcoind rejects blocks
  more than 2 h ahead of its clock, so many back-to-back runs stall mining. `advanceMedianTime`
  now fails fast with the wait time; `npm run regtest -- clean` followed by `start` resets it.
