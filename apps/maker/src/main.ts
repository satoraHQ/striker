// Maker bot: keeps one offer covenant VTXO funded (sats + the asset) and re-signs quotes on both
// sides around a reference price every few seconds (DESIGN.md §3, §4).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  EsploraProvider, InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider, RestIndexerProvider, SingleKey, Wallet,
} from '@arkade-os/sdk';
import {
  buildTx, fetchChainParams, hex, OFFER_LEAF, offerCovenant, quoteToWire, reduce, SELL_ASSET, SELL_BTC, signQuote, submitViaArkd, unhex,
  type InfoResponse, type PublishQuotesRequest, type Quote,
} from '@striker/core';
import { referencePrice } from './price.js';

const env = (n: string, d: string) => process.env[n] ?? d;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const strikerUrl = env('STRIKER_URL', 'http://localhost:7090');
const arkUrl = env('ARK_URL', 'http://localhost:7070');
const dataDir = path.resolve(env('MAKER_DATA', '.maker'));
const spreadBps = Number(env('SPREAD_BPS', '50'));
const quoteTtl = BigInt(env('QUOTE_TTL', '30'));
const requoteMs = Number(env('REQUOTE_MS', '3000'));
const epoch = BigInt(env('EPOCH', '0'));
/** Funding of the offer VTXO when the maker starts with none. */
const fundSats = BigInt(env('OFFER_SATS', '1000000'));
const fundAsset = BigInt(env('OFFER_ASSET', String(1_000n * 100_000_000n)));

function secret() {
  if (process.env.MAKER_SECRET) return unhex(process.env.MAKER_SECRET);
  const file = path.join(dataDir, 'secret');
  if (!existsSync(file)) { mkdirSync(dataDir, { recursive: true }); writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 }); }
  return unhex(readFileSync(file, 'utf8').trim());
}

const info = await (await fetch(`${strikerUrl}/v1/info`)).json() as InfoResponse;
const chain = await fetchChainParams(arkUrl, process.env.EMULATOR_KEY);
if (hex(chain.server) !== info.serverKey) throw new Error('Striker runs against another Ark server');
const key = secret();
const identity = SingleKey.fromPrivateKey(key);
const maker = await identity.xOnlyPublicKey();
const ark = new RestArkProvider(arkUrl), indexer = new RestIndexerProvider(arkUrl);
const wallet = await Wallet.create({
  identity, arkProvider: ark, onchainProvider: new EsploraProvider(env('ESPLORA_URL', 'http://localhost:3000/api'), { forcePolling: true, pollingInterval: 10_000 }),
  storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() }, settlementConfig: false,
});
const assetId = info.asset.id, decimals = info.asset.decimals;
// The offer address depends on Striker's Renew-leaf parameters; they come from /v1/info.
const offer = offerCovenant(chain, {
  maker, epoch, asset: assetId, exitSeconds: BigInt(info.offerExitSeconds),
  renew: { cosigner: info.renew.cosigner, delegateKey: unhex(info.renew.delegateKey), window: BigInt(info.renew.window) },
});
log(`maker ${hex(maker)} wallet ${await wallet.getAddress()}`);
log(`offer ${offer.address} (epoch ${epoch})`);

const coins = async () => (await indexer.getVtxos({ scripts: [hex(offer.tree.pkScript)], spendableOnly: true })).vtxos;

/** One VTXO per offer (DESIGN.md §3 floor): fund it if empty, merge through the Owner leaf if split. */
async function ensureOffer() {
  const have = await coins();
  if (have.length === 0) {
    log(`funding offer with ${fundSats} sats + ${fundAsset} ${info.asset.ticker} units`);
    await wallet.send({ address: offer.address, amount: Number(fundSats), assets: fundAsset > 0n ? [{ assetId, amount: fundAsset }] : [] });
    return;
  }
  if (have.length === 1) return;
  const sats = have.reduce((s, c) => s + BigInt(c.value), 0n);
  const totals = new Map<string, bigint>();
  for (const c of have) for (const a of c.assets ?? []) totals.set(a.assetId, (totals.get(a.assetId) ?? 0n) + BigInt(a.amount));
  const built = await buildTx(chain, have.map(c => ({ coin: c, tapTree: offer.tree.encode(), tapLeafScript: offer.tree.leaves[OFFER_LEAF.owner]!, signer: identity })),
    [{ script: offer.tree.pkScript, amount: sats, assets: [...totals].map(([id, amount]) => ({ assetId: id, amount })) }]);
  const { txid } = await submitViaArkd(ark, built);
  log(`merged ${have.length} offer VTXOs into ${txid}`);
}

const PRICE_SCALE = 10_000n;
/** USD/BTC price → quote rates for an asset with `decimals`. units per sat = price · 10^decimals / 1e8. */
function quotes(mid: number): Quote[] {
  const expiry = BigInt(Math.floor(Date.now() / 1000)) + quoteTtl;
  const ask = BigInt(Math.round(mid * (1 + spreadBps / 10_000) * Number(PRICE_SCALE)));
  const bid = BigInt(Math.round(mid * (1 - spreadBps / 10_000) * Number(PRICE_SCALE)));
  const unit = 10n ** BigInt(decimals);
  // Maker sells BTC: units ≥ sats × num / den, at the ask.
  const sellBtc = reduce({ num: ask * unit, den: PRICE_SCALE * 100_000_000n });
  // Maker sells the asset: sats ≥ units × num / den, at the bid.
  const sellAsset = reduce({ num: PRICE_SCALE * 100_000_000n, den: bid * unit });
  return [
    { side: SELL_BTC, rateNum: sellBtc.num, rateDen: sellBtc.den, floor: BigInt(info.dust), minFill: 1n, expiry },
    { side: SELL_ASSET, rateNum: sellAsset.num, rateDen: sellAsset.den, floor: 0n, minFill: 1n, expiry },
  ];
}

async function publish() {
  const { price, source } = await referencePrice();
  const body: PublishQuotesRequest = { maker: hex(maker), epoch: String(epoch), quotes: quotes(price).map(q => quoteToWire(signQuote(offer, q, key))) };
  const res = await fetch(`${strikerUrl}/v1/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`publish: ${res.status} ${await res.text()}`);
  return { price, source };
}

await ensureOffer();
let last = '';
let lastMerge = Date.now();
for (;;) {
  try {
    const { price, source } = await publish();
    const line = `${source} ${price.toFixed(2)}`;
    if (line !== last) { log(`quoting around ${line} ± ${spreadBps} bps`); last = line; }
    if (Date.now() - lastMerge > 60_000) { lastMerge = Date.now(); await ensureOffer(); }
  } catch (e) { log((e as Error).message); }
  await new Promise(r => setTimeout(r, requoteMs));
}
