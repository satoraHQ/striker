import type { CreateSwapRequest, SwapStatus } from '@striker/core';

/** What the browser remembers about a swap it created: enough to re-verify the address later. */
export interface SwapRecord {
  id: string;
  createdAt: number;
  request: CreateSwapRequest;
  lastStatus?: SwapStatus;
}

const LIST = 'striker:swaps';
const KEY = (id: string) => `striker:refundKey:${id}`;

function read<T>(k: string, fallback: T): T {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(k: string, v: unknown): boolean {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
}

export const loadSwaps = (): SwapRecord[] => read<SwapRecord[]>(LIST, []);

export function saveSwap(rec: SwapRecord): boolean {
  const all = loadSwaps().filter((s) => s.id !== rec.id);
  return write(LIST, [rec, ...all].slice(0, 100));
}

export function updateSwapStatus(id: string, status: SwapStatus) {
  const all = loadSwaps();
  const r = all.find((s) => s.id === id);
  if (r && r.lastStatus !== status) { r.lastStatus = status; write(LIST, all); }
}

export const saveRefundKey = (id: string, secretHex: string) => write(KEY(id), secretHex);
export const loadRefundKey = (id: string): string | null => read<string | null>(KEY(id), null);
