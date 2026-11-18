import { useState } from 'react';
import type { BookEntry, BookSnapshot } from '@striker/core';
import { useNow } from '../hooks';
import { fmtCountdown, fmtPrice, fmtSats, fmtUsd, toMs } from '../units';
import { Card } from './ui';

export function OrderBook({ book, live, decimals, ticker, offline }: {
  book: BookSnapshot | undefined; live: boolean; decimals: number; ticker: string; offline: boolean;
}) {
  // Collapsed by default on phones, open on wider screens.
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  const now = useNow();
  const ago = book ? Math.max(0, Math.round((now - toMs(book.updatedAt)) / 1000)) : 0;
  return (
    <Card>
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="flex cursor-pointer list-none items-center justify-between">
          <h2 className="font-semibold">Order book</h2>
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`size-2 rounded-full ${live ? 'bg-emerald-400' : offline ? 'bg-red-400' : 'bg-slate-500'}`} />
            {live ? 'live' : offline ? 'offline' : 'polling'}
            <span className="text-slate-500">{open ? '▴' : '▾'}</span>
          </span>
        </summary>
        <div className="mt-3 space-y-4">
          <Side title="Asks · makers sell BTC" tone="text-red-300" entries={book?.asks} now={now}
            size={(e) => `${fmtSats(e.available)} sats`} />
          <Side title={`Bids · makers sell ${ticker}`} tone="text-emerald-300" entries={book?.bids} now={now}
            size={(e) => `$${fmtUsd(e.available, decimals)}`} />
          {book && <p className="text-right text-[11px] text-slate-500">updated {ago < 2 ? 'just now' : `${ago}s ago`}</p>}
        </div>
      </details>
    </Card>
  );
}

function Side({ title, tone, entries, now, size }: {
  title: string; tone: string; entries: BookEntry[] | undefined; now: number; size: (e: BookEntry) => string;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-400">{title}</h3>
      {!entries?.length ? <p className="py-2 text-sm text-slate-500">No quotes</p> : (
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="font-normal">Price</th>
              <th className="text-right font-normal">Available</th>
              <th className="text-right font-normal">Expires</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.outpoint}:${e.side}:${e.rateNum}/${e.rateDen}`} className="border-t border-line/50">
                <td className={`py-1 ${tone}`}>${fmtPrice(e.price)}</td>
                <td className="py-1 text-right">{size(e)}</td>
                <td className="py-1 text-right text-slate-400">{fmtCountdown(toMs(e.expiry) - now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
