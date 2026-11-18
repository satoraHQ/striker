import type { InfoResponse } from '@striker/core';
import { isTerminal } from '../api';
import { useSwap } from '../hooks';
import type { SwapRecord } from '../storage';
import { fmtSats, fmtUsd } from '../units';
import { Card, short, StatusBadge } from './ui';

export function MySwaps({ swaps, activeId, onOpen, info }: {
  swaps: SwapRecord[]; activeId: string | undefined; onOpen: (id: string) => void; info: InfoResponse | undefined;
}) {
  if (!swaps.length) return null;
  return (
    <Card>
      <h2 className="mb-2 font-semibold">My swaps</h2>
      <ul className="divide-y divide-line/60">
        {swaps.map((s, i) => <Item key={s.id} rec={s} active={s.id === activeId} poll={i < 10} onOpen={onOpen} info={info} />)}
      </ul>
    </Card>
  );
}

function Item({ rec, active, poll, onOpen, info }: {
  rec: SwapRecord; active: boolean; poll: boolean; onOpen: (id: string) => void; info: InfoResponse | undefined;
}) {
  // Only the most recent unfinished swaps are polled.
  const live = poll && !(rec.lastStatus && isTerminal(rec.lastStatus));
  const q = useSwap(live ? rec.id : undefined);
  const status = q.data?.status ?? rec.lastStatus ?? 'unknown';
  const r = rec.request, ticker = info?.asset.ticker ?? 'USD';
  const amountIsBtc = (r.mode === 'exactIn') === (r.sell === 'BTC');
  const amount = amountIsBtc ? `${fmtSats(r.amount)} sats` : `$${fmtUsd(r.amount, info?.asset.decimals ?? 8)}`;
  return (
    <li>
      <button type="button" onClick={() => onOpen(rec.id)}
        className={`flex w-full items-center gap-3 py-2 text-left text-sm ${active ? 'text-white' : 'text-slate-300 hover:text-white'}`}>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {r.sell === 'BTC' ? `BTC → ${ticker}` : `${ticker} → BTC`} · {r.mode === 'exactIn' ? 'send' : 'receive'} {amount}
          </span>
          <span className="block text-[11px] text-slate-500">{new Date(rec.createdAt).toLocaleString()} · {short(rec.id, 6)}</span>
        </span>
        <StatusBadge status={status} />
      </button>
    </li>
  );
}
