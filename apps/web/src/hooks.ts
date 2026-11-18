import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BookSnapshot, CreateSwapRequest } from '@striker/core';
import { api, bookStreamUrl, isTerminal } from './api';
import { updateSwapStatus } from './storage';

export function useInfo() {
  return useQuery({
    queryKey: ['info'],
    queryFn: api.info,
    staleTime: 60_000,
    retry: false,
    // Keep probing while offline so the page recovers on its own.
    refetchInterval: (q) => (q.state.status === 'error' ? 5_000 : false),
  });
}

/** Book snapshot from GET /v1/book, then kept live by the SSE stream. */
export function useBook(enabled: boolean) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const query = useQuery({ queryKey: ['book'], queryFn: api.book, enabled, retry: false, refetchInterval: live ? false : 10_000 });
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource(bookStreamUrl());
    es.addEventListener('book', (e) => {
      try { qc.setQueryData<BookSnapshot>(['book'], JSON.parse((e as MessageEvent<string>).data)); setLive(true); } catch { /* ignore */ }
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [enabled, qc]);
  return { ...query, live };
}

export function midPrice(book?: BookSnapshot): number | undefined {
  const ask = book?.asks[0]?.price, bid = book?.bids[0]?.price;
  if (ask !== undefined && bid !== undefined) return (ask + bid) / 2;
  return ask ?? bid;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Live estimate as the user types; `req` null disables it. */
export function usePreview(req: CreateSwapRequest | null) {
  const debounced = useDebounced(req, 350);
  return useQuery({
    queryKey: ['preview', debounced],
    queryFn: ({ signal }) => api.preview(debounced!, signal),
    enabled: debounced !== null,
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}

/** Poll a swap every second until it reaches a terminal status. */
export function useSwap(id: string | undefined) {
  return useQuery({
    queryKey: ['swap', id],
    queryFn: async () => {
      const v = await api.swap(id!);
      updateSwapStatus(v.id, v.status);
      return v;
    },
    enabled: !!id,
    retry: 2,
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1000),
  });
}
