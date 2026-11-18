import { useEffect, useState } from 'react';
import { OrderBook } from './components/OrderBook';
import { MySwaps } from './components/MySwaps';
import { SwapForm } from './components/SwapForm';
import { SwapPanel } from './components/SwapPanel';
import { midPrice, useBook, useInfo } from './hooks';
import { loadSwaps, type SwapRecord } from './storage';
import { fmtPrice } from './units';

const hashId = () => /^#\/swap\/(.+)$/.exec(window.location.hash)?.[1];

export function App() {
  const info = useInfo();
  const offline = info.isError && !info.data;
  const book = useBook(!!info.data);
  const [swaps, setSwaps] = useState<SwapRecord[]>(loadSwaps);
  const [activeId, setActiveId] = useState<string | undefined>(hashId);

  useEffect(() => {
    const onHash = () => { setActiveId(hashId()); setSwaps(loadSwaps()); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Pick up statuses the pollers wrote to storage.
  useEffect(() => { const t = setInterval(() => setSwaps(loadSwaps()), 5000); return () => clearInterval(t); }, []);

  const open = (id: string | undefined) => {
    window.location.hash = id ? `#/swap/${id}` : '';
    setActiveId(id);
    setSwaps(loadSwaps());
  };
  const active = swaps.find((s) => s.id === activeId);
  const mid = midPrice(book.data);
  const decimals = info.data?.asset.decimals ?? 8, ticker = info.data?.asset.ticker ?? 'USD';

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-8" />
        <h1 className="text-xl font-bold tracking-tight">Striker</h1>
        {info.data && <span className="rounded-full border border-line px-2 py-0.5 text-xs text-slate-300">{info.data.network}</span>}
        <div className="ml-auto text-right">
          {mid !== undefined ? (
            <>
              <div className="text-sm font-semibold tabular-nums">${fmtPrice(mid)}</div>
              <div className="text-[11px] text-slate-500">BTC/{ticker} mid</div>
            </>
          ) : !offline && info.data ? <div className="text-xs text-slate-500">no quotes</div> : null}
        </div>
      </header>

      {offline && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          Striker offline: can't reach the server. Retrying…
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-4">
          {activeId && active ? (
            <SwapPanel key={active.id} record={active} info={info.data} onClose={() => open(undefined)} />
          ) : (
            <>
              {activeId && <p className="rounded-xl bg-white/5 px-3 py-2 text-sm text-slate-400">Swap {activeId} isn't stored in this browser.</p>}
              <SwapForm info={info.data} book={book.data} onCreated={(id) => open(id)} />
            </>
          )}
        </div>
        <div className="space-y-4">
          <OrderBook book={book.data} live={book.live} decimals={decimals} ticker={ticker} offline={offline} />
          <MySwaps swaps={swaps} activeId={activeId} onOpen={open} info={info.data} />
        </div>
      </div>
    </div>
  );
}
