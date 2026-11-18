import type { BookSnapshot, CreateSwapRequest, InfoResponse, PreviewResponse, SwapStatus, SwapView } from '@striker/core';

/** Dev and `vite preview` proxy /v1 to the server, so same-origin there; a built app talks to VITE_STRIKER_URL. */
export const BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_STRIKER_URL ?? 'http://localhost:7090').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** Network failure (server down, proxy refused, CORS). */
export class OfflineError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new OfflineError('Striker offline');
  }
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok) {
    // The dev proxy answers 5xx with a non-JSON body when the server is down.
    if (body === undefined && res.status >= 500) throw new OfflineError('Striker offline');
    const msg = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  // Anything but JSON (a proxy page, a different server) means Striker isn't what answered.
  if (body === undefined || typeof body !== 'object') throw new OfflineError('Striker offline');
  return body as T;
}

export type SwapPreview = PreviewResponse;

export const api = {
  info: () => call<InfoResponse>('/v1/info'),
  book: () => call<BookSnapshot>('/v1/book'),
  swap: (id: string) => call<SwapView>(`/v1/swaps/${encodeURIComponent(id)}`),
  createSwap: (req: CreateSwapRequest) => call<SwapView>('/v1/swaps', { method: 'POST', body: JSON.stringify(req) }),
  preview: (req: CreateSwapRequest, signal?: AbortSignal) =>
    call<SwapPreview>('/v1/swaps/preview', { method: 'POST', body: JSON.stringify(req), signal }),
};

export const bookStreamUrl = () => `${BASE}/v1/book/stream`;

export const TERMINAL: ReadonlySet<SwapStatus> = new Set(['filled', 'refunded', 'expired', 'failed']);
export const isTerminal = (s: SwapStatus) => TERMINAL.has(s);
