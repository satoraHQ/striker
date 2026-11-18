// BTC/USD reference price: Binance first, Kraken and Coinbase as fallbacks (mid of best bid/ask).
// FIXED_PRICE overrides the feeds (regtest, offline demos).

type Source = { name: string; fetch: () => Promise<number> };
const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000), headers: { 'user-agent': 'striker-maker' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<any>;
};
const mid = (bid: unknown, ask: unknown) => {
  const b = Number(bid), a = Number(ask);
  if (!(b > 0 && a > 0 && a >= b)) throw new Error('bad ticker');
  return (a + b) / 2;
};

export const sources: Source[] = [
  { name: 'binance', fetch: async () => { const t = await get('https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT'); return mid(t.bidPrice, t.askPrice); } },
  { name: 'kraken', fetch: async () => { const t = await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'); const r = Object.values(t.result ?? {})[0] as any; return mid(r?.b?.[0], r?.a?.[0]); } },
  { name: 'coinbase', fetch: async () => { const t = await get('https://api.exchange.coinbase.com/products/BTC-USD/ticker'); return mid(t.bid, t.ask); } },
];

export async function referencePrice(): Promise<{ price: number; source: string }> {
  if (process.env.FIXED_PRICE) return { price: Number(process.env.FIXED_PRICE), source: 'fixed' };
  const errors: string[] = [];
  for (const s of sources) {
    try { return { price: await s.fetch(), source: s.name }; }
    catch (e) { errors.push(`${s.name}: ${(e as Error).message}`); }
  }
  throw new Error(`no price: ${errors.join('; ')}`);
}
