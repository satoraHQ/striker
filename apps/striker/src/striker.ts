// Striker: the book of maker quotes, swap addresses, and the settlement loop that fills swap
// deposits against offer covenants (DESIGN.md §5, §7).
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ArkAddress, EsploraProvider, InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider, RestEmulatorProvider,
  RestIndexerProvider, SingleKey, TreeSignerSession, Wallet, type VirtualCoin,
} from '@arkade-os/sdk';
import {
  allocate, BTC, buildTx, constants, fetchChainParams, hex, minRateFor, NotFillable, offerCovenant, planSettlement, quoteFromWire,
  refundInput, SELL_ASSET, SELL_BTC, submitViaEmulator, swapCovenant, termsFromWire, termsToWire, unhex,
  type BookEntry, type BookSnapshot, type ChainParams, type Coin, type CreateSwapRequest, type InfoResponse, type Offer,
  type PublishQuotesRequest, type RenewParams, type Side, type SignedQuote, type Swap, type SwapStatus, type SwapTerms, type SwapView,
} from '@striker/core';
import type { Config } from './config.js';

type ResolvedConfig = Config & Required<Pick<Config, 'offerExitSeconds' | 'swapExitSeconds'>>;
import { renewalFee, renewOffer, type RenewDeps } from './renew.js';

const now = () => Math.floor(Date.now() / 1000);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
/** Quotes this close to expiry are not used: the fill must reach the emulator before it. */
const QUOTE_MARGIN = 3;
/** Fills stop this many seconds before a swap's deadline. */
const DEADLINE_MARGIN = 5;

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

interface OfferState {
  offer: Offer;
  quotes: Partial<Record<Side, SignedQuote>>;
  coin?: Coin & { expiresAt?: Date };
  /** Refresh the coin from the indexer before the next fill (after a failure or a new deposit). */
  stale: boolean;
  /** Registered for renewal: the VTXO is locked until the batch ends, so no fills. */
  renewing?: boolean;
  renewedAt?: number;
}
interface SwapRecord {
  id: string; swap: Swap; status: SwapStatus; createdAt: number;
  deposit: SwapView['deposit']; expected: SwapView['expected']; minimum: SwapView['minimum']; makerPrice: number;
  coin?: Coin; fillTxid?: string; refundTxid?: string; received?: SwapView['received']; error?: string;
}

export class Striker extends EventEmitter {
  private offers = new Map<string, OfferState>();
  private swaps = new Map<string, SwapRecord>();
  private ticking = false;
  private timer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;
  private renewDeps?: RenewDeps;
  readonly identity: SingleKey;

  private constructor(
    readonly config: ResolvedConfig, readonly chain: ChainParams, readonly renew: RenewParams,
    readonly ark: RestArkProvider, readonly indexer: RestIndexerProvider, readonly emulator: RestEmulatorProvider,
    readonly feeWallet: Wallet, readonly feeScript: Uint8Array, readonly feeAddress: string,
  ) {
    super();
    this.identity = SingleKey.fromPrivateKey(config.secret);
    this.load();
  }

  static async create(cfg: Config) {
    const ark = new RestArkProvider(cfg.arkUrl);
    const info = await ark.getInfo();
    const exit = BigInt(info.unilateralExitDelay);
    const config: ResolvedConfig = { ...cfg, offerExitSeconds: cfg.offerExitSeconds ?? exit, swapExitSeconds: cfg.swapExitSeconds ?? exit };
    const chain = await fetchChainParams(config.arkUrl, process.env.EMULATOR_KEY);
    const identity = SingleKey.fromPrivateKey(config.secret);
    // Renewal is free while a VTXO has less than W seconds left (arkd intent fee program, DESIGN.md §8).
    const freeWindow = /expiry - now\(\) > ([\d.]+)/.exec(info.fees?.intentFee?.offchainInput ?? '')?.[1];
    const window = config.renewWindow ?? (freeWindow ? BigInt(Math.floor(Number(freeWindow))) : 3_600n);
    const renew: RenewParams = { cosigner: hex(await new TreeSignerSession(config.secret).getPublicKey()), delegateKey: await identity.xOnlyPublicKey(), window };
    const feeWallet = await Wallet.create({
      identity, arkProvider: ark, onchainProvider: new EsploraProvider(config.esploraUrl, { forcePolling: true, pollingInterval: 10_000 }),
      storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() }, settlementConfig: false,
    });
    const feeAddress = await feeWallet.getAddress();
    const striker = new Striker(config, chain, renew, ark, new RestIndexerProvider(config.arkUrl), new RestEmulatorProvider(config.emulatorUrl),
      feeWallet, ArkAddress.decode(feeAddress).pkScript, feeAddress);
    return striker;
  }

  info(): InfoResponse {
    return {
      network: this.chain.networkName, arkUrl: this.config.arkUrl, serverKey: hex(this.chain.server), emulatorKey: hex(this.chain.emulatorKey),
      dust: String(this.chain.dust), asset: this.config.asset, feeBps: String(this.config.feeBps), feeAddress: this.feeAddress, feeScript: hex(this.feeScript),
      renew: { cosigner: this.renew.cosigner, delegateKey: hex(this.renew.delegateKey), window: String(this.renew.window) },
      offerExitSeconds: String(this.config.offerExitSeconds), swapExitSeconds: String(this.config.swapExitSeconds), swapTtl: this.config.swapTtl,
    };
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.config.batchWindowMs);
    this.renewTimer = setInterval(() => void this.renewDue(), this.config.renewCheckMs);
  }
  stop() { clearInterval(this.timer); clearInterval(this.renewTimer); }

  // ------------------------------------------------------------------ renewal (DESIGN.md §8)

  private async renewDue() {
    this.renewDeps ??= { ark: this.ark, indexer: this.indexer, emulator: this.emulator, network: this.chain.network, identity: this.identity,
      secret: this.config.secret, cosigner: this.renew.cosigner, fees: (await this.ark.getInfo()).fees?.intentFee ?? {} };
    const before = Math.min(this.config.renewBefore, Number(this.renew.window));
    for (const st of this.offers.values()) {
      // A just-renewed VTXO has a full lifetime; don't renew the same offer again right away.
      if (st.renewing || (st.renewedAt && Date.now() - st.renewedAt < 10 * 60_000)) continue;
      const { vtxos } = await this.indexer.getVtxos({ scripts: [hex(st.offer.tree.pkScript)], spendableOnly: true });
      for (const coin of vtxos) {
        const left = coin.expiresAt ? (coin.expiresAt.getTime() - Date.now()) / 1000 : Infinity;
        if (left > before || left <= 0) continue;
        const fee = renewalFee(this.renewDeps, coin);
        if (fee > 0n) { log(`offer ${st.offer.address.slice(0, 16)}… renewal would cost ${fee} sats; skipped`); continue; }
        st.renewing = true;
        log(`renewing ${coin.txid}:${coin.vout} of offer ${st.offer.address.slice(0, 16)}… (${Math.round(left)} s left)`);
        try {
          const commitment = await renewOffer(this.renewDeps, st.offer, coin);
          log(`renewed in batch ${commitment}`);
          st.renewedAt = Date.now();
        } catch (e) { log(`renewal failed: ${(e as Error).message.slice(0, 300)}`); }
        finally { st.renewing = false; st.stale = true; this.bookChanged(); }
      }
    }
  }

  // ------------------------------------------------------------------ book

  offerFor(maker: string, epoch: bigint) {
    const key = `${maker}:${epoch}`;
    let st = this.offers.get(key);
    if (!st) {
      const offer = offerCovenant(this.chain, { maker: unhex(maker), epoch, asset: this.config.asset.id, renew: this.renew, exitSeconds: this.config.offerExitSeconds });
      st = { offer, quotes: {}, stale: true };
      this.offers.set(key, st);
    }
    return st;
  }

  async publishQuotes(req: PublishQuotesRequest) {
    if (!/^[0-9a-f]{64}$/.test(req.maker)) throw new HttpError(400, 'maker must be an x-only hex key');
    const st = this.offerFor(req.maker, BigInt(req.epoch));
    // Newer epochs replace older ones: an epoch bump cancels every quote of the old covenant.
    for (const [key, other] of this.offers) if (key.startsWith(`${req.maker}:`) && other !== st && other.offer.epoch < st.offer.epoch) this.offers.delete(key);
    let accepted = 0;
    for (const w of req.quotes) {
      try {
        const q = quoteFromWire(st.offer, w);
        if (q.quote.expiry <= BigInt(now() + QUOTE_MARGIN)) continue;
        st.quotes[q.quote.side] = q; accepted++;
      } catch (e) { throw new HttpError(400, `quote rejected: ${(e as Error).message}`); }
    }
    if (st.stale || !st.coin) await this.refreshOffer(st);
    this.bookChanged();
    return { address: st.offer.address, accepted };
  }

  /** The offer's spendable VTXO. The maker bot keeps one; with several, the largest is used. */
  private async refreshOffer(st: OfferState) {
    const { vtxos } = await this.indexer.getVtxos({ scripts: [hex(st.offer.tree.pkScript)], spendableOnly: true });
    const coin = vtxos.sort((a, b) => b.value - a.value)[0];
    st.coin = coin ? { txid: coin.txid, vout: coin.vout, value: coin.value, ...(coin.assets ? { assets: coin.assets } : {}), ...(coin.expiresAt ? { expiresAt: coin.expiresAt } : {}) } : undefined;
    st.stale = false;
  }

  private price(side: Side, q: SignedQuote['quote']) {
    // 8-decimal asset: asset units per sat equals USD per BTC.
    const scale = 10 ** (8 - this.config.asset.decimals);
    return (side === SELL_BTC ? Number(q.rateNum) / Number(q.rateDen) : Number(q.rateDen) / Number(q.rateNum)) * scale;
  }

  book(): BookSnapshot {
    const asks: BookEntry[] = [], bids: BookEntry[] = [];
    for (const st of this.offers.values()) {
      if (!st.coin) continue;
      for (const side of [SELL_BTC, SELL_ASSET] as const) {
        const q = st.quotes[side];
        if (!q || q.quote.expiry <= BigInt(now() + QUOTE_MARGIN)) continue;
        const bal = side === SELL_BTC ? BigInt(st.coin.value) : BigInt(st.coin.assets?.find(a => a.assetId === this.config.asset.id)?.amount ?? 0);
        const available = bal - q.quote.floor;
        if (available <= 0n) continue;
        (side === SELL_BTC ? asks : bids).push({
          maker: hex(st.offer.maker), epoch: String(st.offer.epoch), address: st.offer.address, side,
          rateNum: String(q.quote.rateNum), rateDen: String(q.quote.rateDen), price: this.price(side, q.quote),
          available: String(available), minFill: String(q.quote.minFill), expiry: String(q.quote.expiry), outpoint: `${st.coin.txid}:${st.coin.vout}`,
        });
      }
    }
    asks.sort((a, b) => a.price - b.price); bids.sort((a, b) => b.price - a.price);
    return { asset: this.config.asset.id, asks, bids, updatedAt: Date.now() };
  }
  private bookChanged() { this.emit('book'); }

  /** Live quotes for a maker side, best for the user (most buy units per unit sold, den/num) first. */
  private candidates(side: Side) {
    const out: { st: OfferState; q: SignedQuote }[] = [];
    for (const st of this.offers.values()) {
      const q = st.quotes[side];
      if (q && st.coin && q.quote.expiry > BigInt(now() + QUOTE_MARGIN)) out.push({ st, q });
    }
    return out.sort((a, b) => (b.q.quote.rateDen * a.q.quote.rateNum > a.q.quote.rateDen * b.q.quote.rateNum ? 1 : -1));
  }

  // ------------------------------------------------------------------ swaps

  private terms(req: CreateSwapRequest, q: SignedQuote, receive: Uint8Array, refund: Uint8Array, refundPubkey: Uint8Array): SwapTerms {
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new HttpError(400, 'amount must be positive');
    if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 500) throw new HttpError(400, 'slippageBps must be 0..500');
    const sellBtc = req.sell === 'BTC';
    return {
      receive, refund, feeScript: this.feeScript, sell: sellBtc ? BTC : this.config.asset.id, buy: sellBtc ? this.config.asset.id : BTC,
      rate: minRateFor(q.quote, this.config.feeBps, BigInt(req.slippageBps)), feeBps: this.config.feeBps,
      deadline: BigInt(now() + this.config.swapTtl), refundPubkey, dust: this.chain.dust, exitDelay: this.config.swapExitSeconds,
      ...(req.mode === 'exactOut' ? { exactOut: amount } : {}),
    };
  }

  /** Deposit, expected and minimum outcome for terms at quote `q`. */
  private outlook(req: CreateSwapRequest, terms: SwapTerms, q: SignedQuote) {
    const D = this.chain.dust, id = this.config.asset.id, amount = BigInt(req.amount), sellBtc = terms.sell === BTC;
    let c: ReturnType<typeof constants>;
    try { c = constants(terms); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const deposit: SwapView['deposit'] = sellBtc
      ? { sats: String(req.mode === 'exactIn' ? amount : D + c.maxSpend!) }
      : { sats: String(D), asset: { id, amount: String(req.mode === 'exactIn' ? amount : c.maxSpend!) } };
    if (sellBtc && BigInt(deposit.sats) <= D) throw new HttpError(400, `send more than ${D} sats (dust)`);
    const swap = swapCovenant(this.chain, terms);
    const coin: Coin = { txid: '00'.repeat(32), vout: 0, value: Number(deposit.sats), ...(deposit.asset ? { assets: [{ assetId: id, amount: deposit.asset.amount }] } : {}) };
    let expected = { sats: '0', asset: '0' };
    try {
      const a = allocate({ swap, coin }, q, id);
      expected = sellBtc
        ? { asset: String(a.receive.assets?.[0]?.amount ?? 0n), sats: String(a.refund?.amount ?? 0n) }
        : { sats: String(a.receive.amount - BigInt(coin.value) + (a.refund ? D : 0n)), asset: String(a.refund?.assets?.[0]?.amount ?? 0n) };
    } catch (e) { if (!(e instanceof NotFillable)) throw e; throw new HttpError(409, `not fillable at the current quote: ${e.message}`); }
    const { num, den } = terms.rate, ceil = (x: bigint) => (x * num + den - 1n) / den;
    const minimum = terms.exactOut !== undefined
      ? (sellBtc ? { asset: String(terms.exactOut), sats: '0' } : { sats: String(terms.exactOut), asset: '0' })
      : (sellBtc ? { asset: String(ceil(BigInt(deposit.sats) - D)), sats: '0' } : { sats: String(ceil(amount)), asset: '0' });
    return { swap, deposit, expected, minimum };
  }

  private bestQuote(req: CreateSwapRequest) {
    const side = req.sell === 'BTC' ? SELL_ASSET : SELL_BTC;
    const best = this.candidates(side)[0];
    if (!best) throw new HttpError(503, 'no maker liquidity');
    return best;
  }

  private address(a: string, what: string) {
    try {
      const addr = ArkAddress.decode(a);
      if (addr.hrp !== this.chain.hrp) throw new Error(`expected a ${this.chain.hrp} address`);
      if (hex(addr.serverPubKey) !== hex(this.chain.server)) throw new Error('address is for another Ark server');
      return addr.pkScript;
    } catch (e) { throw new HttpError(400, `${what}: ${(e as Error).message}`); }
  }

  preview(req: CreateSwapRequest) {
    const best = this.bestQuote(req);
    const dummy = this.feeScript, key = new Uint8Array(32).fill(1);
    const receive = req.receiveAddress ? this.address(req.receiveAddress, 'receive address') : dummy;
    const refund = req.refundAddress ? this.address(req.refundAddress, 'refund address') : dummy;
    const terms = this.terms(req, best.q, receive, refund, req.refundPubkey ? unhex(req.refundPubkey) : key);
    const { deposit, expected, minimum } = this.outlook(req, terms, best.q);
    return { deposit, expected, minimum, makerPrice: this.price(best.q.quote.side, best.q.quote) };
  }

  createSwap(req: CreateSwapRequest): SwapView {
    if (req.sell !== 'BTC' && req.sell !== 'ASSET') throw new HttpError(400, 'sell must be BTC or ASSET');
    if (req.mode !== 'exactIn' && req.mode !== 'exactOut') throw new HttpError(400, 'mode must be exactIn or exactOut');
    if (!/^[0-9a-f]{64}$/.test(req.refundPubkey ?? '')) throw new HttpError(400, 'refundPubkey must be x-only hex');
    const best = this.bestQuote(req);
    const terms = this.terms(req, best.q, this.address(req.receiveAddress, 'receive address'), this.address(req.refundAddress, 'refund address'), unhex(req.refundPubkey));
    const { swap, deposit, expected, minimum } = this.outlook(req, terms, best.q);
    const rec: SwapRecord = { id: randomUUID(), swap, status: 'awaiting_deposit', createdAt: now(), deposit, expected, minimum,
      makerPrice: this.price(best.q.quote.side, best.q.quote) };
    this.swaps.set(rec.id, rec);
    this.save();
    log(`swap ${rec.id} ${req.sell}→ ${req.mode} ${req.amount} at ${rec.makerPrice.toFixed(2)}: ${swap.address}`);
    return this.view(rec);
  }

  getSwap(id: string) {
    const rec = this.swaps.get(id);
    if (!rec) throw new HttpError(404, 'unknown swap');
    return this.view(rec);
  }

  private view(r: SwapRecord): SwapView {
    return {
      id: r.id, address: r.swap.address, status: r.status, terms: termsToWire(r.swap.terms), deposit: r.deposit, expected: r.expected,
      minimum: r.minimum, makerPrice: r.makerPrice, feeBps: String(r.swap.terms.feeBps), deadline: Number(r.swap.terms.deadline), createdAt: r.createdAt,
      ...(r.coin ? { depositOutpoint: `${r.coin.txid}:${r.coin.vout}` } : {}),
      ...(r.fillTxid ? { fillTxid: r.fillTxid } : {}), ...(r.refundTxid ? { refundTxid: r.refundTxid } : {}),
      ...(r.received ? { received: r.received } : {}), ...(r.error ? { error: r.error } : {}),
    };
  }

  // ------------------------------------------------------------------ settlement loop

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.watchDeposits();
      await this.fill();
      await this.refundExpired();
    } catch (e) { log('tick failed:', (e as Error).message); }
    finally { this.ticking = false; }
  }

  private async watchDeposits() {
    const open = [...this.swaps.values()].filter(r => r.status === 'awaiting_deposit' || r.status === 'deposited' || r.status === 'refunding');
    if (!open.length) return;
    const byScript = new Map(open.map(r => [hex(r.swap.tree.pkScript), r]));
    const seen = new Map<string, VirtualCoin>();
    const scripts = [...byScript.keys()];
    for (let i = 0; i < scripts.length; i += 100) {
      const { vtxos } = await this.indexer.getVtxos({ scripts: scripts.slice(i, i + 100), spendableOnly: true });
      for (const v of vtxos) if (v.script && !seen.has(v.script)) seen.set(v.script, v);
    }
    let changed = false;
    for (const [script, r] of byScript) {
      const v = seen.get(script);
      if (r.status === 'awaiting_deposit') {
        if (v) {
          r.coin = { txid: v.txid, vout: v.vout, value: v.value, ...(v.assets ? { assets: v.assets } : {}) };
          r.status = 'deposited'; changed = true;
          log(`swap ${r.id} deposited ${v.value} sats${v.assets?.length ? ` + ${v.assets.map(a => `${a.amount} ${a.assetId.slice(0, 8)}`)}` : ''}`);
        } else if (now() > Number(r.swap.terms.deadline)) { r.status = 'expired'; changed = true; }
      } else if (!v && r.coin) {
        // Spent by someone else: the user's refund-key leaf.
        r.status = 'refunded'; r.error = 'deposit spent outside Striker (refund key)'; changed = true;
      }
    }
    if (changed) this.save();
  }

  private async fill() {
    const t = now();
    const ready = [...this.swaps.values()].filter(r => r.status === 'deposited' && r.coin && t < Number(r.swap.terms.deadline) - DEADLINE_MARGIN);
    for (const side of [SELL_ASSET, SELL_BTC] as const) {
      let pending = ready.filter(r => (r.swap.terms.sell === BTC ? SELL_ASSET : SELL_BTC) === side);
      for (const { st, q } of this.candidates(side)) {
        if (!pending.length) break;
        if (st.renewing) continue;
        if (st.stale) await this.refreshOffer(st);
        if (!st.coin) continue;
        const { settlement, skipped } = planSettlement(pending.map(r => ({ swap: r.swap, coin: r.coin! })), { offer: st.offer, coin: st.coin, quote: q },
          this.feeScript, this.chain.dust);
        for (const s of skipped) {
          const r = pending.find(p => p.swap === s.order.swap)!;
          if (r.error !== s.reason) { r.error = s.reason; log(`swap ${r.id} not fillable against ${st.offer.address.slice(0, 16)}…: ${s.reason}`); }
        }
        if (!settlement) continue;
        try {
          const built = await buildTx(this.chain, settlement.inputs, settlement.outputs);
          const started = Date.now();
          const { txid } = await submitViaEmulator(this.emulator, this.indexer, built);
          const s = settlement.filled.length;
          st.coin = { txid, vout: s, value: Number(settlement.makerChange.amount),
            assets: (settlement.makerChange.assets ?? []).map(a => ({ assetId: a.assetId, amount: String(a.amount) })) };
          for (const f of settlement.filled) {
            const r = pending.find(p => p.swap === f.swap)!;
            const a = f.allocation, D = this.chain.dust;
            r.status = 'filled'; r.fillTxid = txid; delete r.error;
            r.received = r.swap.terms.sell === BTC
              ? { asset: String(a.receive.assets?.[0]?.amount ?? 0n), sats: String(a.refund?.amount ?? 0n) }
              : { sats: String(a.receive.amount - BigInt(r.coin!.value) + (a.refund ? D : 0n)), asset: String(a.refund?.assets?.[0]?.amount ?? 0n) };
          }
          log(`filled ${s} swap(s) against ${st.offer.address.slice(0, 16)}… in ${txid} (${Date.now() - started} ms, fee ${settlement.fee})`);
          pending = pending.filter(p => p.status !== 'filled');
          this.save(); this.bookChanged();
        } catch (e) {
          log(`fill against ${st.offer.address.slice(0, 16)}… failed: ${(e as Error).message.slice(0, 300)}`);
          st.stale = true;
          for (const f of settlement.filled) { const r = pending.find(p => p.swap === f.swap)!; r.error = (e as Error).message.slice(0, 300); }
        }
      }
    }
  }

  private async refundExpired() {
    const t = now();
    // The emulator clock judges the deadline: wait a little past it.
    for (const r of this.swaps.values()) {
      if (!((r.status === 'deposited' || r.status === 'refunding') && r.coin && t > Number(r.swap.terms.deadline) + 2)) continue;
      r.status = 'refunding';
      try {
        const { input, output } = refundInput(r.swap, r.coin);
        const { txid } = await submitViaEmulator(this.emulator, this.indexer, await buildTx(this.chain, [input], [output]));
        r.status = 'refunded'; r.refundTxid = txid; delete r.error;
        log(`swap ${r.id} refunded in ${txid}`);
      } catch (e) { r.error = (e as Error).message.slice(0, 300); log(`refund of ${r.id} failed: ${r.error}`); }
      this.save();
    }
  }

  // ------------------------------------------------------------------ persistence (prototype: one JSON file)

  private get file() { return path.join(this.config.dataDir, 'swaps.json'); }
  private save() {
    const rows = [...this.swaps.values()].map(r => ({ ...r, swap: termsToWire(r.swap.terms), coin: r.coin && { ...r.coin, assets: r.coin.assets?.map(a => ({ ...a, amount: String(a.amount) })) } }));
    writeFileSync(this.file, JSON.stringify(rows, null, 1));
  }
  private load() {
    if (!existsSync(this.file)) return;
    for (const row of JSON.parse(readFileSync(this.file, 'utf8'))) {
      this.swaps.set(row.id, { ...row, swap: swapCovenant(this.chain, termsFromWire(row.swap)) });
    }
    log(`loaded ${this.swaps.size} swaps`);
  }
}
